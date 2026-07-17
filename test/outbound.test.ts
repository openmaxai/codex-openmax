import { describe, it, expect } from "vitest";
import { attachOutbound } from "../src/adapter/outbound.js";
import type { AgentMessageEvent, CodexClient } from "../src/adapter/codex-client.js";
import type { SendRequest } from "../src/types.js";

function fakeClient() {
	const cbs: Array<(e: AgentMessageEvent) => void> = [];
	const client = {
		onAgentMessage: (cb: (e: AgentMessageEvent) => void) => cbs.push(cb),
	} as unknown as CodexClient;
	return { client, emit: (e: AgentMessageEvent) => cbs.forEach((cb) => cb(e)) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("outbound capture", () => {
	it("relays completed agent messages to the mapped conversation", async () => {
		const { client, emit } = fakeClient();
		const sent: SendRequest[] = [];
		attachOutbound(
			client,
			(threadId) => (threadId === "thr_1" ? "conv_A" : undefined),
			async (req) => void sent.push(req),
			() => {},
		);
		emit({ threadId: "thr_1", turnId: "t1", text: "hello from codex" });
		await flush();
		expect(sent).toEqual([{ conversationId: "conv_A", content: "hello from codex" }]);
	});

	it("KILLING: unmapped thread is dropped with a warn, never sent anywhere", async () => {
		const { client, emit } = fakeClient();
		const sent: SendRequest[] = [];
		const warns: string[] = [];
		attachOutbound(client, () => undefined, async (req) => void sent.push(req), (m) => warns.push(m));
		emit({ threadId: "thr_unknown", turnId: "t1", text: "leaked?" });
		await flush();
		expect(sent).toEqual([]);
		expect(warns).toHaveLength(1);
	});

	it("empty/whitespace agent messages are not relayed", async () => {
		const { client, emit } = fakeClient();
		const sent: SendRequest[] = [];
		attachOutbound(client, () => "conv_A", async (req) => void sent.push(req), () => {});
		emit({ threadId: "thr_1", turnId: "t1", text: "   " });
		await flush();
		expect(sent).toEqual([]);
	});

	it("send failure is contained (warned, no unhandled rejection)", async () => {
		const { client, emit } = fakeClient();
		const warns: string[] = [];
		attachOutbound(
			client,
			() => "conv_A",
			async () => {
				throw new Error("bridge down");
			},
			(m) => warns.push(m),
		);
		emit({ threadId: "thr_1", turnId: "t1", text: "hi" });
		await flush();
		expect(warns.some((w) => w.includes("bridge down"))).toBe(true);
	});
});
