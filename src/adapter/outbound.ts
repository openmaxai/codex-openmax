// Outbound: capture Codex output -> build a SendRequest -> hand to the Bridge to relay to CWS.
// P2 decision: how to handle streaming/partial responses (buffer until turn done? incremental relay?),
// see Architecture Part 1.5.
import type { SendRequest } from "../types.js";

export async function captureOutbound(): Promise<SendRequest> {
	throw new Error("captureOutbound() not implemented (P1/P2)");
}
