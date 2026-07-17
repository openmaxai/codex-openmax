import { describe, it, expect } from "vitest";
import { startAdapterServer } from "../src/adapter/server.js";
import { createMockCwsBridge } from "../src/bridge/cws-bridge.js";
import type { SendRequest, WakeRequest, WakeResponse } from "../src/types.js";

const WAKE: WakeRequest = {
	schema: "raft-channel-wake.v1",
	messageId: "m1",
	conversationId: "conv_A",
	senderId: "u1",
	contentPreview: "hello",
};

async function withServer(
	deps: Parameters<typeof startAdapterServer>[0],
	fn: (base: string) => Promise<void>,
): Promise<void> {
	const h = await startAdapterServer(deps, 0);
	try {
		await fn(`http://127.0.0.1:${h.port}`);
	} finally {
		await h.close();
	}
}

describe("adapter HTTP server (P1 MVP)", () => {
	it("POST /wake routes to handleWake and returns its WakeResponse (ok:true)", async () => {
		let seen: WakeRequest | null = null;
		await withServer(
			{
				handleWake: async (w) => {
					seen = w;
					return { ok: true, runtimeSession: "thr_1" };
				},
				handleSend: async () => ({ ok: true, messageId: "x" }),
			},
			async (base) => {
				const res = await fetch(`${base}/wake`, { method: "POST", body: JSON.stringify(WAKE) });
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ ok: true, runtimeSession: "thr_1" });
				expect(seen).toEqual(WAKE);
			},
		);
	});

	it("KILLING: /wake returns HTTP 200 even when delivery fails (ok:false) — non-2xx would trip caller retry", async () => {
		await withServer(
			{
				handleWake: async (): Promise<WakeResponse> => ({ ok: false, failureClass: "inject_failed", retryAfterMs: 5000 }),
				handleSend: async () => ({ ok: true, messageId: "x" }),
			},
			async (base) => {
				const res = await fetch(`${base}/wake`, { method: "POST", body: JSON.stringify(WAKE) });
				expect(res.status).toBe(200); // typed failure, not a transport error
				expect(await res.json()).toEqual({ ok: false, failureClass: "inject_failed", retryAfterMs: 5000 });
			},
		);
	});

	it("a throwing handleWake is contained as ok:false runtime_error (200)", async () => {
		await withServer(
			{
				handleWake: async () => {
					throw new Error("boom");
				},
				handleSend: async () => ({ ok: true, messageId: "x" }),
			},
			async (base) => {
				const res = await fetch(`${base}/wake`, { method: "POST", body: JSON.stringify(WAKE) });
				expect(res.status).toBe(200);
				expect((await res.json()).ok).toBe(false);
			},
		);
	});

	it("malformed body → 400; unknown path → 404; GET → 405", async () => {
		await withServer(
			{ handleWake: async () => ({ ok: true }), handleSend: async () => ({ ok: true, messageId: "x" }) },
			async (base) => {
				expect((await fetch(`${base}/wake`, { method: "POST", body: "{" })).status).toBe(400);
				expect((await fetch(`${base}/wake`, { method: "POST", body: JSON.stringify({ nope: 1 }) })).status).toBe(400);
				expect((await fetch(`${base}/nope`, { method: "POST", body: "{}" })).status).toBe(404);
				expect((await fetch(`${base}/wake`, { method: "GET" })).status).toBe(405);
			},
		);
	});

	it("bidirectional round-trip: bridge inbound → /wake → inject; runtime output → /send → bridge.send → CWS", async () => {
		const bridge = createMockCwsBridge();
		await bridge.start();
		const injected: WakeRequest[] = [];

		await withServer(
			{
				handleWake: async (w) => {
					injected.push(w);
					return { ok: true, runtimeSession: "thr_1" };
				},
				handleSend: async (req: SendRequest) => {
					const r = await bridge.send(req);
					return r.ok && r.messageId ? { ok: true, messageId: r.messageId } : { ok: false, failureClass: "runtime_error" };
				},
			},
			async (base) => {
				// Inbound: bridge delivers a CWS message → /wake.
				bridge.onInbound(async (w) => {
					const res = await fetch(`${base}/wake`, { method: "POST", body: JSON.stringify(w) });
					const body = (await res.json()) as WakeResponse;
					expect(body.ok).toBe(true);
					return body; // deliver() fidelity: the wake result flows back to the bridge
				});
				await bridge.simulateInbound(WAKE);
				expect(injected).toEqual([WAKE]);

				// Outbound: runtime reply → /send → bridge records it, returns a platform id.
				const out: SendRequest = { conversationId: "conv_A", content: "PONG" };
				const res = await fetch(`${base}/send`, { method: "POST", body: JSON.stringify(out) });
				const body = await res.json();
				expect(body.ok).toBe(true);
				expect(body.messageId).toMatch(/^mock_msg_/);
				expect(bridge.sent).toEqual([out]);
			},
		);
		await bridge.stop();
	});
});
