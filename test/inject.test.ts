import { describe, it, expect } from "vitest";
import { classifyFailure, isAuthTerminal, isRetryable, retryAfterMs } from "../src/adapter/invariants.js";
import {
	activeTurnIdFromSteerError,
	classifySteerError,
	createCodexClient,
	defaultServerRequestResponse,
	isValidServerResult,
	type ServerRequest,
	type ServerRequestHandlers,
	type Transport,
} from "../src/adapter/codex-client.js";
import { injectWake } from "../src/adapter/inject.js";
import { attachOutbound } from "../src/adapter/outbound.js";
import type { SendRequest, WakeRequest } from "../src/types.js";

// Fake app-server: scripted JSON-RPC responder replaying spike-observed shapes
// (docs/p0-spike-findings.md). Handlers get the request and an emit() for notifications.
type Handler = (req: any, emit: (notif: object) => void) => object | undefined;

function fakeTransport(handlers: Record<string, Handler>) {
	const lineCbs: Array<(line: string) => void> = [];
	const exitCbs: Array<(reason: string) => void> = [];
	const sent: any[] = [];
	const deliver = (msg: object) => {
		const line = JSON.stringify(msg);
		queueMicrotask(() => {
			for (const cb of lineCbs) cb(line);
		});
	};
	const transport: Transport = {
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
		onExit: (cb) => exitCbs.push(cb),
		close() {},
	};
	// test-only hooks
	return {
		transport,
		sent,
		emit: deliver,
		kill: (reason = "killed") => exitCbs.forEach((cb) => cb(reason)),
	};
}

const initHandlers: Record<string, Handler> = {
	initialize: () => ({ result: { userAgent: "fake/0.136.0" } }),
	"thread/start": (req) => ({
		result: { thread: { id: req.__threadId ?? "thr_1", status: { type: "idle" } } },
	}),
};

/** turn/start that confirms delivery: emits turn/started + item/completed for the injected msg. */
function confirmingTurnStart(threadId = "thr_1", turnId = "turn_1"): Handler {
	return (req, emit) => {
		emit({ method: "turn/started", params: { threadId: req.params.threadId, turn: { id: turnId } } });
		emit({
			method: "item/completed",
			params: {
				threadId: req.params.threadId,
				turnId,
				item: { type: "userMessage", clientId: req.params.clientUserMessageId, content: [] },
			},
		});
		return { result: { turn: { id: turnId, status: "inProgress" } } };
	};
}

const WAKE: WakeRequest = {
	schema: "channel-wake.v1",
	messageId: "m1",
	conversationId: "c1",
	senderId: "u1",
	contentPreview: "hello",
};

async function startedClient(handlers: Record<string, Handler>, opts?: { requestTimeoutMs?: number }) {
	const f = fakeTransport({ ...initHandlers, ...handlers });
	const client = createCodexClient(f.transport, opts);
	await client.start();
	return { client, ...f };
}

describe("codex-client inject", () => {
	it("no active turn -> turn/start, delivered on item/completed of the injected message", async () => {
		const { client, sent } = await startedClient({ "turn/start": confirmingTurnStart() });
		const threadId = await client.startThread();
		const outcome = await client.inject(threadId, "ping");
		expect(outcome).toEqual({ turnId: "turn_1", delivered: true, mode: "turn/start" });
		expect(sent.some((r) => r.method === "turn/steer")).toBe(false);
	});

	it("active turn -> turn/steer with the tracked expectedTurnId", async () => {
		const { client, sent } = await startedClient({
			"turn/start": confirmingTurnStart(),
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
		expect(sent.find((r) => r.method === "turn/steer").params.expectedTurnId).toBe("turn_1");
	});

	it("steer CAS loss -> retries once with the real id from the error message", async () => {
		let steerCalls = 0;
		const { client, sent } = await startedClient({
			"turn/start": confirmingTurnStart(),
			"turn/steer": (req, emit) => {
				steerCalls++;
				if (req.params.expectedTurnId !== "turn_2") {
					return { error: { code: -32600, message: "expected active turn id `turn_1` but found `turn_2`" } };
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
		await client.inject(threadId, "first");
		const outcome = await client.inject(threadId, "second");
		expect(steerCalls).toBe(2);
		expect(outcome).toEqual({ turnId: "turn_2", delivered: true, mode: "turn/steer" });
		expect(sent.filter((r) => r.method === "turn/start")).toHaveLength(1);
	});

	it("steer fails without a recoverable id -> falls back to turn/start", async () => {
		const { client, sent } = await startedClient({
			"turn/start": confirmingTurnStart(),
			"turn/steer": () => ({ error: { code: -32600, message: "no active turn to steer" } }),
		});
		const threadId = await client.startThread();
		await client.inject(threadId, "first");
		const outcome = await client.inject(threadId, "second");
		expect(outcome.mode).toBe("turn/start");
		expect(outcome.delivered).toBe(true);
		expect(sent.filter((r) => r.method === "turn/start")).toHaveLength(2);
	});
});

// P1#2 regression: per-thread turn state must not be clobbered by another thread.
// Emits REAL turn/completed so removing the map-cleanup mutation turns this red.
describe("codex-client multi-thread turn tracking (P1#2)", () => {
	const perThreadStart: Handler = (req, emit) => {
		const turnId = `turn_${req.params.threadId}`;
		emit({ method: "turn/started", params: { threadId: req.params.threadId, turn: { id: turnId } } });
		emit({
			method: "item/completed",
			params: {
				threadId: req.params.threadId,
				turnId,
				item: { type: "userMessage", clientId: req.params.clientUserMessageId, content: [] },
			},
		});
		return { result: { turn: { id: turnId } } };
	};
	const confirmingSteer: Handler = (req, emit) => {
		emit({
			method: "item/completed",
			params: {
				threadId: req.params.threadId,
				turnId: req.params.expectedTurnId,
				item: { type: "userMessage", clientId: req.params.clientUserMessageId, content: [] },
			},
		});
		return { result: {} };
	};

	it("KILLING: thread B's real completion clears only B; A stays active and its next wake steers turn_A", async () => {
		const { client, sent, emit } = await startedClient({ "turn/start": perThreadStart, "turn/steer": confirmingSteer });
		await client.inject("A", "a1"); // turn_A active
		await client.inject("B", "b1"); // turn_B active
		expect(client.activeTurnId("A")).toBe("turn_A");
		expect(client.activeTurnId("B")).toBe("turn_B");

		// B's turn REALLY completes — kills the "wrong-thread cleanup" mutation:
		emit({ method: "turn/completed", params: { threadId: "B", turn: { id: "turn_B" } } });
		await new Promise((r) => setTimeout(r, 0));
		expect(client.activeTurnId("B")).toBeNull(); // B cleared
		expect(client.activeTurnId("A")).toBe("turn_A"); // A untouched

		// A's next wake must steer turn_A, not start a new turn.
		const outcome = await client.inject("A", "a2");
		expect(outcome.mode).toBe("turn/steer");
		const aSteer = sent.filter((r) => r.method === "turn/steer" && r.params.threadId === "A").at(-1);
		expect(aSteer.params.expectedTurnId).toBe("turn_A");

		// next-idle ownership: B's NEXT wake (after its completion) must be a fresh turn/start,
		// not a stale steer of the completed turn_B.
		const bStartsBefore = sent.filter((r) => r.method === "turn/start" && r.params.threadId === "B").length;
		const bOutcome = await client.inject("B", "b2");
		expect(bOutcome.mode).toBe("turn/start");
		expect(sent.filter((r) => r.method === "turn/start" && r.params.threadId === "B").length).toBe(bStartsBefore + 1);
		expect(sent.some((r) => r.method === "turn/steer" && r.params.threadId === "B")).toBe(false);
	});
});

// P1#1 regression: real agentMessage shape (item.text) must reach outbound, not be dropped.
describe("codex-client agentMessage parsing (P1#1)", () => {
	it("KILLING: raw item/completed {type:agentMessage,text} -> parser -> send (real shape)", async () => {
		const { client, emit } = await startedClient({});
		const sends: SendRequest[] = [];
		attachOutbound(client, () => "conv_A", async (r) => void sends.push(r), () => {});
		// Replay the exact shape the app-server emits (spike PONG): text at item.text.
		emit({
			method: "item/completed",
			params: {
				threadId: "thr_1",
				turnId: "turn_1",
				item: { type: "agentMessage", id: "msg_1", text: "PONG", phase: "final_answer" },
			},
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(sends).toEqual([{ conversationId: "conv_A", content: "PONG" }]);
	});
});

// P1#3 regression: server→client requests must be answered with a METHOD-SPECIFIC,
// schema-shaped, non-interactive DENY — never auto-approved, never silently ignored,
// never an illegal response shape.
describe("codex-client server request handling (P1#3)", () => {
	// The exact Codex 0.136.0 server-request methods and their schema-valid DENY responses.
	const cases: Array<[string, object]> = [
		["item/commandExecution/requestApproval", { decision: "decline" }],
		["item/fileChange/requestApproval", { decision: "decline" }],
		["execCommandApproval", { decision: "denied" }],
		["applyPatchApproval", { decision: "denied" }],
		["item/tool/requestUserInput", { answers: {} }],
		["mcpServer/elicitation/request", { action: "decline" }],
	];
	for (const [method, expected] of cases) {
		it(`KILLING: ${method} with no handler → schema-shaped DENY (never approve)`, async () => {
			const { sent, emit } = await startedClient({});
			emit({ id: 900, method, params: {} });
			await new Promise((r) => setTimeout(r, 0));
			const resp = sent.find((m) => m.id === 900);
			expect(resp, "a response MUST be sent").toBeDefined();
			expect(resp.result, `${method} default must be the schema-shaped decline`).toEqual(expected);
			// never an approval
			const body = JSON.stringify(resp.result);
			expect(body).not.toMatch(/"decision":"(accept|approved)/);
		});
	}

	it("KILLING: methods with no safe non-interactive shape fail closed (error, not grant)", async () => {
		const { sent, emit } = await startedClient({});
		for (const [i, method] of ["item/permissions/requestApproval", "item/tool/call"].entries()) {
			emit({ id: 950 + i, method, params: {} });
		}
		await new Promise((r) => setTimeout(r, 0));
		for (const id of [950, 951]) {
			const resp = sent.find((m) => m.id === id);
			expect(resp.error, "permissions/tool-call must fail closed, never grant").toBeDefined();
			expect(resp.result).toBeUndefined();
		}
	});

	it("defaultServerRequestResponse is a pure schema-shaped policy (unit)", () => {
		expect(defaultServerRequestResponse("item/commandExecution/requestApproval")).toEqual({ result: { decision: "decline" } });
		expect(defaultServerRequestResponse("execCommandApproval")).toEqual({ result: { decision: "denied" } });
		expect(defaultServerRequestResponse("item/tool/requestUserInput")).toEqual({ result: { answers: {} } });
		expect(defaultServerRequestResponse("mcpServer/elicitation/request")).toEqual({ result: { action: "decline" } });
		expect("error" in defaultServerRequestResponse("item/permissions/requestApproval")).toBe(true);
		expect("error" in defaultServerRequestResponse("totally/unknown/method")).toBe(true);
	});

	it("registered per-method handler answers with its typed result", async () => {
		const { client, sent, emit } = await startedClient({});
		const seen: ServerRequest[] = [];
		client.onServerRequest({
			"item/commandExecution/requestApproval": async (req) => {
				seen.push(req);
				return { decision: "decline" };
			},
		});
		emit({ id: 1000, method: "item/commandExecution/requestApproval", params: { command: "ls" } });
		await new Promise((r) => setTimeout(r, 0));
		expect(seen).toHaveLength(1);
		expect(seen[0].method).toBe("item/commandExecution/requestApproval");
		expect(sent.find((m) => m.id === 1000).result).toEqual({ decision: "decline" });
	});

	it("KILLING: a handler that returns a cross-method (invalid) shape is rejected, not forwarded", async () => {
		const { client, sent, emit } = await startedClient({});
		// Simulate a JS/any-cast caller bypassing the compile-time per-method typing:
		client.onServerRequest({
			// user-input MUST return {answers}; returning a command {decision} is illegal
			"item/tool/requestUserInput": (async () => ({ decision: "decline" })) as never,
		});
		emit({ id: 1001, method: "item/tool/requestUserInput", params: {} });
		await new Promise((r) => setTimeout(r, 0));
		const resp = sent.find((m) => m.id === 1001);
		expect(resp.error, "invalid cross-method result must be rejected at runtime").toBeDefined();
		expect(resp.result).toBeUndefined();
	});

	// R7/R8: the guard must validate the WIRE form, not the live object. Each case below passes
	// a live-object check but serializes to schema-invalid bytes — all must be rejected.
	it("KILLING (R7): sparse user-input answers array (holes → [null] on wire) is rejected", async () => {
		const { client, sent, emit } = await startedClient({});
		client.onServerRequest({
			// live: Array.every skips the hole so element-type checks pass; wire: [null]
			"item/tool/requestUserInput": (async () => ({ answers: { q: { answers: new Array(1) } } })) as never,
		});
		emit({ id: 1100, method: "item/tool/requestUserInput", params: {} });
		await new Promise((r) => setTimeout(r, 0));
		const resp = sent.find((m) => m.id === 1100);
		expect(resp.error, "sparse answers array must be rejected, not sent as [null]").toBeDefined();
		expect(resp.result).toBeUndefined();
		expect(JSON.stringify(sent)).not.toContain("[null]");
	});

	it("KILLING (R7): sparse execpolicy string[] (hole → null amendment on wire) is rejected", async () => {
		const { client, sent, emit } = await startedClient({});
		client.onServerRequest({
			"item/commandExecution/requestApproval": (async () => ({
				decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: new Array(1) } },
			})) as never,
		});
		emit({ id: 1101, method: "item/commandExecution/requestApproval", params: {} });
		await new Promise((r) => setTimeout(r, 0));
		const resp = sent.find((m) => m.id === 1101);
		expect(resp.error, "sparse execpolicy_amendment must be rejected").toBeDefined();
		expect(resp.result).toBeUndefined();
	});

	it("KILLING (R7): inherited required prop (Object.create({decision}) → {} on wire) is rejected", async () => {
		const { client, sent, emit } = await startedClient({});
		client.onServerRequest({
			// live: Object.keys=[] passes onlyKeys vacuously and r.decision reads the prototype;
			// wire: stringify drops inherited props → {} (missing required `decision`)
			"item/fileChange/requestApproval": (async () => Object.create({ decision: "decline" })) as never,
		});
		emit({ id: 1102, method: "item/fileChange/requestApproval", params: {} });
		await new Promise((r) => setTimeout(r, 0));
		const resp = sent.find((m) => m.id === 1102);
		expect(resp.error, "inherited decision must be rejected, not sent as {}").toBeDefined();
		expect(resp.result).toBeUndefined();
	});

	it("KILLING (R7): nested inherited required prop (user-input answer via prototype) is rejected", async () => {
		const { client, sent, emit } = await startedClient({});
		client.onServerRequest({
			// live: the nested answer object reads `answers` off its prototype; wire: {}
			"item/tool/requestUserInput": (async () => ({ answers: { q: Object.create({ answers: ["x"] }) } })) as never,
		});
		emit({ id: 1103, method: "item/tool/requestUserInput", params: {} });
		await new Promise((r) => setTimeout(r, 0));
		const resp = sent.find((m) => m.id === 1103);
		expect(resp.error, "nested inherited answers must be rejected").toBeDefined();
		expect(resp.result).toBeUndefined();
	});

	it("KILLING (R7): toJSON drift (live-valid object whose toJSON serializes invalid) is rejected", async () => {
		const { client, sent, emit } = await startedClient({});
		// Non-enumerable toJSON: invisible to Object.keys (live checks pass on {decision:"decline"}),
		// but stringify calls it and emits {} — the wire form is what must be validated.
		const drifting = Object.defineProperty({ decision: "decline" }, "toJSON", {
			value: () => ({}),
			enumerable: false,
		});
		client.onServerRequest({
			"item/fileChange/requestApproval": (async () => drifting) as never,
		});
		emit({ id: 1104, method: "item/fileChange/requestApproval", params: {} });
		await new Promise((r) => setTimeout(r, 0));
		const resp = sent.find((m) => m.id === 1104);
		expect(resp.error, "toJSON-drifted result must be rejected").toBeDefined();
		expect(resp.result).toBeUndefined();
	});

	it("KILLING (R7): unserializable handler result (circular) fails closed, not thrown", async () => {
		const { client, sent, emit } = await startedClient({});
		const circular: Record<string, unknown> = { decision: "decline" };
		circular.self = circular;
		client.onServerRequest({
			"item/fileChange/requestApproval": (async () => circular) as never,
		});
		emit({ id: 1105, method: "item/fileChange/requestApproval", params: {} });
		await new Promise((r) => setTimeout(r, 0));
		const resp = sent.find((m) => m.id === 1105);
		expect(resp.error, "circular result must produce a -32603 error response").toBeDefined();
		expect(resp.error.code).toBe(-32603);
	});

	it("(R7 positive control) a valid handler result still goes out, and the sent bytes equal the validated form", async () => {
		const { client, sent, emit } = await startedClient({});
		client.onServerRequest({
			"item/commandExecution/requestApproval": async () => ({
				decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["ls"] } },
			}),
		});
		emit({ id: 1106, method: "item/commandExecution/requestApproval", params: {} });
		await new Promise((r) => setTimeout(r, 0));
		const resp = sent.find((m) => m.id === 1106);
		expect(resp.result).toEqual({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["ls"] } } });
		expect(resp.error).toBeUndefined();
	});

	it("KILLING: a handler returning a schema-invalid NESTED user-input shape is rejected", async () => {
		const { client, sent, emit } = await startedClient({});
		client.onServerRequest({
			// answers values must be { answers: string[] }; a bare string is schema-invalid
			"item/tool/requestUserInput": (async () => ({ answers: { q1: "not-an-answer" } })) as never,
		});
		emit({ id: 1002, method: "item/tool/requestUserInput", params: {} });
		await new Promise((r) => setTimeout(r, 0));
		const resp = sent.find((m) => m.id === 1002);
		expect(resp.error, "deep-invalid answer shape must be rejected, not forwarded").toBeDefined();
		expect(resp.result).toBeUndefined();
	});

	it("isValidServerResult enforces each method's EXACT schema incl. nested + extra keys (unit)", () => {
		// command/file approval
		expect(isValidServerResult("item/commandExecution/requestApproval", { decision: "decline" })).toBe(true);
		expect(isValidServerResult("item/commandExecution/requestApproval", { decision: "approved" })).toBe(false); // wrong enum (review, not approval)
		expect(isValidServerResult("item/commandExecution/requestApproval", { decision: "decline", extra: 1 })).toBe(false); // extra key
		// file-change: strings ONLY — structured variants must be REJECTED (R6)
		expect(isValidServerResult("item/fileChange/requestApproval", { decision: "accept" })).toBe(true);
		expect(
			isValidServerResult("item/fileChange/requestApproval", {
				decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["ls"] } },
			}),
		).toBe(false); // file-change has no structured variant
		// exec/patch review
		expect(isValidServerResult("execCommandApproval", { decision: "denied" })).toBe(true);
		expect(isValidServerResult("execCommandApproval", { decision: "decline" })).toBe(false); // approval enum, not review
		// STRUCTURED variants with EXACT inner shape (R6: ExecPolicyAmendment=string[], NetworkPolicyAmendment={host,action})
		expect(
			isValidServerResult("execCommandApproval", { decision: { approved_execpolicy_amendment: { proposed_execpolicy_amendment: ["git", "log"] } } }),
		).toBe(true);
		expect(
			isValidServerResult("item/commandExecution/requestApproval", {
				decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "x.com", action: "allow" } } },
			}),
		).toBe(true);
		expect(
			isValidServerResult("item/commandExecution/requestApproval", {
				decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm"] } },
			}),
		).toBe(true);
		// R6 negatives: wrong inner types / missing required / extra keys / cross-method variant
		expect(isValidServerResult("execCommandApproval", { decision: { approved_execpolicy_amendment: { proposed_execpolicy_amendment: {} } } })).toBe(false); // object, not string[]
		expect(isValidServerResult("execCommandApproval", { decision: { approved_execpolicy_amendment: { proposed_execpolicy_amendment: [1] } } })).toBe(false); // non-string element
		expect(isValidServerResult("item/commandExecution/requestApproval", { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "x" } } } })).toBe(false); // missing action
		expect(isValidServerResult("item/commandExecution/requestApproval", { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "x", action: "maybe" } } } })).toBe(false); // bad action enum
		expect(isValidServerResult("item/commandExecution/requestApproval", { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "x", action: "allow", extra: 1 } } } })).toBe(false); // extra inner key
		// command variant used on exec/patch (cross-variant) must be rejected
		expect(isValidServerResult("execCommandApproval", { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["x"] } } })).toBe(false);
		expect(isValidServerResult("execCommandApproval", { decision: { bogus_amendment: {} } })).toBe(false); // unknown variant
		// non-JSON nested value must be rejected (can't round-trip on the wire)
		expect(isValidServerResult("mcpServer/elicitation/request", { action: "decline", content: { bad: undefined } })).toBe(false);
		// user-input: nested { answers: { [q]: { answers: string[] } } }
		expect(isValidServerResult("item/tool/requestUserInput", { answers: {} })).toBe(true);
		expect(isValidServerResult("item/tool/requestUserInput", { answers: { q: { answers: ["a"] } } })).toBe(true);
		expect(isValidServerResult("item/tool/requestUserInput", { answers: { q: "a" } })).toBe(false); // value not {answers:[]}
		expect(isValidServerResult("item/tool/requestUserInput", { answers: { q: { answers: [1] } } })).toBe(false); // non-string
		expect(isValidServerResult("item/tool/requestUserInput", { answers: { q: { answers: ["a"], x: 1 } } })).toBe(false); // extra nested key
		expect(isValidServerResult("item/tool/requestUserInput", { decision: "decline" })).toBe(false); // cross-method
		// elicitation
		expect(isValidServerResult("mcpServer/elicitation/request", { action: "decline" })).toBe(true);
		expect(isValidServerResult("mcpServer/elicitation/request", { action: "nope" })).toBe(false); // bad enum
		// never-methods
		expect(isValidServerResult("item/permissions/requestApproval", { permissions: {} })).toBe(false);
	});

	it("COMPILE negative controls: cross-method result / params are type errors", async () => {
		// @ts-expect-error — a user-input handler must not be allowed to return a command decision
		const badResult: ServerRequestHandlers = { "item/tool/requestUserInput": async () => ({ decision: "decline" }) };
		const badParams: ServerRequestHandlers = {
			"item/tool/requestUserInput": async (req) => {
				// @ts-expect-error — user-input params have no `command` field (that's a command-approval field)
				const _cmd: unknown = req.params.command;
				void _cmd;
				return { answers: {} };
			},
		};
		void badResult;
		void badParams;
	});
});

// P1#4 regression: transport death must settle everything, not hang.
// Runtime-verify P1 (jinglever, live-reproduced 3/3 on codex-cli 0.137.0): two concurrent
// injects on an idle thread both observed "no active turn" and both issued turn/start; the
// real app-server coalesced both messages into the FIRST turn, so the second caller's
// returned turnId was false. inject() is now serialized per thread.
describe("codex-client concurrent first-wake serialization (runtime-verify P1)", () => {
	const confirmingSteer: Handler = (req, emit) => {
		emit({
			method: "item/completed",
			params: {
				threadId: req.params.threadId,
				turnId: req.params.expectedTurnId,
				item: { type: "userMessage", clientId: req.params.clientUserMessageId, content: [] },
			},
		});
		return { result: {} };
	};

	it("KILLING: two concurrent injects on an idle thread → exactly ONE turn/start; the second STEERS the first turn and reports truthful ownership", async () => {
		const { client, sent } = await startedClient({ "turn/start": confirmingTurnStart(), "turn/steer": confirmingSteer });
		const threadId = await client.startThread();
		const [first, second] = await Promise.all([client.inject(threadId, "FIRST"), client.inject(threadId, "SECOND")]);
		expect(sent.filter((r) => r.method === "turn/start")).toHaveLength(1); // never two starts
		expect(sent.filter((r) => r.method === "turn/steer")).toHaveLength(1);
		expect(first).toEqual({ turnId: "turn_1", delivered: true, mode: "turn/start" });
		expect(second).toEqual({ turnId: "turn_1", delivered: true, mode: "turn/steer" }); // truthful owner, not a phantom turn
	});

	it("KILLING: a FAILING first inject does not wedge the thread's chain — the next inject still runs", async () => {
		let firstCall = true;
		const { client, sent } = await startedClient({
			"turn/start": (req, emit) => {
				if (firstCall) {
					firstCall = false;
					return { error: { code: -32000, message: "internal error" } };
				}
				return confirmingTurnStart()(req, emit);
			},
		});
		const threadId = await client.startThread();
		const results = await Promise.allSettled([client.inject(threadId, "boom"), client.inject(threadId, "after")]);
		expect(results[0].status).toBe("rejected");
		expect(results[1].status).toBe("fulfilled");
		expect((results[1] as PromiseFulfilledResult<{ delivered: boolean }>).value.delivered).toBe(true);
		expect(sent.filter((r) => r.method === "turn/start")).toHaveLength(2);
	});

	it("different threads are NOT serialized against each other (no cross-thread head-of-line blocking)", async () => {
		const starts: string[] = [];
		const { client } = await startedClient({
			"turn/start": (req, emit) => {
				starts.push(req.params.threadId);
				return confirmingTurnStart(req.params.threadId, `turn_${req.params.threadId}`)(req, emit);
			},
		});
		await Promise.all([client.inject("A", "a"), client.inject("B", "b")]);
		expect(starts.sort()).toEqual(["A", "B"]); // both started; neither waited on the other's chain
	});
});

// Runtime-verify P1 (jinglever): stderr was spawned with "ignore" — real app-server startup/auth/
// MCP diagnostics were silently discarded. It is now piped, continuously drained, and a bounded
// tail is attached to the exit reason.
describe("spawnAppServerTransport stderr retention (runtime-verify P1)", () => {
	// Fixtures exit via process.exitCode (NOT process.exit()): process.exit() truncates the
	// child's own unflushed pipe writes, which would test child truncation instead of whether
	// the ADAPTER waits for the full drain (the thing under test).
	it("KILLING: child stderr is drained (onStderrLine) and a bounded tail lands in the exit reason", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		const script = `process.stderr.write("ERROR model-cache parse failure\\nERROR MCP startup failed\\n"); process.exitCode = 7;`;
		const drained: string[] = [];
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script], onStderrLine: (l) => drained.push(l) });
		const reason = await new Promise<string>((resolve) => transport.onExit(resolve));
		expect(reason).toContain("code=7");
		expect(reason).toContain("stderr tail");
		expect(reason).toContain("ERROR model-cache parse failure");
		expect(reason).toContain("ERROR MCP startup failed");
		expect(drained).toEqual(["ERROR model-cache parse failure", "ERROR MCP startup failed"]);
	});

	it("KILLING (R9): a FATAL diagnostic WITHOUT a trailing newline is flushed exactly once, never lost in errBuf", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		const script = `process.stderr.write("FATAL startup diagnostic without newline"); process.exitCode = 7;`;
		const drained: string[] = [];
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script], onStderrLine: (l) => drained.push(l) });
		const reason = await new Promise<string>((resolve) => transport.onExit(resolve));
		expect(reason).toContain("FATAL startup diagnostic without newline");
		// exactly ONCE — the end/close double-fire must not flush the fragment twice
		expect(reason.split("FATAL startup diagnostic without newline")).toHaveLength(2);
		expect(drained).toEqual(["FATAL startup diagnostic without newline"]);
	});

	it("KILLING (R9): a single overlong newline-less chunk is ring-chunked with NO char loss/duplication and stays within 50×500", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		// 1800 chars, no newline: 0000000000111... (positional markers every 10 chars)
		const script = `let s = ""; for (let i = 0; i < 180; i++) s += String(i % 10).repeat(10); process.stderr.write(s); process.exitCode = 3;`;
		const drained: string[] = [];
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script], onStderrLine: (l) => drained.push(l) });
		const reason = await new Promise<string>((resolve) => transport.onExit(resolve));
		let expected = "";
		for (let i = 0; i < 180; i++) expected += String(i % 10).repeat(10);
		// no loss, no duplication: the drained chunks re-concatenate to the exact original bytes
		expect(drained.join("")).toBe(expected);
		for (const c of drained) expect(c.length).toBeLessThanOrEqual(500);
		expect(reason.split("\n").slice(1).join("\n")).toBe(drained.join("\n")); // tail = same chunks, bounded
	});

	it("KILLING (R10): a complete OVERLONG line (newline in the same event) is segmented LOSSLESSLY — chars 501+ must not be dropped", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		// 1800 chars with positional markers, then a newline in the same write.
		const script = `let s = ""; for (let i = 0; i < 180; i++) s += String(i % 10).repeat(10); process.stderr.write(s + "\\n"); process.exitCode = 2;`;
		const drained: string[] = [];
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script], onStderrLine: (l) => drained.push(l) });
		await new Promise<string>((resolve) => transport.onExit(resolve));
		let expected = "";
		for (let i = 0; i < 180; i++) expected += String(i % 10).repeat(10);
		expect(drained.join("")).toBe(expected); // full reassembly — the old code kept only the first 500
		expect(drained.length).toBe(4); // 500+500+500+300
		for (const seg of drained) expect(seg.length).toBeLessThanOrEqual(500);
	});

	it("KILLING (R10): an emoji straddling the 500-unit boundary is never split — every segment independently UTF-8 round-trips", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		// 499 ASCII + U+1F642 (surrogate pair, units 500-501) + 20 chars, newline-terminated.
		const script = `process.stderr.write("a".repeat(499) + "\\u{1F642}" + "b".repeat(20) + "\\n"); process.exitCode = 2;`;
		const drained: string[] = [];
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script], onStderrLine: (l) => drained.push(l) });
		const reason = await new Promise<string>((resolve) => transport.onExit(resolve));
		const expected = "a".repeat(499) + "\u{1F642}" + "b".repeat(20);
		expect(drained.join("")).toBe(expected); // exact character sequence, no loss/dup
		for (const seg of drained) {
			// each segment must independently survive a UTF-8 round-trip (a lone surrogate cannot)
			expect(Buffer.from(seg, "utf8").toString("utf8")).toBe(seg);
		}
		expect(reason).not.toContain("\uFFFD"); // the \n-joined tail carries no corrupted characters
	});

	it("KILLING (R11): whitespace segments inside a NON-blank logical line are preserved — 500 spaces + ERROR reassembles to all 505 chars", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		const script = `process.stderr.write(" ".repeat(500) + "ERROR" + "\\n"); process.exitCode = 2;`;
		const drained: string[] = [];
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script], onStderrLine: (l) => drained.push(l) });
		await new Promise<string>((resolve) => transport.onExit(resolve));
		expect(drained.join("")).toBe(" ".repeat(500) + "ERROR"); // 505 chars, spaces intact
	});

	it("KILLING (R11): the same 500-spaces+ERROR WITHOUT a newline (flush path) also reassembles losslessly", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		const script = `process.stderr.write(" ".repeat(500) + "ERROR"); process.exitCode = 2;`;
		const drained: string[] = [];
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script], onStderrLine: (l) => drained.push(l) });
		await new Promise<string>((resolve) => transport.onExit(resolve));
		expect(drained.join("")).toBe(" ".repeat(500) + "ERROR");
	});

	it("KILLING (R11): interior whitespace run (500 A + 500 spaces + Z) reassembles to all 1001 chars", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		const script = `process.stderr.write("A".repeat(500) + " ".repeat(500) + "Z" + "\\n"); process.exitCode = 2;`;
		const drained: string[] = [];
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script], onStderrLine: (l) => drained.push(l) });
		await new Promise<string>((resolve) => transport.onExit(resolve));
		expect(drained.join("")).toBe("A".repeat(500) + " ".repeat(500) + "Z");
	});

	it("(R11 control) a logical line that is ENTIRELY blank is still suppressed", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		const script = `process.stderr.write("   \\n\\nreal line\\n"); process.exitCode = 2;`;
		const drained: string[] = [];
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script], onStderrLine: (l) => drained.push(l) });
		await new Promise<string>((resolve) => transport.onExit(resolve));
		expect(drained).toEqual(["real line"]);
	});

	it("KILLING (R9): the exit reason is published only after stderr FULLY drains — ~4MB in flight at child death must not lose the final line", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		// 4MB keeps the kernel pipe saturated at death. Under the 'exit'-event mutant this lost
		// FINAL-MARKER-LINE 5/5 in a standalone-process probe (and R9's broad run reproduced the
		// race live); NOTE its killing power is scheduling-dependent — under vitest's worker
		// event loop the mutant can slip through. The by-construction guarantee is 'close'
		// semantics (fires only after all stdio streams end); this test is the live-shaped canary.
		const script = `const big = "y".repeat(1024*1024); for (let i = 0; i < 4; i++) process.stderr.write(big + "\\n"); process.stderr.write("FINAL-MARKER-LINE\\n"); process.exitCode = 5;`;
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script] });
		const reason = await new Promise<string>((resolve) => transport.onExit(resolve));
		expect(reason).toContain("code=5");
		expect(reason).toContain("FINAL-MARKER-LINE");
	});

	it("KILLING: multi-byte UTF-8 split across pipe chunks must not corrupt (200KB of CJK — 64KB chunk boundaries always land mid-character)", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		// 好 is 3 UTF-8 bytes; the 64KB pipe chunk size is not divisible by 3, so chunk
		// boundaries are GUARANTEED to split characters. Naive Buffer#toString injects U+FFFD.
		const script = `process.stderr.write("好".repeat(66666) + "\\n"); process.exitCode = 0;`;
		const drained: string[] = [];
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script], onStderrLine: (l) => drained.push(l) });
		await new Promise<string>((resolve) => transport.onExit(resolve));
		const joined = drained.join("");
		expect(joined).not.toContain("�"); // no replacement chars anywhere
		expect(joined).toBe("好".repeat(66666).slice(0, joined.length)); // pure 好 prefix (ring keeps the head chunks it saw)
		expect(joined.length).toBeGreaterThan(0);
	});

	it("KILLING (R9): rapid 120-line exit — tail deterministically keeps the LAST 50 lines (exit must not race the drain)", async () => {
		const { spawnAppServerTransport } = await import("../src/adapter/codex-client.js");
		const script = `for (let i = 0; i < 120; i++) process.stderr.write("line-" + i + "-" + "x".repeat(600) + "\\n"); process.exitCode = 1;`;
		const transport = spawnAppServerTransport(process.execPath, { args: ["-e", script] });
		const reason = await new Promise<string>((resolve) => transport.onExit(resolve));
		// Each ~608-char line segments losslessly into 2 ring entries (R10), so the 50-entry
		// ring holds exactly the last 25 complete lines: 95..119.
		expect(reason).not.toContain("line-94-"); // older than the ring window
		expect(reason).toContain("line-95-");
		expect(reason).toContain("line-119-");
		const entries = reason.split("\n").slice(1); // after the "app-server exited...; stderr tail:" line
		expect(entries).toHaveLength(50);
		expect(entries.filter((l) => l.startsWith("line-"))).toHaveLength(25); // 25 head segments + 25 continuations
		for (const l of entries) expect(l.length).toBeLessThanOrEqual(500);
	});
});

describe("codex-client transport failure convergence (P1#4)", () => {
	it("KILLING: app-server exit rejects in-flight inject instead of hanging forever", async () => {
		const { client, kill } = await startedClient({
			// turn/start never confirms delivery (no item/completed) — would hang without exit handling.
			"turn/start": () => ({ result: { turn: { id: "turn_1" } } }),
		});
		const threadId = await client.startThread();
		const injectP = client.inject(threadId, "will the server die?", { deliveryTimeoutMs: 60_000 });
		queueMicrotask(() => kill("app-server crashed"));
		const outcome = await injectP; // must resolve (delivered:false), not hang past the test timeout
		expect(outcome.delivered).toBe(false);
		expect(client.isConnected()).toBe(false);
	});

	it("RPC after disconnect returns an error rather than hanging", async () => {
		const { client, kill } = await startedClient({ "turn/start": confirmingTurnStart() });
		const threadId = await client.startThread();
		kill("gone");
		await expect(client.inject(threadId, "x")).rejects.toThrow(/disconnected/);
	});
});

// P2#2 regression: CAS recovery must write the recovered turn id back to per-thread state.
describe("codex-client CAS recovery state convergence (P2#2)", () => {
	it("KILLING: after steer CAS recovery, state = realId; next wake steers realId (no repeat CAS) and completion clears it", async () => {
		let firstStale = true;
		const { client, sent, emit } = await startedClient({
			"turn/start": confirmingTurnStart("T", "turn_1"),
			"turn/steer": (req, emit) => {
				// Only turn_2 is the real active id; the tracked turn_1 loses CAS once.
				if (req.params.expectedTurnId !== "turn_2" && firstStale) {
					firstStale = false;
					return { error: { code: -32600, message: "expected active turn id `turn_1` but found `turn_2`" } };
				}
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
		await client.inject("T", "first"); // opens turn_1, active
		await client.inject("T", "second"); // CAS loss → recover to turn_2
		// state must now be turn_2, NOT stale turn_1
		expect(client.activeTurnId("T")).toBe("turn_2");
		// next wake steers turn_2 directly (no CAS error this round)
		const beforeSteers = sent.filter((r) => r.method === "turn/steer").length;
		const outcome = await client.inject("T", "third");
		expect(outcome).toEqual({ turnId: "turn_2", delivered: true, mode: "turn/steer" });
		const thirdSteer = sent.filter((r) => r.method === "turn/steer").slice(beforeSteers);
		expect(thirdSteer.every((r) => r.params.expectedTurnId === "turn_2")).toBe(true);
		// REAL completion of the recovered turn_2 must clear the map — kills the cleanup mutation
		// (impossible when state wrongly stayed turn_1).
		emit({ method: "turn/completed", params: { threadId: "T", turn: { id: "turn_2" } } });
		await new Promise((r) => setTimeout(r, 0));
		expect(client.activeTurnId("T")).toBeNull();
		// after completion, the next wake starts a fresh turn (no stale steer)
		const outcome2 = await client.inject("T", "fourth");
		expect(outcome2.mode).toBe("turn/start");
	});
});

// P1#2 (steer error classification): only a confirmed "no active turn" may fall back to
// turn/start; a terminal/internal error must reject (never double-inject via a second turn).
describe("codex-client steer error classification (P1#2)", () => {
	it("classifySteerError requires -32600 + exact anchored message; everything else terminal (unit)", () => {
		expect(classifySteerError({ code: -32600, message: "expected active turn id `a` but found `b`" })).toBe("cas-retry");
		expect(classifySteerError({ code: -32600, message: "no active turn to steer" })).toBe("no-active-turn");
		// SPOOF: internal error whose message merely contains "no active turn" must NOT be trusted
		expect(classifySteerError({ code: -32000, message: "internal boom: no active turn cache is corrupt" })).toBe("terminal");
		// right-looking message but wrong code
		expect(classifySteerError({ code: -32000, message: "no active turn to steer" })).toBe("terminal");
		// -32600 but unanchored / trailing content → terminal (exact match only)
		expect(classifySteerError({ code: -32600, message: "no active turn to steer (retry later)" })).toBe("terminal");
		// timeout / disconnect
		expect(classifySteerError({ code: -2, message: "request turn/steer timed out" })).toBe("terminal");
		expect(classifySteerError({ code: -1, message: "transport disconnected" })).toBe("terminal");
	});

	it("KILLING: terminal steer error rejects and does NOT start a second turn (no double-inject)", async () => {
		let opened = false;
		const { client, sent } = await startedClient({
			"turn/start": (req, emit) => {
				if (!opened) {
					opened = true;
					emit({ method: "turn/started", params: { threadId: req.params.threadId, turn: { id: "turn_1" } } });
					emit({
						method: "item/completed",
						params: {
							threadId: req.params.threadId,
							turnId: "turn_1",
							item: { type: "userMessage", clientId: req.params.clientUserMessageId, content: [] },
						},
					});
					return { result: { turn: { id: "turn_1" } } };
				}
				return { result: { turn: { id: "turn_2" } } }; // would be the erroneous 2nd turn
			},
			"turn/steer": () => ({ error: { code: -32000, message: "internal boom" } }), // terminal, not "no active turn"
		});
		await client.inject("T", "first"); // opens turn_1
		const startsBefore = sent.filter((r) => r.method === "turn/start").length;
		await expect(client.inject("T", "second")).rejects.toThrow(/terminal, no fallback/);
		const startsAfter = sent.filter((r) => r.method === "turn/start").length;
		expect(startsAfter).toBe(startsBefore); // NO second turn/start — no double injection
		expect(client.pendingDeliveryCount()).toBe(0);
	});

	it("KILLING: real steer TIMEOUT rejects (no 2nd start, 0 waiters) and a late completion for the timed-out attempt confirms nothing", async () => {
		let opened = false;
		const steerClientIds: string[] = [];
		const { client, sent, emit } = await startedClient(
			{
				"turn/start": (req, emit) => {
					if (!opened) {
						opened = true;
						emit({ method: "turn/started", params: { threadId: req.params.threadId, turn: { id: "turn_1" } } });
						emit({
							method: "item/completed",
							params: {
								threadId: req.params.threadId,
								turnId: "turn_1",
								item: { type: "userMessage", clientId: req.params.clientUserMessageId, content: [] },
							},
						});
						return { result: { turn: { id: "turn_1" } } };
					}
					return { result: { turn: { id: "turn_bad" } } }; // an erroneous 2nd turn, must NOT happen
				},
				// first steer never responds → RPC times out (code -2) → terminal → reject;
				// later steers confirm normally.
				"turn/steer": (req, emit) => {
					steerClientIds.push(req.params.clientUserMessageId);
					if (steerClientIds.length === 1) return undefined; // timeout the first
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
			},
			{ requestTimeoutMs: 40 },
		);
		await client.inject("T", "first"); // opens turn_1
		const startsBefore = sent.filter((r) => r.method === "turn/start").length;
		await expect(client.inject("T", "second", { deliveryTimeoutMs: 500 })).rejects.toThrow(/terminal, no fallback/);
		expect(sent.filter((r) => r.method === "turn/start").length).toBe(startsBefore); // no 2nd start
		expect(client.pendingDeliveryCount()).toBe(0); // waiter cancelled on the terminal timeout

		// A LATE completion arrives for the timed-out steer attempt's client id — must confirm nothing.
		emit({
			method: "item/completed",
			params: {
				threadId: "T",
				turnId: "turn_1",
				item: { type: "userMessage", clientId: steerClientIds.at(-1), content: [] },
			},
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(client.pendingDeliveryCount()).toBe(0);

		// A subsequent legitimate wake is confirmed ONLY by its own new client id.
		const outcome = await client.inject("T", "third");
		expect(outcome.delivered).toBe(true);
		expect(outcome.mode).toBe("turn/steer"); // turn_1 still active → steer, its own completion confirms
	});
});

// P2#3 regression: terminal RPC failure must not leak the delivery waiter/timer.
describe("codex-client delivery waiter cleanup (P2#3)", () => {
	it("KILLING: immediate turn/start RPC error leaves 0 pending delivery waiters", async () => {
		const { client } = await startedClient({ "turn/start": () => ({ error: { code: -32000, message: "boom" } }) });
		await expect(client.inject("T", "x")).rejects.toThrow(/turn\/start failed/);
		expect(client.pendingDeliveryCount()).toBe(0);
	});

	it("KILLING: failed steer → failed start fallback leaves 0 pending delivery waiters", async () => {
		let opened = false;
		const { client } = await startedClient({
			"turn/start": (req, emit) => {
				if (!opened) {
					opened = true; // first inject opens turn_1
					emit({ method: "turn/started", params: { threadId: req.params.threadId, turn: { id: "turn_1" } } });
					emit({
						method: "item/completed",
						params: {
							threadId: req.params.threadId,
							turnId: "turn_1",
							item: { type: "userMessage", clientId: req.params.clientUserMessageId, content: [] },
						},
					});
					return { result: { turn: { id: "turn_1" } } };
				}
				return { error: { code: -32000, message: "start boom" } }; // fallback start fails
			},
			"turn/steer": () => ({ error: { code: -32600, message: "no active turn to steer" } }), // steer fails, no recoverable id
		});
		await client.inject("T", "first"); // opens turn_1
		await expect(client.inject("T", "second")).rejects.toThrow(/turn\/start failed/);
		expect(client.pendingDeliveryCount()).toBe(0);
	});

	it("KILLING: delivery timeout removes the waiter (no lingering entry)", async () => {
		const { client } = await startedClient({
			"turn/start": (req, emit) => {
				emit({ method: "turn/started", params: { threadId: req.params.threadId, turn: { id: "turn_1" } } });
				return { result: { turn: { id: "turn_1" } } }; // no item/completed → delivery times out
			},
		});
		const outcome = await client.inject("T", "x", { deliveryTimeoutMs: 30 });
		expect(outcome.delivered).toBe(false);
		expect(client.pendingDeliveryCount()).toBe(0);
	});
});

describe("injectWake ok:true gate (truly-delivered invariant)", () => {
	it("returns ok:true only after item/completed confirmation", async () => {
		const { client } = await startedClient({ "turn/start": confirmingTurnStart() });
		const threadId = await client.startThread();
		const resp = await injectWake(client, threadId, WAKE);
		expect(resp).toEqual({ ok: true, runtimeSession: threadId });
	});

	it("KILLING: RPC success WITHOUT item/completed must NOT be ok:true", async () => {
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
		const { client } = await startedClient({ "turn/start": () => ({ error: { code: -32000, message: "boom" } }) });
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

	it("classifyFailure maps concrete causes; defaults to runtime_error (never silently ok)", () => {
		expect(classifyFailure(new Error("transport disconnected: app-server exited"))).toBe("runtime_error");
		expect(classifyFailure(new Error("request turn/steer timed out"))).toBe("inject_failed");
		expect(classifyFailure(new Error("no active turn to steer"))).toBe("no_active_turn");
		expect(classifyFailure(new Error("thread already has an active turn"))).toBe("runtime_busy");
		expect(classifyFailure({ httpStatusCode: 401, message: "Unauthorized" })).toBe("runtime_error");
		expect(classifyFailure(new Error("something weird"))).toBe("runtime_error"); // default, retryable
	});

	it("isAuthTerminal flags 401 / unauthorized (terminal, no retry)", () => {
		expect(isAuthTerminal({ httpStatusCode: 401, message: "x" })).toBe(true);
		expect(isAuthTerminal(new Error("Missing bearer or basic authentication"))).toBe(true);
		expect(isAuthTerminal(new Error("no active turn to steer"))).toBe(false);
	});

	it("isRetryable/retryAfterMs: retryable classes carry a backoff", () => {
		for (const fc of ["no_active_turn", "runtime_busy", "inject_failed", "runtime_error", "unknown"] as const) {
			expect(isRetryable(fc)).toBe(true);
			expect(typeof retryAfterMs(fc)).toBe("number");
		}
	});
});
