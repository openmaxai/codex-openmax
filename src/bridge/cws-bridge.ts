// Layer 1 — Bridge (platform-protocol layer, thin wrapper).
// Real impl adapts @openmaxai/openmax-agent-sdk's CwsAgentBridge (see sdk-bridge.ts); on an
// inbound message it POSTs the local /wake; /send is emitted back to CWS via the SDK.
// The SDK is NOT npm-published yet, so P1 MVP ships a MOCK bridge that implements the same
// interface — swap in the SDK-backed impl when it lands (no caller change).
import type { SendRequest, WakeRequest, WakeResponse } from "../types.js";

export interface CwsBridge {
	/** Connect to CWS and begin delivering inbound messages to the registered wake handler. */
	start(): Promise<void>;
	/**
	 * Register the handler invoked for each inbound CWS message (wired to the local /wake).
	 * The handler's WakeResponse MUST be returned faithfully: the SDK's InboundDelivery.deliver
	 * resolves with it, and ok:true is what commits the SDK's dedupe/ledger/sync markers
	 * (wake-result.schema.json invariant) — a swallowed or fabricated result loses messages.
	 */
	onInbound(handler: (wake: WakeRequest) => Promise<WakeResponse>): void;
	/** Emit a runtime reply back to CWS. Returns the platform message id on success. */
	send(req: SendRequest): Promise<{ ok: boolean; messageId?: string }>;
	stop(): Promise<void>;
}

export interface MockCwsBridge extends CwsBridge {
	/** Test/dev hook: simulate an inbound CWS message; resolves with the handler's WakeResponse. */
	simulateInbound(wake: WakeRequest): Promise<WakeResponse>;
	/** Everything this bridge "sent" to CWS (for assertions / local dev inspection). */
	readonly sent: SendRequest[];
}

/**
 * In-memory mock of the CWS bridge for P1 MVP (no SDK yet). `send` records the message and
 * returns a synthetic id; `simulateInbound` drives the inbound path that the real SDK will own.
 */
export function createMockCwsBridge(opts?: { idPrefix?: string }): MockCwsBridge {
	const idPrefix = opts?.idPrefix ?? "mock_msg_";
	let handler: ((wake: WakeRequest) => Promise<WakeResponse>) | null = null;
	let started = false;
	let counter = 0;
	const sent: SendRequest[] = [];

	return {
		sent,
		async start() {
			started = true;
		},
		onInbound(h) {
			handler = h;
		},
		async send(req) {
			if (!started) return { ok: false };
			sent.push(req);
			counter += 1;
			return { ok: true, messageId: `${idPrefix}${counter}` };
		},
		async stop() {
			started = false;
			handler = null;
		},
		async simulateInbound(wake) {
			if (!started) throw new Error("bridge not started");
			if (!handler) throw new Error("no inbound handler registered");
			return handler(wake);
		},
	};
}

// The SDK-backed implementation lives in sdk-bridge.ts (createSdkCwsBridge) — coded against
// @openmaxai/openmax-agent-sdk's canonical contract, activated when the package is published.
