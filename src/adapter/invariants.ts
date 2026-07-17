// Key invariant (inherited from raft): ok:true MUST mean the message "truly entered Codex's
// visible context". Never "return success but actually drop it" -- upstream then abandons retry,
// so the message is silently lost (the worst failure mode).
// This module centralizes the "truly delivered" check + failureClass + backoff hints. Landed in P2.
import type { FailureClass } from "../types.js";

export function classifyFailure(_err: unknown): FailureClass {
	return "unknown";
}
