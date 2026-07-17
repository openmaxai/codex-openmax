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
	// preview-vs-full-content fetch via the Bridge.
	return `[CWS message ${wake.messageId} in conversation ${wake.conversationId} from ${wake.senderId}]\n${wake.contentPreview}`;
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
			return { ok: false, failureClass: "inject_failed", retryAfterMs: retryAfterMs("inject_failed") };
		}
		return { ok: true, runtimeSession: threadId };
	} catch (err) {
		// Auth failures are terminal — no retryAfterMs, so upstream won't loop on a bad key.
		if (isAuthTerminal(err)) return { ok: false, failureClass: "runtime_error" };
		const failureClass = classifyFailure(err);
		return { ok: false, failureClass, retryAfterMs: retryAfterMs(failureClass) };
	}
}
