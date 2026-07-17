// Layer 1 - Bridge (platform-protocol layer, thin wrapper).
// Uses @openmaxai/cws-agent-sdk to connect the CWS WebSocket; on an inbound message
// it calls the local /wake; /send is emitted back to CWS via the SDK.
// SDK v0 (connect + auth + send/recv) is not published yet: this layer mocks the SDK
// interface to get started (see the plan's P1 prerequisite).
import type { SendRequest } from "../types.js";

export interface CwsBridge {
	start(): Promise<void>;
	send(req: SendRequest): Promise<{ ok: boolean; messageId?: string }>;
	stop(): Promise<void>;
}

// P1: instantiate the real bridge with the SDK. Scaffold placeholder for now.
export function createCwsBridge(): CwsBridge {
	throw new Error("createCwsBridge() not implemented (P1, depends on @openmaxai/cws-agent-sdk v0)");
}
