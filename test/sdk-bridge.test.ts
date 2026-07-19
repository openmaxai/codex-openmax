import { describe, it, expect } from "vitest";
import { createSdkCwsBridge, toWakeRequest, type SdkAgentBridge, type SdkInboundMessage } from "../src/bridge/sdk-bridge.js";
import type { WakeResponse } from "../src/types.js";

function msg(over: Partial<SdkInboundMessage> = {}): SdkInboundMessage {
	return {
		orgId: "org_1",
		conversationId: "conv_A",
		messageId: "m1",
		senderId: "u1",
		text: "hello",
		endpoint: "conv_A",
		...over,
	};
}

/** Fake SDK bridge recording sends; makeBridge captures the deliver fn for the test to drive. */
function harness(sendImpl?: (endpoint: string, content: string, opts?: object) => Promise<unknown>) {
	const sends: Array<{ endpoint: string; content: string; opts?: { orgId?: string; replyTo?: string } }> = [];
	let deliver!: Parameters<typeof createSdkCwsBridge>[0] extends (d: infer D) => SdkAgentBridge ? D : never;
	const bridge = createSdkCwsBridge((d) => {
		deliver = d;
		return {
			start: async () => {},
			stop: async () => {},
			send: async (endpoint, content, opts) => {
				sends.push({ endpoint, content, opts });
				return sendImpl ? sendImpl(endpoint, content, opts) : { messageId: "cws_9" };
			},
		};
	});
	return { bridge, sends, deliver: (m: SdkInboundMessage, endpoint = m.endpoint) => deliver(m, endpoint) };
}

const OK: WakeResponse = { ok: true, runtimeSession: "thr_1" };

describe("sdk-bridge: InboundMessage → WakeRequest mapping", () => {
	it("maps the contract fields; schema is the pinned const", () => {
		expect(toWakeRequest(msg())).toEqual({
			schema: "raft-channel-wake.v1",
			messageId: "m1",
			conversationId: "conv_A",
			senderId: "u1",
			contentPreview: "hello",
		});
	});

	it("unresolved sender (senderId absent per inbound-message.schema.json) is OMITTED on the wire — sender-less wake is legal (SDK fixture 04)", () => {
		const wake = toWakeRequest(msg({ senderId: undefined }));
		expect("senderId" in wake).toBe(false);
	});

	it("contentPreview is capped (short, non-authoritative per the schema)", () => {
		const long = "x".repeat(2000);
		const preview = toWakeRequest(msg({ text: long })).contentPreview;
		expect(preview.length).toBe(480);
		expect(long.startsWith(preview)).toBe(true);
	});
});

describe("sdk-bridge: deliver() result fidelity (wake-result invariant)", () => {
	it("KILLING: deliver resolves with the handler's WakeResponse VERBATIM — ok:false is never upgraded", async () => {
		const { bridge, deliver } = harness();
		bridge.onInbound(async () => ({ ok: false, failureClass: "wake_failed", retryAfterMs: 5000 }));
		const res = await deliver(msg());
		expect(res).toEqual({ ok: false, failureClass: "wake_failed", retryAfterMs: 5000 });
	});

	it("KILLING: no inbound handler wired → typed retryable failure, NEVER ok (a fabricated ok commits SDK markers and loses the message)", async () => {
		const { deliver } = harness();
		const res = await deliver(msg());
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.retryAfterMs).toBeGreaterThan(0);
	});

	it("KILLING: a throwing handler is contained as a typed failure, not a rejection into the SDK", async () => {
		const { bridge, deliver } = harness();
		bridge.onInbound(async () => {
			throw new Error("wake path exploded");
		});
		const res = await deliver(msg());
		expect(res).toEqual({ ok: false, failureClass: "wake_failed", retryAfterMs: 15_000 });
	});

	it("ok:true passes through with the runtime session", async () => {
		const { bridge, deliver } = harness();
		bridge.onInbound(async () => OK);
		expect(await deliver(msg())).toEqual(OK);
	});
});

describe("sdk-bridge: outbound routing (conversationId → endpoint/orgId registry)", () => {
	it("send uses the endpoint + orgId captured from the conversation's inbound delivery", async () => {
		const { bridge, sends, deliver } = harness();
		bridge.onInbound(async () => OK);
		await deliver(msg({ endpoint: "conv_A|thread:t1" }), "conv_A|thread:t1");
		const res = await bridge.send({ conversationId: "conv_A", content: "PONG", replyTo: "m1" });
		expect(res).toEqual({ ok: true, messageId: "cws_9" });
		expect(sends).toEqual([{ endpoint: "conv_A|thread:t1", content: "PONG", opts: { orgId: "org_1", replyTo: "m1" } }]);
	});

	it("KILLING: send to a conversation with no inbound-established route fails typed — never guesses an endpoint", async () => {
		const { bridge, sends } = harness();
		const res = await bridge.send({ conversationId: "conv_unknown", content: "hi" });
		expect(res).toEqual({ ok: false });
		expect(sends).toHaveLength(0);
	});

	it("a newer delivery refreshes the route (reply/thread routing follows the latest inbound)", async () => {
		const { bridge, sends, deliver } = harness();
		bridge.onInbound(async () => OK);
		await deliver(msg({ endpoint: "conv_A" }), "conv_A");
		await deliver(msg({ messageId: "m2", endpoint: "conv_A|reply:m2" }), "conv_A|reply:m2");
		await bridge.send({ conversationId: "conv_A", content: "x" });
		expect(sends[0].endpoint).toBe("conv_A|reply:m2");
	});

	it("sdk.send rejection is contained as {ok:false}", async () => {
		const { bridge, deliver } = harness(async () => {
			throw new Error("ws down");
		});
		bridge.onInbound(async () => OK);
		await deliver(msg());
		expect(await bridge.send({ conversationId: "conv_A", content: "x" })).toEqual({ ok: false });
	});

	it("sdk.send result without a string messageId → ok without id (shape is SDK-version tolerant)", async () => {
		const { bridge, deliver } = harness(async () => ({ some: "other-shape" }));
		bridge.onInbound(async () => OK);
		await deliver(msg());
		expect(await bridge.send({ conversationId: "conv_A", content: "x" })).toEqual({ ok: true });
	});
});
