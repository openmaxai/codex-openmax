// Layer1<->Layer2 local HTTP contract types (adapted from raft-channel-wake.v1).
// Matches "Architecture + Plan" Part 1.5 / 2.3. Prefer reusing these from
// @openmaxai/cws-agent-sdk when it lands; do not redefine.

/** POST /wake -- CWS notifies Layer2 of a new message. */
export interface WakeRequest {
	schema: string;
	messageId: string;
	conversationId: string;
	senderId: string;
	contentPreview?: string;
}
export type WakeResponse =
	| { ok: true; runtimeSession?: string }
	| { ok: false; failureClass: FailureClass; retryAfterMs?: number };

/** POST /send -- runtime wants to reply; Layer2 hands it to Layer1 to emit. */
export interface SendRequest {
	conversationId: string;
	content: string;
	replyTo?: string;
}
export type SendResponse = { ok: true; messageId: string } | { ok: false; failureClass: FailureClass };

/** Failure classes (P2: enumerate retryable vs terminal). */
export type FailureClass = "no_active_turn" | "runtime_busy" | "inject_failed" | "runtime_error" | "unknown";
