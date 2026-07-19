// REAL-SDK integration: my sdk-bridge adapter driven through the actual
// @openmaxai/openmax-agent-sdk@0.1.0-alpha.0 CwsAgentBridge pipeline (no duck-type
// assumptions). Harness mirrors the SDK's own test/contract.test.js: injected fetch
// routes the detail/conversation fetches, FakeWebSocket + urlProvider keep it hermetic,
// injectFrame() drives the full dedupe → detail-fetch → hoist → conversation-fetch →
// access-policy → deliver() path. Fixture data comes from the SDK's shipped
// fixtures/v1/inbound-message corpus (the language-neutral contract).
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
// @ts-expect-error — the alpha SDK ships no type declarations yet (plain JS/ESM)
import { CwsAgentBridge, CwsHttpClient } from "@openmaxai/openmax-agent-sdk";
import { createSdkCwsBridge } from "../src/bridge/sdk-bridge.js";
import type { WakeRequest, WakeResponse } from "../src/types.js";

const FIXTURES = "node_modules/@openmaxai/openmax-agent-sdk/fixtures/v1/inbound-message";
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

class FakeWebSocket extends EventEmitter {
	readyState = 1; // OPEN
	ping() {}
	terminate() {}
	send() {}
	close() {}
}
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
const flush = (n = 6) =>
	new Promise<void>((resolve) => {
		let i = 0;
		const tick = () => (++i >= n ? resolve() : setImmediate(tick));
		setImmediate(tick);
	});
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mkRes(status: number, body: string) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: `HTTP ${status}`,
		text: async () => body,
		arrayBuffer: async () => Buffer.from(body),
	};
}

interface Route {
	match: (url: string, method: string) => boolean;
	data?: unknown;
	capture?: (body: unknown) => void;
}
function routingFetch(routes: Route[]) {
	return async (url: string, opts: { method?: string; body?: string } = {}) => {
		const method = opts.method || "GET";
		for (const r of routes) {
			if (r.match(url, method)) {
				if (r.capture && opts.body) r.capture(JSON.parse(opts.body));
				return mkRes(200, JSON.stringify({ data: r.data ?? {}, request_id: "r" }));
			}
		}
		return mkRes(200, JSON.stringify({ data: {}, request_id: "r" }));
	};
}

/** Build my CwsBridge on a REAL CwsAgentBridge wired to the fixture's org + fetch routes. */
async function startRealBridge(fx: { org: { org_id: string }; frame: { payload: { conversation_id: string; id: string } }; detail: unknown; conversation: unknown }, extraRoutes: Route[] = []) {
	const conv = fx.frame.payload.conversation_id;
	const msgId = fx.frame.payload.id;
	const http = new CwsHttpClient({
		baseUrl: "http://api.test",
		fetch: routingFetch([
			{ match: (u, m) => m === "GET" && new RegExp(`/conversations/${reEsc(conv)}/messages/${reEsc(msgId)}$`).test(u), data: fx.detail },
			{ match: (u, m) => m === "GET" && new RegExp(`/conversations/${reEsc(conv)}$`).test(u), data: fx.conversation },
			...extraRoutes,
		]),
		logger: quietLogger,
	});
	http.setApiKey("test-key");

	let sdk: InstanceType<typeof CwsAgentBridge>;
	const bridge = createSdkCwsBridge((deliver) => {
		sdk = new CwsAgentBridge({
			http,
			ws: { baseUrl: "wss://test/ws", urlProvider: async () => "wss://test/ws?ticket=t", wsFactory: () => new FakeWebSocket() },
			orgConfigs: [fx.org],
			providers: { logger: quietLogger, inbound: { deliver } },
			callbacks: { syncSelf: async () => ({ nameReady: true }) },
			reporters: { metrics: false, frameMetrics: false, markReadOnDeliver: false },
		});
		return sdk;
	});
	await bridge.start();
	return { bridge, sdk: sdk!, inject: () => sdk!.injectFrame(fx.org.org_id, fx.frame) };
}

describe("REAL-SDK integration (CwsAgentBridge @0.1.0-alpha.2 → sdk-bridge → wake contract)", () => {
	it("a DM frame through the REAL inbound pipeline reaches the wake handler as a contract-exact WakeRequest", async () => {
		process.env.COCO_RPC_LOG = "0";
		const fx = readJson(`${FIXTURES}/01-dm-open-basic.json`);
		const wakes: WakeRequest[] = [];
		const { bridge, inject } = await startRealBridge(fx);
		bridge.onInbound(async (w) => {
			wakes.push(w);
			return { ok: true, runtimeSession: "thr_1" };
		});
		inject();
		await flush();
		expect(wakes).toEqual([
			{ schema: "raft-channel-wake.v1", messageId: "m1", conversationId: "c1", senderId: "u1", contentPreview: "hello" },
		]);
		await bridge.stop();
	});

	it("KILLING: an UNRESOLVED sender from the real pipeline OMITS senderId (sender-less wake is legal per SDK v1)", async () => {
		const fx = readJson(`${FIXTURES}/05-dm-sender-unresolved.json`);
		const wakes: WakeRequest[] = [];
		const { bridge, inject } = await startRealBridge(fx);
		bridge.onInbound(async (w) => {
			wakes.push(w);
			return { ok: true };
		});
		inject();
		await flush();
		expect(wakes).toHaveLength(1);
		expect("senderId" in wakes[0]).toBe(false); // absent on InboundMessage → absent on the wire (fixture 04-sender-less)
		await bridge.stop();
	});

	it("outbound: send() routes through the endpoint/orgId captured from the real delivery and posts AGENT_TEXT with parent_id", async () => {
		const fx = readJson(`${FIXTURES}/01-dm-open-basic.json`);
		const posted: Array<Record<string, unknown>> = [];
		const { bridge, inject } = await startRealBridge(fx, [
			{
				match: (u, m) => m === "POST" && /\/conversations\/c1\/messages$/.test(u),
				data: { id: "srv_9" },
				capture: (b) => posted.push(b as Record<string, unknown>),
			},
		]);
		bridge.onInbound(async () => ({ ok: true }) as WakeResponse);
		inject();
		await flush();

		const res = await bridge.send({ conversationId: "c1", content: "PONG", replyTo: "m1" });
		expect(res).toEqual({ ok: true, messageId: "srv_9" });
		expect(posted).toHaveLength(1);
		expect(posted[0].type).toBe("AGENT_TEXT");
		expect(posted[0].parent_id).toBe("m1");
		expect((posted[0].content as { body: { text: string } }).body.text).toBe("PONG");
		await bridge.stop();
	});

	it("KILLING: the handler's ok:false flows back VERBATIM as deliver()'s result through the real pipeline (ledger honesty)", async () => {
		const fx = readJson(`${FIXTURES}/01-dm-open-basic.json`);
		// Observe deliver()'s ACTUAL resolution by wrapping the inbound provider the SDK calls.
		const deliverResults: WakeResponse[] = [];
		const http = new CwsHttpClient({
			baseUrl: "http://api.test",
			fetch: routingFetch([
				{ match: (u, m) => m === "GET" && /\/conversations\/c1\/messages\/m1$/.test(u), data: fx.detail },
				{ match: (u, m) => m === "GET" && /\/conversations\/c1$/.test(u), data: fx.conversation },
			]),
			logger: quietLogger,
		});
		http.setApiKey("test-key");
		let sdk: InstanceType<typeof CwsAgentBridge>;
		const bridge = createSdkCwsBridge((deliver) => {
			sdk = new CwsAgentBridge({
				http,
				ws: { baseUrl: "wss://test/ws", urlProvider: async () => "wss://test/ws?ticket=t", wsFactory: () => new FakeWebSocket() },
				orgConfigs: [fx.org],
				providers: {
					logger: quietLogger,
					inbound: {
						deliver: async (msg: unknown, endpoint: string, priority?: number) => {
							const r = await deliver(msg as Parameters<typeof deliver>[0], endpoint, priority);
							deliverResults.push(r);
							return r;
						},
					},
				},
				callbacks: { syncSelf: async () => ({ nameReady: true }) },
				reporters: { metrics: false, frameMetrics: false, markReadOnDeliver: false },
			});
			return sdk;
		});
		bridge.onInbound(async () => ({ ok: false, failureClass: "wake_failed", retryAfterMs: 2000 }) as WakeResponse);
		await bridge.start();
		sdk!.injectFrame(fx.org.org_id, fx.frame);
		await flush();
		expect(deliverResults).toEqual([{ ok: false, failureClass: "wake_failed", retryAfterMs: 2000 }]);
		await bridge.stop();
	});
});
