// Layer 1 — SDK-backed CWS bridge (adapts @openmaxai/openmax-agent-sdk's CwsAgentBridge
// to our CwsBridge interface). Coded against the SDK's canonical contract at PR #1 head
// 7fc6949 (schemas/v1/inbound-message + wake-request/wake-result, README orchestrator
// surface); the SDK object is INJECTED (duck-typed minimal surface) because the package
// is not npm-published yet — when it lands, index.ts constructs the real CwsAgentBridge
// and hands it here unchanged.
//
// Contract mapping (both sides pinned by schemas/v1):
//   inbound: InboundDelivery.deliver(msg, endpoint, priority)
//     → WakeRequest {schema, messageId, conversationId, senderId, contentPreview}
//     → the registered inbound handler (POST /wake path)
//     → deliver() resolves with the handler's WakeResponse VERBATIM.
//       INVARIANT (wake-result.schema.json): ok:true ⇔ the message genuinely entered the
//       runtime context. Fabricating ok here would make the SDK commit its dedupe/ledger/
//       sync markers and stop retrying — the message would be silently lost.
//   outbound: our SendRequest {conversationId, content, replyTo}
//     → sdk.send(endpoint, content, {orgId, replyTo}) — endpoint/orgId come from a
//       conversationId → {endpoint, orgId} registry populated by inbound deliveries
//       (last-seen endpoint wins: it encodes reply/thread/parent routing).
import { WAKE_SCHEMA, type SendRequest, type WakeRequest, type WakeResponse } from "../types.js";
import type { CwsBridge } from "./cws-bridge.js";

/** Minimal duck-typed surface of the SDK's CwsAgentBridge that this adapter uses. */
export interface SdkAgentBridge {
	start(): Promise<void>;
	stop(): Promise<void>;
	send(endpoint: string, content: string, opts?: { orgId?: string; replyTo?: string }): Promise<unknown>;
}

/** The subset of the SDK's normalized InboundMessage this adapter reads (inbound-message.schema.json). */
export interface SdkInboundMessage {
	orgId: string;
	conversationId: string;
	messageId: string;
	/** OPTIONAL in the schema: the SDK still delivers when the sender can't be resolved. */
	senderId?: string;
	text: string;
	/** formatEndpoint() routing key: <conversationId>[|reply:..][|thread:..][|parent:..]. */
	endpoint: string;
}

export type SdkInboundDeliver = (msg: SdkInboundMessage, endpoint: string, priority?: number) => Promise<WakeResponse>;

/** contentPreview is "short, non-authoritative" (wake-request.schema.json) — cap it. */
const PREVIEW_MAX = 480;
export function toWakeRequest(msg: SdkInboundMessage): WakeRequest {
	// LIVE finding (openmax.com, 2026-07-18): the real server delivers message ids as JSON
	// NUMBERS (e.g. 1784124726965) even though inbound-message.schema.json declares
	// messageId:string (the SDK's fixtures all use string ids, so its contract test never
	// catches the drift — reported upstream). The wake-request contract requires strings,
	// so coerce at this boundary; wake-queue dedup keys stay strings either way.
	const text = String(msg.text ?? "");
	return {
		schema: WAKE_SCHEMA,
		messageId: String(msg.messageId),
		conversationId: String(msg.conversationId),
		// senderId is REQUIRED (string) on the wire but optional on InboundMessage —
		// an unresolved sender maps to "" (schema-valid; the runtime treats it as unknown).
		senderId: msg.senderId == null ? "" : String(msg.senderId),
		contentPreview: text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text,
	};
}

/**
 * Build a CwsBridge backed by the real SDK. `makeBridge` receives our InboundDelivery-shaped
 * deliver function and must return the constructed SDK bridge (in production:
 * `new CwsAgentBridge({ ..., providers: { inbound: { deliver }, ... } })`).
 */
export function createSdkCwsBridge(makeBridge: (deliver: SdkInboundDeliver) => SdkAgentBridge): CwsBridge {
	let handler: ((wake: WakeRequest) => Promise<WakeResponse>) | null = null;
	// conversationId → outbound routing, refreshed on every inbound delivery.
	const routes = new Map<string, { endpoint: string; orgId: string }>();

	const deliver: SdkInboundDeliver = async (msg, endpoint) => {
		routes.set(msg.conversationId, { endpoint, orgId: msg.orgId });
		if (!handler) {
			// No runtime wired yet: fail typed (SDK holds its markers and redelivers) — never ok.
			return { ok: false, failureClass: "runtime_error", retryAfterMs: 15_000 };
		}
		try {
			return await handler(toWakeRequest(msg));
		} catch {
			// A throwing handler must not bubble into the SDK as an unclassified rejection here;
			// deliver() resolving ok:false keeps the retry semantics identical.
			return { ok: false, failureClass: "runtime_error", retryAfterMs: 15_000 };
		}
	};

	const sdk = makeBridge(deliver);

	return {
		start: () => sdk.start(),
		stop: () => sdk.stop(),
		onInbound(h) {
			handler = h;
		},
		async send(req: SendRequest) {
			const route = routes.get(req.conversationId);
			// No inbound has established routing for this conversation — we cannot build the
			// endpoint key, and guessing one could deliver into the wrong thread. Fail typed.
			if (!route) return { ok: false };
			try {
				const result = await sdk.send(route.endpoint, req.content, { orgId: route.orgId, replyTo: req.replyTo });
				const messageId =
					typeof result === "object" && result !== null && typeof (result as { messageId?: unknown }).messageId === "string"
						? (result as { messageId: string }).messageId
						: undefined;
				return { ok: true, ...(messageId ? { messageId } : {}) };
			} catch {
				return { ok: false };
			}
		},
	};
}
