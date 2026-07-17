import { describe, it, expect } from "vitest";
import { createWakeQueue } from "../src/adapter/wake-queue.js";
import type { WakeRequest, WakeResponse } from "../src/types.js";

function wake(messageId: string, conversationId = "conv_A"): WakeRequest {
	return { schema: "raft-channel-wake.v1", messageId, conversationId, senderId: "u1", contentPreview: "hi" };
}

/** A processor whose completion the test controls, recording call order. */
function controlledProcessor() {
	const calls: string[] = [];
	const settlers: Array<(r: WakeResponse) => void> = [];
	const rejecters: Array<(e: unknown) => void> = [];
	const process = (w: WakeRequest) =>
		new Promise<WakeResponse>((resolve, reject) => {
			calls.push(w.messageId);
			settlers.push(resolve);
			rejecters.push(reject);
		});
	return { calls, settlers, rejecters, process };
}

const OK: WakeResponse = { ok: true, runtimeSession: "thr_1" };
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("wake queue (P1 backpressure + concurrency)", () => {
	it("KILLING: same-conversation wakes SERIALIZE — m2 must not inject until m1 settles (two concurrent injects into one thread could each turn/start)", async () => {
		const p = controlledProcessor();
		const q = createWakeQueue(p.process);
		const r1 = q.enqueue(wake("m1"));
		const r2 = q.enqueue(wake("m2"));
		await tick();
		expect(p.calls).toEqual(["m1"]); // m2 held back while m1 is in flight
		p.settlers[0](OK);
		await r1;
		await tick();
		expect(p.calls).toEqual(["m1", "m2"]);
		p.settlers[1](OK);
		await r2;
	});

	it("different conversations run concurrently (no cross-conversation head-of-line blocking)", async () => {
		const p = controlledProcessor();
		const q = createWakeQueue(p.process);
		const r1 = q.enqueue(wake("m1", "conv_A"));
		const r2 = q.enqueue(wake("m2", "conv_B"));
		await tick();
		expect(p.calls).toEqual(["m1", "m2"]); // both started before either settled
		p.settlers.forEach((s) => s(OK));
		await Promise.all([r1, r2]);
	});

	it("KILLING: duplicate messageId while in flight COALESCES — one inject, both callers share the result", async () => {
		const p = controlledProcessor();
		const q = createWakeQueue(p.process);
		const r1 = q.enqueue(wake("m1"));
		const r2 = q.enqueue(wake("m1")); // upstream retried too early
		await tick();
		expect(p.calls).toEqual(["m1"]);
		p.settlers[0](OK);
		expect(await r1).toEqual(OK);
		expect(await r2).toEqual(OK);
		expect(p.calls).toEqual(["m1"]); // still exactly one inject
	});

	it("KILLING: re-delivery AFTER confirmed delivery is answered ok idempotently (a second inject would duplicate the message in model-visible history)", async () => {
		const p = controlledProcessor();
		const q = createWakeQueue(p.process);
		const r1 = q.enqueue(wake("m1"));
		await tick();
		p.settlers[0](OK);
		await r1;
		const again = await q.enqueue(wake("m1"));
		expect(again).toEqual({ ok: true, runtimeSession: "thr_1" }); // recorded session, no new inject
		expect(p.calls).toEqual(["m1"]);
	});

	it("KILLING: a FAILED attempt is not recorded delivered — the retry re-injects", async () => {
		const p = controlledProcessor();
		const q = createWakeQueue(p.process);
		const r1 = q.enqueue(wake("m1"));
		await tick();
		p.settlers[0]({ ok: false, failureClass: "inject_failed", retryAfterMs: 5000 });
		expect((await r1).ok).toBe(false);
		const r2 = q.enqueue(wake("m1")); // upstream retry
		await tick();
		expect(p.calls).toEqual(["m1", "m1"]); // re-injected, not answered from the LRU
		p.settlers[1](OK);
		expect((await r2).ok).toBe(true);
	});

	it("KILLING: backpressure — beyond maxQueuedPerConversation answers runtime_busy+retryAfterMs and never injects; capacity frees after drain", async () => {
		const p = controlledProcessor();
		const q = createWakeQueue(p.process, { maxQueuedPerConversation: 2 });
		const r1 = q.enqueue(wake("m1"));
		const r2 = q.enqueue(wake("m2"));
		const shed = await q.enqueue(wake("m3")); // over cap → shed immediately
		expect(shed).toEqual({ ok: false, failureClass: "runtime_busy", retryAfterMs: 2000 });
		await tick();
		expect(p.calls).toEqual(["m1"]); // m3 never reached the processor
		p.settlers[0](OK);
		await r1;
		await tick();
		p.settlers[1](OK);
		await r2;
		// Drained → the retry of m3 is accepted now.
		const r3 = q.enqueue(wake("m3"));
		await tick();
		expect(p.calls).toEqual(["m1", "m2", "m3"]);
		p.settlers[2](OK);
		expect((await r3).ok).toBe(true);
	});

	it("KILLING: a THROWING processor is contained as a classified failure and does not wedge the conversation's FIFO", async () => {
		const p = controlledProcessor();
		const q = createWakeQueue(p.process);
		const r1 = q.enqueue(wake("m1"));
		const r2 = q.enqueue(wake("m2"));
		await tick();
		p.rejecters[0](new Error("thread/start failed: kaboom"));
		const res1 = await r1;
		expect(res1).toEqual({ ok: false, failureClass: "runtime_error", retryAfterMs: 15_000 });
		await tick();
		expect(p.calls).toEqual(["m1", "m2"]); // m2 still ran after m1's throw
		p.settlers[1](OK);
		expect((await r2).ok).toBe(true);
	});

	it("a 401-throwing processor maps to TERMINAL runtime_error (no retryAfterMs — upstream must not loop on a bad key)", async () => {
		const p = controlledProcessor();
		const q = createWakeQueue(p.process);
		const r1 = q.enqueue(wake("m1"));
		await tick();
		p.rejecters[0](new Error("401 Unauthorized"));
		expect(await r1).toEqual({ ok: false, failureClass: "runtime_error" }); // exactly: no retryAfterMs key
	});

	it("delivered-LRU evicts oldest at capacity — an evicted id re-injects instead of answering stale-idempotent", async () => {
		const p = controlledProcessor();
		const q = createWakeQueue(p.process, { recentDeliveredCapacity: 2 });
		for (const id of ["m1", "m2", "m3"]) {
			const r = q.enqueue(wake(id));
			await tick();
			p.settlers[p.settlers.length - 1](OK);
			await r;
		}
		// m1 was evicted (capacity 2 holds m2,m3) → re-delivery of m1 re-injects.
		const r = q.enqueue(wake("m1"));
		await tick();
		expect(p.calls).toEqual(["m1", "m2", "m3", "m1"]);
		p.settlers[3](OK);
		await r;
		// Recording m1 again evicted m2; m3 is still resident → idempotent, no inject.
		expect((await q.enqueue(wake("m3"))).ok).toBe(true);
		expect(p.calls).toEqual(["m1", "m2", "m3", "m1"]);
	});

	it("depth() accounts in-flight + waiting and returns to 0 after drain", async () => {
		const p = controlledProcessor();
		const q = createWakeQueue(p.process);
		expect(q.depth("conv_A")).toBe(0);
		const r1 = q.enqueue(wake("m1"));
		const r2 = q.enqueue(wake("m2"));
		expect(q.depth("conv_A")).toBe(2);
		await tick();
		p.settlers[0](OK);
		await r1;
		expect(q.depth("conv_A")).toBe(1);
		await tick();
		p.settlers[1](OK);
		await r2;
		expect(q.depth("conv_A")).toBe(0);
	});
});
