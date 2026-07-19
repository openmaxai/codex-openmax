// Injection model (P0-decided, see docs/p0-spike-findings.md):
//   1) active turn -> turn/steer (CAS on expectedTurnId; codex-client retries once with the
//      real id carried by the CAS error, then falls back to turn/start);
//   2) no active turn -> turn/start on the same app-server connection;
//   3) ok:true is gated on the injected userMessage's item/completed (invariants: never
//      report success without confirmed entry into model-visible history).
// Thread registry (conversationId -> threadId) lives in server.ts (P1); callers pass threadId.
import type { CodexClient } from "./codex-client.js";
import { classifyFailure, isAuthTerminal, retryAfterMs } from "./invariants.js";
import type { WakeRequest, WakeResponse } from "../types.js";

export function formatWakeText(wake: WakeRequest): string {
	// MVP: relay the preview (REQUIRED per wake-request.schema.json); P1 decides
	// preview-vs-full-content fetch via the Bridge. senderId is optional on the wire
	// (sender-less inbound) — omit the "from" clause rather than render a blank sender.
	const from = wake.senderId ? ` from ${wake.senderId}` : "";
	return `[CWS message ${wake.messageId} in conversation ${wake.conversationId}${from}]\n${wake.contentPreview}`;
}

export async function injectWake(
	client: CodexClient,
	threadId: string,
	wake: WakeRequest,
	opts?: { deliveryTimeoutMs?: number },
): Promise<WakeResponse> {
	try {
		const outcome = await client.inject(threadId, formatWakeText(wake), opts);
		if (!outcome.delivered) {
			// RPC accepted but no item/completed confirmation: do NOT claim success. Retryable.
			// (Wire failureClass is the canonical enum; the internal class only sets the hint.)
			return { ok: false, failureClass: "wake_failed", retryAfterMs: retryAfterMs("inject_failed") };
		}
		return { ok: true, runtimeSession: threadId };
	} catch (err) {
		// Auth failures: per v1 semantics ANY ok:false is still redelivered on the next /sync
		// sweep — omitting retryAfterMs only removes the backoff hint, it cannot stop the loop
		// (terminal-no-retry is inexpressible in v1; contract-revision proposal pending).
		if (isAuthTerminal(err)) return { ok: false, failureClass: "wake_failed" };
		const diagnosed = classifyFailure(err);
		return { ok: false, failureClass: "wake_failed", retryAfterMs: retryAfterMs(diagnosed) };
	}
}
