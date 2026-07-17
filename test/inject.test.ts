import { describe, it, expect } from "vitest";
import { classifyFailure } from "../src/adapter/invariants.js";
import {
	activeTurnIdFromSteerError,
	createCodexClient,
	type Transport,
} from "../src/adapter/codex-client.js";
import { injectWake } from "../src/adapter/inject.js";
import type { WakeRequest } from "../src/types.js";

// Fake app-server: scripted JSON-RPC responder replaying spike-observed shapes
// (docs/p0-spike-findings.md). Handlers get the request and an emit() for notifications.
type Handler = (req: any, emit: (notif: object) => void) => object | undefined;

function fakeTransport(handlers: Record<string, Handler>): Transport & { sent: any[] } {
	const lineCbs: Array<(line: string) => void> = [];
	const sent: any[] = [];
	const deliver = (msg: object) => {
		const line = JSON.stringify(msg);
		queueMicrotask(() => {
			for (const cb of lineCbs) cb(line);
		});
	};
	return {
		sent,
		send(line: string) {
			const req = JSON.parse(line);
			sent.push(req);
			if (req.id === undefined) return; // notification from client
			const h = handlers[req.method];
			if (!h) {
				deliver({ id: req.id, error: { code: -32601, message: `no handler: ${req.method}` } });
				return;
			}
			const result = h(req, deliver);
			if (result !== undefined) deliver({ id: req.id, ...result });
		},
		onLine: (cb) => lineCbs.push(cb),
		onExit: () => {},
		close() {},
	};
}

const initHandlers: Record<string, Handler> = {
	initialize: () => ({ result: { userAgent: "fake/0.136.0" } }),
	"thread/start": () => ({ result: { thread: { id: "thr_1", status: { type: "idle" } } } }),
};

/** turn/start that confirms delivery: emits item/completed for the injected userMessage. */
const confirmingTurnStart: Handler = (req, emit) => {
	emit({ method: "turn/started", params: { threadId: req.params.threadId, turn: { id: "turn_1" } } });
	emit({
		method: "item/completed",
		params: {
			threadId: req.params.threadId,
			turnId: "turn_1",
			item: { type: "userMessage", clientId: req.params.clientUserMessageId, content: [] },
		},
	});
	return { result: { turn: { id: "turn_1", status: "inProgress" } } };
};

const WAKE: WakeRequest = {
	schema: "channel-wake.v1",
	messageId: "m1",
	conversationId: "c1",
	senderId: "u1",
	contentPreview: "hello",
};

async function startedClient(handlers: Record<string, Handler>) {
	const transport = fakeTransport({ ...initHandlers, ...handlers });
	const client = createCodexClient(transport);
	await client.start();
	return { client, transport };
}

describe("codex-client inject", () => {
	it("no active turn -> turn/start, delivered on item/completed of the injected message", async () => {
		const { client, transport } = await startedClient({ "turn/start": confirmingTurnStart });
		const threadId = await client.startThread();
		const outcome = await client.inject(threadId, "ping");
		expect(outcome).toEqual({ turnId: "turn_1", delivered: true, mode: "turn/start" });
		expect(transport.sent.some((r) => r.method === "turn/steer")).toBe(false);
	});

	it("active turn -> turn/steer with the tracked expectedTurnId", async () => {
		const { client, transport } = await startedClient({
			"turn/start": confirmingTurnStart,
			"turn/steer": (req, emit) => {
				emit({
					method: "item/completed",
					params: {
						threadId: req.params.threadId,
						turnId: req.params.expectedTurnId,
						item: { type: "userMessage", clientId: req.params.clientUserMessageId, content: [] },
					},
				});
				return { result: {} };
			},
		});
		const threadId = await client.startThread();
		await client.inject(threadId, "first"); // opens turn_1 (still active: no turn/completed)
		const outcome = await client.inject(threadId, "second");
		expect(outcome).toEqual({ turnId: "turn_1", delivered: true, mode: "turn/steer" });
		const steer = transport.sent.find((r) => r.method === "turn/steer");
		expect(steer.params.expectedTurnId).toBe("turn_1");
	});

	it("steer CAS loss -> retries once with the real id from the error message", async () => {
		let steerCalls = 0;
		const { client, transport } = await startedClient({
			"turn/start": confirmingTurnStart,
			"turn/steer": (req, emit) => {
				steerCalls++;
				if (req.params.expectedTurnId !== "turn_2") {
					return {
						error: { code: -32600, message: "expected active turn id `turn_1` but found `turn_2`" },
					};
				}
				emit({
					method: "item/completed",
					params: {
						threadId: req.params.threadId,
						turnId: "turn_2",
						item: { type: "userMessage", clientId: req.params.clientUserMessageId, content: [] },
					},
				});
				return { result: {} };
			},
		});
		const threadId = await client.startThread();
		await client.inject(threadId, "first"); // activeTurn = turn_1 per notification
		const outcome = await client.inject(threadId, "second");
		expect(steerCalls).toBe(2);
		expect(outcome).toEqual({ turnId: "turn_2", delivered: true, mode: "turn/steer" });
		expect(transport.sent.filter((r) => r.method === "turn/start")).toHaveLength(1);
	});

	it("steer fails without a recoverable id -> falls back to turn/start", async () => {
		const { client, transport } = await startedClient({
			"turn/start": confirmingTurnStart,
			"turn/steer": () => ({ error: { code: -32600, message: "no active turn" } }),
		});
		const threadId = await client.startThread();
		await client.inject(threadId, "first");
		const outcome = await client.inject(threadId, "second");
		expect(outcome.mode).toBe("turn/start");
		expect(outcome.delivered).toBe(true);
		expect(transport.sent.filter((r) => r.method === "turn/start")).toHaveLength(2);
	});
});

describe("injectWake ok:true gate (truly-delivered invariant)", () => {
	it("returns ok:true only after item/completed confirmation", async () => {
		const { client } = await startedClient({ "turn/start": confirmingTurnStart });
		const threadId = await client.startThread();
		const resp = await injectWake(client, threadId, WAKE);
		expect(resp).toEqual({ ok: true, runtimeSession: threadId });
	});

	it("KILLING: RPC success WITHOUT item/completed must NOT be ok:true", async () => {
		// turn/start accepts the request but never confirms the message entered history.
		const { client } = await startedClient({
			"turn/start": (req, emit) => {
				emit({ method: "turn/started", params: { threadId: req.params.threadId, turn: { id: "turn_1" } } });
				return { result: { turn: { id: "turn_1", status: "inProgress" } } };
			},
		});
		const threadId = await client.startThread();
		const resp = await injectWake(client, threadId, WAKE, { deliveryTimeoutMs: 50 });
		expect(resp.ok).toBe(false);
		if (!resp.ok) expect(resp.failureClass).toBe("inject_failed");
	});

	it("client throw -> ok:false runtime_error, never an unhandled rejection", async () => {
		const { client } = await startedClient({
			"turn/start": () => ({ error: { code: -32000, message: "boom" } }),
		});
		const threadId = await client.startThread();
		const resp = await injectWake(client, threadId, WAKE);
		expect(resp).toEqual({ ok: false, failureClass: "runtime_error", retryAfterMs: 15_000 });
	});
});

describe("protocol parsing", () => {
	it("extracts the real active turn id from the steer CAS error", () => {
		expect(
			activeTurnIdFromSteerError("expected active turn id `turn_nonexistent` but found `019f6f4d-67f2`"),
		).toBe("019f6f4d-67f2");
		expect(activeTurnIdFromSteerError("some other error")).toBeNull();
	});

	it("classifyFailure defaults to unknown (P2 will enumerate)", () => {
		expect(classifyFailure(new Error("x"))).toBe("unknown");
	});
});
