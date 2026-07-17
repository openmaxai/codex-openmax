// Layer 2 - local HTTP server: POST /wake, POST /send.
// /wake: receive a CWS message -> inject into Codex (see inject.ts) -> return ok:true/false
//        based on "truly delivered" (see invariants.ts).
// /send: receive Codex output -> hand to the Bridge to emit back to CWS.
// Contract: see types.ts / Architecture Part 1.5.
export function startAdapterServer(_port: number): void {
	throw new Error("startAdapterServer() not implemented (P1)");
}
