// Layer1<->Layer2 local HTTP contract types (adapted from raft-channel-wake.v1).
// Matches "Architecture + Plan" Part 1.5 / 2.3. Prefer reusing these from
// @openmaxai/cws-agent-sdk when it lands; do not redefine.

/** Contract discriminator pinned by wake-request.schema.json (const). */
export const WAKE_SCHEMA = "raft-channel-wake.v1";

/** POST /wake -- CWS notifies Layer2 of a new message.
 * Canonical shape: schemas/v1/wake-request.schema.json in @openmaxai/openmax-agent-sdk —
 * required: schema/messageId/conversationId/contentPreview; senderId OPTIONAL (mirrors the
 * sender-less InboundMessage case); additionalProperties:false; schema = const WAKE_SCHEMA. */
export interface WakeRequest {
	schema: typeof WAKE_SCHEMA;
	messageId: string;
	conversationId: string;
	senderId?: string;
	contentPreview: string;
}
/** Wire form of wake-result.schema.json. `failureClass` on the wire is the CANONICAL v1 enum
 * (failure-class.schema.json) — the adapter's finer-grained diagnostics (FailureClass below)
 * inform retryAfterMs/logging but never leave the process. */
export type WireFailureClass = "no_inbound_provider" | "wake_failed";
export type WakeResponse =
	| { ok: true; runtimeSession?: string }
	| { ok: false; failureClass: WireFailureClass; retryAfterMs?: number };

/** POST /send -- runtime wants to reply; Layer2 hands it to Layer1 to emit. */
export interface SendRequest {
	conversationId: string;
	content: string;
	replyTo?: string;
}
/** messageId is optional on success: the bridge can confirm delivery without echoing an id
 * (e.g. SDK send result without messageId) — success must not be downgraded for lack of it. */
export type SendResponse = { ok: true; messageId?: string } | { ok: false; failureClass: FailureClass };

/** INTERNAL adapter failure diagnostics (retryable vs terminal, backoff hints — invariants.ts).
 * NOT a wire value for /wake responses: canonical v1 only admits WireFailureClass there.
 * Still used verbatim on the /send local contract (runtime<->adapter, not SDK-governed). */
export type FailureClass = "no_active_turn" | "runtime_busy" | "inject_failed" | "runtime_error" | "unknown";
