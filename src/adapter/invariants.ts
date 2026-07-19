// Key invariant (inherited from raft): ok:true MUST mean the message "truly entered Codex's
// visible context". Never "return success but actually drop it" -- upstream then abandons retry,
// so the message is silently lost (the worst failure mode).
// This module centralizes failureClass classification + retry semantics for the /wake contract.
import type { FailureClass } from "../types.js";

/**
 * Whether a failureClass is worth retrying. Terminal classes (bad auth, permanent runtime
 * error the caller can't fix by retrying) must NOT be retried — retrying just burns quota and
 * hides the real problem.
 */
export function isRetryable(fc: FailureClass): boolean {
	switch (fc) {
		case "no_active_turn": // transient: start a fresh turn next time
		case "runtime_busy": // transient: a turn is mid-flight, back off and retry
		case "inject_failed": // RPC accepted but delivery not confirmed — retry the wake
			return true;
		case "runtime_error": // ambiguous runtime fault — retryable with a longer backoff
			return true;
		case "unknown":
			return true; // fail safe: unknown is retryable (better a retry than a silent drop)
		default:
			return false;
	}
}

/** Suggested backoff for a retryable class; undefined for terminal classes. */
export function retryAfterMs(fc: FailureClass): number | undefined {
	switch (fc) {
		case "runtime_busy":
			return 2_000;
		case "inject_failed":
			return 5_000;
		case "no_active_turn":
			return 1_000;
		case "runtime_error":
		case "unknown":
			return 15_000;
		default:
			return undefined;
	}
}

/**
 * Classify an error/cause into a failureClass. Recognizes the concrete causes the codex client
 * surfaces (auth 401, disconnect, RPC timeout, no active turn, busy) from an Error message or a
 * structured `{ code?, message, httpStatusCode? }`. Defaults to "runtime_error" (retryable) so
 * an unrecognized fault is never silently treated as success.
 */
export function classifyFailure(err: unknown): FailureClass {
	const msg = typeof err === "string" ? err : err instanceof Error ? err.message : errString(err);
	const http = typeof err === "object" && err !== null ? (err as { httpStatusCode?: number }).httpStatusCode : undefined;

	if (http === 401 || /\b401\b|unauthorized|missing bearer|invalid api key/i.test(msg)) return "runtime_error"; // NOTE: terminal — see isAuthTerminal
	if (/disconnect|transport disconnected|epipe|econnrefused|spawn error|exited/i.test(msg)) return "runtime_error";
	if (/timed out|timeout/i.test(msg)) return "inject_failed";
	if (/no active turn/i.test(msg)) return "no_active_turn";
	if (/already has an active turn|runtime busy|turn in progress/i.test(msg)) return "runtime_busy";
	if (/inject|not.*delivered|delivery/i.test(msg)) return "inject_failed";
	return "runtime_error";
}

/**
 * Auth failures are TERMINAL — retrying a 401 just burns quota and never recovers until the key
 * is fixed. Kept separate from classifyFailure's coarse mapping so the caller can mark ok:false
 * without a retryAfterMs (no auto-retry) and surface it for human attention.
 */
export function isAuthTerminal(err: unknown): boolean {
	const msg = typeof err === "string" ? err : err instanceof Error ? err.message : errString(err);
	const http = typeof err === "object" && err !== null ? (err as { httpStatusCode?: number }).httpStatusCode : undefined;
	return http === 401 || /\b401\b|unauthorized|missing bearer|invalid api key/i.test(msg);
}

function errString(v: unknown): string {
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}
