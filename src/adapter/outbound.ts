// Outbound: capture Codex output -> build a SendRequest -> hand to the Bridge to relay to CWS.
// MVP strategy: relay each completed agentMessage item (client emits them on item/completed),
// one SendRequest per message. P2 decision: streaming/partial relay, batching, backpressure —
// see Architecture Part 1.5.
import type { CodexClient } from "./codex-client.js";
import type { SendRequest } from "../types.js";

/**
 * Wire the client's agent-message stream to the Bridge.
 * `resolveConversation` maps threadId -> conversationId (registry lives in server.ts);
 * messages for unknown threads are dropped with a warn (never sent to the wrong conversation).
 */
export function attachOutbound(
	client: CodexClient,
	resolveConversation: (threadId: string) => string | undefined,
	send: (req: SendRequest) => Promise<void>,
	warn: (msg: string) => void = console.warn,
): void {
	client.onAgentMessage((e) => {
		if (!e.text.trim()) return;
		const conversationId = resolveConversation(e.threadId);
		if (!conversationId) {
			warn(`outbound: no conversation mapped for thread ${e.threadId}; dropping agent message`);
			return;
		}
		void send({ conversationId, content: e.text }).catch((err) => {
			warn(`outbound: send failed for conversation ${conversationId}: ${String(err)}`);
		});
	});
}
