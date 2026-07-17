// Injection model (where the three P0 design decisions land, see plan 3.3):
//   1) active turn -> turn.steer injection;
//   2) no active turn -> codex-reply(threadId) new turn, or queue (decided in P0);
//   3) after injecting, verify it "truly entered Codex's visible context" before ok:true (invariants.ts).
import type { CodexClient } from "./codex-client.js";
import type { WakeRequest, WakeResponse } from "../types.js";

export async function injectWake(_client: CodexClient, _wake: WakeRequest): Promise<WakeResponse> {
	throw new Error("injectWake() not implemented (P0 decides injection model + no-turn handling)");
}
