// codex app-server JSON-RPC client (carrier layer).
// Protocol facts are spike-validated against codex-cli 0.136.0 — see docs/p0-spike-findings.md:
// transport = JSONL over stdio child process (`--listen ws` does not exist in 0.136.0);
// no-turn wake = turn/start; active-turn wake = turn/steer (CAS on expectedTurnId, the
// error message carries the real active id); delivered-confirmation = item/completed of
// the injected userMessage (matched via clientUserMessageId); agentMessage payload is
// `item.text` (NOT item.content[]) — see the PONG round-trip in the spike doc.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

/** Line-oriented JSON-RPC transport; real = child process stdio, tests = fake. */
export interface Transport {
	send(line: string): void;
	onLine(cb: (line: string) => void): void;
	/** Fires on child exit/spawn-error; message is a human-readable cause. */
	onExit(cb: (reason: string) => void): void;
	close(): void;
}

/** Bounded stderr retention (runtime-verify P1: stderr must never be silently discarded). */
const STDERR_TAIL_MAX_LINES = 50;
const STDERR_LINE_MAX_CHARS = 500;

export interface SpawnTransportOpts {
	/** Override argv (tests point codexBin at `node` + a fixture script). Default: ["app-server"]. */
	args?: string[];
	/** Continuous drain hook — called once per stderr line (bounded length), e.g. a logger. */
	onStderrLine?: (line: string) => void;
}

export function spawnAppServerTransport(codexBin = "codex", opts?: SpawnTransportOpts): Transport {
	// stderr is PIPED and continuously drained (never "ignore"): the real app-server emits
	// startup/auth/MCP diagnostics there, and a bounded tail is attached to the exit reason so
	// a failed deployment keeps the evidence needed to diagnose it.
	const child = spawn(codexBin, opts?.args ?? ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
	const lineCbs: Array<(line: string) => void> = [];
	const exitCbs: Array<(reason: string) => void> = [];
	const stderrTail: string[] = [];
	let ended = false;
	const withTail = (reason: string) => (stderrTail.length ? `${reason}; stderr tail:\n${stderrTail.join("\n")}` : reason);
	const fireExit = (reason: string) => {
		if (ended) return;
		ended = true;
		for (const cb of exitCbs) cb(withTail(reason));
	};
	// StringDecoder on BOTH stdio paths: a multi-byte UTF-8 character can be split across
	// pipe chunks, and Buffer#toString on a partial sequence injects U+FFFD — on stdout that
	// corrupts a JSON-RPC line carrying CJK/emoji content (parse failure → dropped message),
	// on stderr it corrupts diagnostics. The decoder carries the partial sequence across chunks.
	const outDecoder = new StringDecoder("utf8");
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += outDecoder.write(d);
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (line.trim()) for (const cb of lineCbs) cb(line);
		}
	});
	// R9 P1 fix — three drain guarantees:
	//   (1) the in-progress fragment is BOUNDED: newline-less output is chunked into the ring
	//       at STDERR_LINE_MAX_CHARS, so errBuf can never grow past one line-limit;
	//   (2) the final un-newlined fragment (the classic fatal startup diagnostic) is FLUSHED
	//       when stderr ends — it must never die in errBuf;
	//   (3) the exit reason is published only AFTER stderr fully drains: the child "close"
	//       event fires once all stdio streams have ended ("exit" can race ahead of late data).
	const errDecoder = new StringDecoder("utf8");
	let errBuf = "";
	const pushStderrLine = (line: string) => {
		if (!line.trim()) return;
		stderrTail.push(line);
		if (stderrTail.length > STDERR_TAIL_MAX_LINES) stderrTail.shift();
		opts?.onStderrLine?.(line);
	};
	// R10 P1 fix — ONE lossless bounded segmenter for every path (complete newline-terminated
	// lines, the in-progress fragment, and the final flush): a segment boundary never lands
	// inside a surrogate pair (cut one unit earlier when it would strand a high surrogate), so
	// every segment independently UTF-8 round-trips; segments concatenate back to the exact
	// original character sequence (no truncation — the old code dropped chars 501..\n of a
	// complete overlong line, and could split an emoji at UTF-16 index 500).
	function pushSegmented(s: string) {
		let i = 0;
		while (i < s.length) {
			let end = Math.min(i + STDERR_LINE_MAX_CHARS, s.length);
			if (end < s.length) {
				const c = s.charCodeAt(end - 1);
				if (c >= 0xd800 && c <= 0xdbff) end -= 1; // never strand a high surrogate at the cut
			}
			pushStderrLine(s.slice(i, end));
			i = end;
		}
	}
	child.stderr?.on("data", (d) => {
		errBuf += errDecoder.write(d);
		let i: number;
		while ((i = errBuf.indexOf("\n")) >= 0) {
			pushSegmented(errBuf.slice(0, i));
			errBuf = errBuf.slice(i + 1);
		}
		// Bound the in-progress fragment: drain full segments, keep the (<= one-limit) tail.
		while (errBuf.length > STDERR_LINE_MAX_CHARS) {
			let end = STDERR_LINE_MAX_CHARS;
			const c = errBuf.charCodeAt(end - 1);
			if (c >= 0xd800 && c <= 0xdbff) end -= 1;
			pushStderrLine(errBuf.slice(0, end));
			errBuf = errBuf.slice(end);
		}
	});
	const flushStderrFragment = () => {
		errBuf += errDecoder.end(); // any trailing partial sequence resolves here
		const rest = errBuf;
		errBuf = "";
		if (rest.trim()) pushSegmented(rest);
	};
	child.stderr?.on("end", flushStderrFragment);
	child.stderr?.on("close", flushStderrFragment);
	child.on("error", (err) => fireExit(`spawn error: ${String(err)}`));
	child.on("close", (code, signal) => fireExit(`app-server exited (code=${code}, signal=${signal})`));
	return {
		send: (line) => {
			try {
				child.stdin.write(line + "\n");
			} catch {
				/* transport already ended */
			}
		},
		onLine: (cb) => lineCbs.push(cb),
		onExit: (cb) => exitCbs.push(cb),
		close: () => child.kill(),
	};
}

export interface AgentMessageEvent {
	threadId: string;
	turnId: string;
	text: string;
}
export interface CodexErrorEvent {
	threadId?: string;
	turnId?: string;
	message: string;
	willRetry?: boolean;
	httpStatusCode?: number;
}

// ── Server → client requests (app-server asks the client), per codex 0.136.0 schema.
// Each method has a method-specific response contract; there is no single generic shape.
// A registered handler (per-method map) returns that method's EXACT result type — a
// cross-method result is a compile error and is also rejected at runtime. With no handler
// for a method we apply a NON-INTERACTIVE policy: schema-shaped DENY where a decline exists,
// else fail closed. It NEVER approves anything.
// Decision types mirror the pinned Codex stable schema (0.136.0 / 0.144.3) EXACTLY:
// ExecPolicyAmendment = string[]; NetworkPolicyAmendment = {host, action}; structured amendment
// variants belong ONLY to command approval + exec/patch review — file-change is strings only.
export type ExecPolicyAmendment = string[];
export type NetworkPolicyRuleAction = "allow" | "deny";
export type NetworkPolicyAmendment = { host: string; action: NetworkPolicyRuleAction };
/** `item/commandExecution/requestApproval` decision (v2 CommandExecutionApprovalDecision). */
export type CommandExecutionApprovalDecision =
	| "accept"
	| "acceptForSession"
	| { acceptWithExecpolicyAmendment: { execpolicy_amendment: ExecPolicyAmendment } }
	| { applyNetworkPolicyAmendment: { network_policy_amendment: NetworkPolicyAmendment } }
	| "decline"
	| "cancel";
/** `item/fileChange/requestApproval` decision — strings only, NO structured variants. */
export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
/** `execCommandApproval` / `applyPatchApproval` decision (ReviewDecision). */
export type ReviewDecision =
	| "approved"
	| { approved_execpolicy_amendment: { proposed_execpolicy_amendment: ExecPolicyAmendment } }
	| "approved_for_session"
	| { network_policy_amendment: { network_policy_amendment: NetworkPolicyAmendment } }
	| "denied"
	| "timed_out"
	| "abort";
export type ElicitationAction = "accept" | "decline" | "cancel";

/** JSON value — the only shapes that can round-trip on the wire (no function/symbol/undefined). */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** One user-input question's answer, per ToolRequestUserInputAnswer schema. */
export interface UserInputAnswer {
	answers: string[];
}

/**
 * Exhaustive map of every server→client request method (codex 0.136.0 / 0.144.3 schema) to
 * its response-result type. `never` = no safe non-interactive result exists → must fail closed.
 */
export interface ServerRequestResultMap {
	"item/commandExecution/requestApproval": { decision: CommandExecutionApprovalDecision };
	"item/fileChange/requestApproval": { decision: FileChangeApprovalDecision };
	execCommandApproval: { decision: ReviewDecision };
	applyPatchApproval: { decision: ReviewDecision };
	"item/tool/requestUserInput": { answers: Record<string, UserInputAnswer> };
	"mcpServer/elicitation/request": { action: ElicitationAction; content?: unknown; _meta?: unknown };
	"item/permissions/requestApproval": never;
	"item/tool/call": never;
	"account/chatgptAuthTokens/refresh": never;
	"attestation/generate": never;
}
export type ServerRequestMethod = keyof ServerRequestResultMap;

/**
 * Per-method request params (subset of fields we surface; faithful to the pinned schema's
 * required fields so a handler can't read a cross-method field like `command` off a user-input
 * request). `unknown` for methods with no safe non-interactive handler.
 */
export interface ServerRequestParamsMap {
	"item/commandExecution/requestApproval": {
		turnId: string;
		threadId: string;
		itemId: string;
		startedAtMs: number;
		command?: string | null;
		approvalId?: string | null;
	};
	"item/fileChange/requestApproval": {
		itemId: string;
		threadId: string;
		turnId: string;
		startedAtMs: number;
		reason?: string | null;
	};
	execCommandApproval: { callId: string; command: string[]; conversationId: string; cwd: string; parsedCmd: unknown[] };
	applyPatchApproval: { callId: string; conversationId: string; fileChanges: Record<string, unknown> };
	"item/tool/requestUserInput": { itemId: string; questions: unknown[]; threadId: string; turnId: string };
	"mcpServer/elicitation/request": { serverName: string; threadId: string; turnId?: string | null };
	"item/permissions/requestApproval": unknown;
	"item/tool/call": unknown;
	"account/chatgptAuthTokens/refresh": unknown;
	"attestation/generate": unknown;
}

/** Discriminated server→client request: `params` is typed per `method`. */
export type ServerRequest<M extends ServerRequestMethod = ServerRequestMethod> = {
	[K in ServerRequestMethod]: { id: number | string; method: K; params: ServerRequestParamsMap[K] };
}[M];

/**
 * Per-method handler map: a handler for method M receives M's typed request and can ONLY return
 * M's exact result type — a cross-method params read or result return fails to compile. Methods
 * whose result is `never` cannot be answered non-interactively (fail closed by omission).
 */
export type ServerRequestHandlers = {
	[M in ServerRequestMethod]?: (req: ServerRequest<M>) => Promise<ServerRequestResultMap[M]>;
};

const COMMAND_DECISION_STRINGS: ReadonlySet<string> = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const FILECHANGE_DECISION_STRINGS: ReadonlySet<string> = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const REVIEW_DECISION_STRINGS: ReadonlySet<string> = new Set(["approved", "approved_for_session", "denied", "timed_out", "abort"]);
const ELICITATION_ACTIONS: ReadonlySet<string> = new Set(["accept", "decline", "cancel"]);
const NETWORK_POLICY_ACTIONS: ReadonlySet<string> = new Set(["allow", "deny"]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** True iff `obj`'s keys are all within `allowed` (rejects extra / cross-method fields). */
const onlyKeys = (obj: Record<string, unknown>, allowed: readonly string[]) => Object.keys(obj).every((k) => allowed.includes(k));

/** ExecPolicyAmendment = string[]. */
const isExecPolicyAmendment = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === "string");
/** NetworkPolicyAmendment = exactly { host: string, action: "allow"|"deny" }. */
const isNetworkPolicyAmendment = (v: unknown): boolean =>
	isObj(v) && onlyKeys(v, ["host", "action"]) && typeof v.host === "string" && typeof v.action === "string" && NETWORK_POLICY_ACTIONS.has(v.action);
/** A wrapper object `{ [wrapperKey]: { [innerKey]: <inner> } }` with exact single keys. */
function isAmendmentWrapper(d: Record<string, unknown>, wrapperKey: string, innerKey: string, innerOk: (v: unknown) => boolean): boolean {
	if (!onlyKeys(d, [wrapperKey])) return false;
	const inner = d[wrapperKey];
	return isObj(inner) && onlyKeys(inner, [innerKey]) && innerOk(inner[innerKey]);
}

/** True iff `v` is a pure JSON value (rejects function/symbol/undefined/bigint anywhere nested). */
export function isJsonValue(v: unknown): boolean {
	if (v === null) return true;
	switch (typeof v) {
		case "boolean":
		case "string":
			return true;
		case "number":
			return Number.isFinite(v);
		case "object":
			if (Array.isArray(v)) return v.every(isJsonValue);
			return Object.values(v as Record<string, unknown>).every(isJsonValue);
		default:
			return false; // function / symbol / undefined / bigint
	}
}

/** command approval: strings OR the two exact command structured variants. */
function isValidCommandDecision(d: unknown): boolean {
	if (typeof d === "string") return COMMAND_DECISION_STRINGS.has(d);
	if (!isObj(d)) return false;
	return (
		isAmendmentWrapper(d, "acceptWithExecpolicyAmendment", "execpolicy_amendment", isExecPolicyAmendment) ||
		isAmendmentWrapper(d, "applyNetworkPolicyAmendment", "network_policy_amendment", isNetworkPolicyAmendment)
	);
}
/** exec/patch review: strings OR the two exact review structured variants. */
function isValidReviewDecision(d: unknown): boolean {
	if (typeof d === "string") return REVIEW_DECISION_STRINGS.has(d);
	if (!isObj(d)) return false;
	return (
		isAmendmentWrapper(d, "approved_execpolicy_amendment", "proposed_execpolicy_amendment", isExecPolicyAmendment) ||
		isAmendmentWrapper(d, "network_policy_amendment", "network_policy_amendment", isNetworkPolicyAmendment)
	);
}

/**
 * Runtime guard: does `result` EXACTLY match `method`'s schema (valid enum OR the method's exact
 * structured amendment variant with exact inner shape — ExecPolicyAmendment=string[],
 * NetworkPolicyAmendment={host,action∈{allow,deny}} — no extra/cross-method keys, and every
 * nested value a pure JSON value)? file-change has NO structured variants. Defends against
 * any-cast / JS callers that bypass compile-time typing. Anything not matching → fail closed.
 */
export function isValidServerResult(method: string, result: unknown): boolean {
	if (!isObj(result) || !isJsonValue(result)) return false;
	const r = result;
	switch (method) {
		case "item/commandExecution/requestApproval":
			return onlyKeys(r, ["decision"]) && isValidCommandDecision(r.decision);
		case "item/fileChange/requestApproval":
			return onlyKeys(r, ["decision"]) && typeof r.decision === "string" && FILECHANGE_DECISION_STRINGS.has(r.decision);
		case "execCommandApproval":
		case "applyPatchApproval":
			return onlyKeys(r, ["decision"]) && isValidReviewDecision(r.decision);
		case "item/tool/requestUserInput": {
			if (!onlyKeys(r, ["answers"]) || !isObj(r.answers)) return false;
			// each answer must be exactly { answers: string[] }
			return Object.values(r.answers).every(
				(a) => isObj(a) && onlyKeys(a, ["answers"]) && Array.isArray(a.answers) && a.answers.every((s) => typeof s === "string"),
			);
		}
		case "mcpServer/elicitation/request":
			return onlyKeys(r, ["action", "content", "_meta"]) && typeof r.action === "string" && ELICITATION_ACTIONS.has(r.action);
		default:
			return false; // never-methods have no valid result
	}
}

/**
 * Non-interactive default: return a schema-shaped DENY for methods where one exists so the
 * turn proceeds (denied) instead of hanging; fail closed (JSON-RPC error) for methods with no
 * safe automatic response (granting permissions, running a tool, token refresh, attestation).
 * Never approves.
 */
export function defaultServerRequestResponse(method: string): { result: object } | { error: { code: number; message: string } } {
	switch (method) {
		case "item/commandExecution/requestApproval":
		case "item/fileChange/requestApproval":
			return { result: { decision: "decline" } };
		case "execCommandApproval":
		case "applyPatchApproval":
			return { result: { decision: "denied" } };
		case "item/tool/requestUserInput":
			return { result: { answers: {} } };
		case "mcpServer/elicitation/request":
			return { result: { action: "decline" } };
		default:
			// permissions grant / tool call / token refresh / attestation / unknown:
			// no safe non-interactive shape → fail closed, never approve.
			return { error: { code: -32601, message: `server request ${method} not supported non-interactively; denied` } };
	}
}

/**
 * Classify a turn/steer error: only a schema/runtime-confirmed "no active turn" is safe to
 * fall back to turn/start (nothing was injected); a CAS mismatch carries the real id to retry;
 * anything else (internal error, RPC timeout) is TERMINAL — must reject, never start a second
 * turn (that would double-inject the same wake).
 */
export function classifySteerError(err: { code?: number; message: string }): "cas-retry" | "no-active-turn" | "terminal" {
	// Only the app-server's exact -32600 CAS/no-turn errors are safe to act on. Any other code
	// (internal -32000, RPC timeout -2, disconnect -1, unknown) or an unanchored message that
	// merely *contains* "no active turn" is TERMINAL — never a second-turn fallback (double-inject).
	if (err.code !== -32600) return "terminal";
	const m = err.message || "";
	if (/^expected active turn id `[^`]+` but found `[^`]+`$/.test(m)) return "cas-retry";
	if (m === "no active turn to steer") return "no-active-turn";
	return "terminal";
}

export interface InjectOutcome {
	turnId: string;
	/** true once the injected userMessage's item/completed arrived (ok:true gate). */
	delivered: boolean;
	mode: "turn/start" | "turn/steer";
}

export interface CodexClient {
	start(): Promise<void>;
	stop(): void;
	startThread(opts?: { cwd?: string; ephemeral?: boolean }): Promise<string>;
	/** Active turn id for a thread, or null. */
	activeTurnId(threadId: string): string | null;
	/**
	 * Wake path: steer the thread's active turn if one exists, else start a new turn.
	 * `delivered` flips true only after the injected message is confirmed in
	 * model-visible history (item/completed with our clientUserMessageId) —
	 * the ok:true gate (invariants.ts). Rejects if the transport disconnects; any
	 * terminal failure cancels the delivery waiter (no leaked timers).
	 */
	inject(threadId: string, text: string, opts?: { deliveryTimeoutMs?: number }): Promise<InjectOutcome>;
	/** Context-only append (no turn started); items are raw Responses API shapes. */
	injectItems(threadId: string, items: unknown[]): Promise<void>;
	onAgentMessage(cb: (e: AgentMessageEvent) => void): void;
	onTurnCompleted(cb: (e: { threadId: string; turnId: string }) => void): void;
	onError(cb: (e: CodexErrorEvent) => void): void;
	/**
	 * Register per-method handlers for app-server→client requests (approvals, tool input…).
	 * Each handler is constrained to its method's exact result type (cross-method returns are a
	 * compile error and are rejected at runtime). Methods with no registered handler fall back to
	 * the non-interactive default policy (DENY / fail closed); a request is never silently ignored
	 * or auto-approved.
	 */
	onServerRequest(handlers: ServerRequestHandlers): void;
	/** True until the transport disconnects. */
	isConnected(): boolean;
	/** Observability (P2): outstanding delivery waiters — asserted 0 after terminal failures. */
	pendingDeliveryCount(): number;
}

interface JsonRpcResponse {
	id: number;
	result?: any;
	error?: { code: number; message: string };
}

const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Parse the real active turn id out of a turn/steer CAS failure message. */
export function activeTurnIdFromSteerError(message: string): string | null {
	const m = /but found `([^`]+)`/.exec(message);
	return m ? m[1] : null;
}

export function createCodexClient(transport: Transport, opts?: { requestTimeoutMs?: number }): CodexClient {
	const requestTimeoutMs = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	let nextId = 0;
	const pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; timer: ReturnType<typeof setTimeout> }>();
	// P1#2 fix: turn state is per-thread, not a single global scalar.
	const activeTurns = new Map<string, string>();
	// clientUserMessageId -> { resolve, timer }
	const awaitingDelivery = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
	const agentMessageCbs: Array<(e: AgentMessageEvent) => void> = [];
	const turnCompletedCbs: Array<(e: { threadId: string; turnId: string }) => void> = [];
	const errorCbs: Array<(e: CodexErrorEvent) => void> = [];
	let serverRequestHandlers: ServerRequestHandlers = {};
	let connected = true;

	function request(method: string, params: unknown): Promise<JsonRpcResponse> {
		if (!connected) return Promise.resolve({ id: -1, error: { code: -1, message: "transport disconnected" } });
		const id = ++nextId;
		transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return new Promise((resolve) => {
			// P1#4 fix: bound every RPC so a dead app-server can't leave it pending forever.
			const timer = setTimeout(() => {
				if (pending.delete(id)) resolve({ id, error: { code: -2, message: `request ${method} timed out` } });
			}, requestTimeoutMs);
			pending.set(id, { resolve, timer });
		});
	}

	// P1#4 fix: on disconnect, settle every waiter instead of hanging.
	transport.onExit((reason) => {
		connected = false;
		for (const { resolve, timer } of pending.values()) {
			clearTimeout(timer);
			resolve({ id: -1, error: { code: -1, message: `transport disconnected: ${reason}` } });
		}
		pending.clear();
		for (const { resolve, timer } of awaitingDelivery.values()) {
			clearTimeout(timer);
			resolve(false);
		}
		awaitingDelivery.clear();
	});

	function respond(id: number | string, body: object) {
		transport.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
	}

	// R7 fix: validate the WIRE value, not the live JS object. A live object can pass the
	// guard yet serialize to something schema-invalid: sparse arrays (`new Array(1)` — every()
	// skips holes but stringify emits null), inherited required props (`Object.create({...})` —
	// prototype reads pass, stringify drops them to {}), and toJSON/getter re-serialization
	// drift. Canonicalize ONCE: stringify the full envelope, re-parse, validate the re-parsed
	// result, and send exactly the bytes that were validated. stringify throw / undefined /
	// re-parse failure all fail closed (-32603), never a silently-drifted response.
	function respondWithValidatedResult(id: number | string, method: string, result: unknown) {
		let wire: string | undefined;
		try {
			wire = JSON.stringify({ jsonrpc: "2.0", id, result });
		} catch {
			wire = undefined; // circular / bigint: not serializable
		}
		if (wire !== undefined) {
			let parsed: { result?: unknown } | undefined;
			try {
				parsed = JSON.parse(wire);
			} catch {
				parsed = undefined;
			}
			if (parsed && isValidServerResult(method, parsed.result)) {
				transport.send(wire); // the exact bytes the guard approved
				return;
			}
		}
		respond(id, {
			error: { code: -32603, message: `handler returned invalid result shape for ${method}` },
		});
	}

	transport.onLine((line) => {
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		// response to one of our requests
		if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
			const entry = pending.get(msg.id);
			if (entry) {
				clearTimeout(entry.timer);
				pending.delete(msg.id);
				entry.resolve(msg);
			}
			return;
		}
		// P1#3 fix: app-server → client request (has id AND method) — must be answered.
		if (msg.id !== undefined && typeof msg.method === "string") {
			const method = msg.method as ServerRequestMethod;
			const handler = serverRequestHandlers[method] as
				| ((req: ServerRequest) => Promise<unknown>)
				| undefined;
			if (!handler) {
				// No handler for this method → non-interactive default (schema-shaped DENY / fail closed).
				respond(msg.id, defaultServerRequestResponse(method));
				return;
			}
			handler({ id: msg.id, method, params: msg.params } as ServerRequest)
				.then((result) => {
					// Runtime guard: never forward a shape Codex can't decode, even if a JS/any-cast
					// caller bypassed the compile-time per-method typing. Validation runs on the
					// canonicalized wire form (R7): what is checked is exactly what is sent.
					respondWithValidatedResult(msg.id, method, result);
				})
				.catch((err) => respond(msg.id, { error: { code: -32000, message: `handler error: ${String(err)}` } }));
			return;
		}
		switch (msg.method) {
			case "turn/started": {
				const tid = msg.params?.threadId;
				const turnId = msg.params?.turn?.id;
				if (tid && turnId) activeTurns.set(tid, turnId);
				break;
			}
			case "turn/completed": {
				const tid = msg.params?.threadId;
				const turnId = msg.params?.turn?.id;
				if (tid && activeTurns.get(tid) === turnId) activeTurns.delete(tid);
				for (const cb of turnCompletedCbs) cb({ threadId: tid, turnId });
				break;
			}
			case "item/completed": {
				const item = msg.params?.item;
				if (item?.type === "userMessage" && item.clientId && awaitingDelivery.has(item.clientId)) {
					const entry = awaitingDelivery.get(item.clientId)!;
					clearTimeout(entry.timer);
					awaitingDelivery.delete(item.clientId);
					entry.resolve(true);
				} else if (item?.type === "agentMessage") {
					// P1#1 fix: payload is item.text, not item.content[].
					const text = typeof item.text === "string" ? item.text : "";
					for (const cb of agentMessageCbs) {
						cb({ threadId: msg.params?.threadId, turnId: msg.params?.turnId, text });
					}
				}
				break;
			}
			case "error": {
				const e = msg.params?.error ?? {};
				for (const cb of errorCbs) {
					cb({
						threadId: msg.params?.threadId,
						turnId: msg.params?.turnId,
						message: e.message ?? "unknown",
						willRetry: msg.params?.willRetry,
						httpStatusCode: e.codexErrorInfo?.responseStreamDisconnected?.httpStatusCode,
					});
				}
				break;
			}
		}
	});

	// Delivery waiter tied to a single injection attempt; cancel() clears the timer + map
	// entry so a terminal RPC failure (P2#3) can't leak it until the delivery deadline.
	function createDeliveryWaiter(clientId: string, timeoutMs: number) {
		if (!connected) return { promise: Promise.resolve(false), cancel: () => {} };
		let settle: (ok: boolean) => void;
		const promise = new Promise<boolean>((resolve) => {
			settle = resolve;
			const timer = setTimeout(() => {
				awaitingDelivery.delete(clientId);
				resolve(false);
			}, timeoutMs);
			awaitingDelivery.set(clientId, { resolve, timer });
		});
		const cancel = () => {
			const entry = awaitingDelivery.get(clientId);
			if (entry) {
				clearTimeout(entry.timer);
				awaitingDelivery.delete(clientId);
				settle(false);
			}
		};
		return { promise, cancel };
	}

	// Per-thread inject serialization chain — runtime-verify P1 fix (live-reproduced 3/3 by
	// jinglever on codex-cli 0.137.0): two concurrent injects on an idle thread could both read
	// "no active turn" and both turn/start; the app-server coalesces both messages into the
	// FIRST turn, so the second caller's returned turnId is false. Serializing per thread means
	// the second wake runs after the first settles, observes its turn, and steers it truthfully.
	const injectChains = new Map<string, Promise<unknown>>();

	async function doInject(threadId: string, text: string, opts?: { deliveryTimeoutMs?: number }): Promise<InjectOutcome> {
		if (!connected) throw new Error("cannot inject: transport disconnected");
		const clientUserMessageId = randomUUID();
		const input = [{ type: "text", text }];
		const timeoutMs = opts?.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
		const waiter = createDeliveryWaiter(clientUserMessageId, timeoutMs);

		try {
			const startTurn = async (): Promise<InjectOutcome> => {
				const resp = await request("turn/start", { threadId, input, clientUserMessageId });
				if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
				const turnId = resp.result?.turn?.id;
				if (typeof turnId !== "string") throw new Error("turn/start returned an unexpected response shape (no turn id)");
				activeTurns.set(threadId, turnId);
				return { turnId, delivered: await waiter.promise, mode: "turn/start" };
			};

			const expected = activeTurns.get(threadId);
			if (!expected) return await startTurn();

			let resp = await request("turn/steer", { threadId, expectedTurnId: expected, input, clientUserMessageId });
			if (resp.error) {
				// P1#2 fix: classify the steer error — do NOT blindly fall back to turn/start,
				// which would double-inject on a terminal/timeout error whose steer may still land.
				const kind = classifySteerError(resp.error);
				if (kind === "cas-retry") {
					const realId = activeTurnIdFromSteerError(resp.error.message);
					if (!realId) throw new Error(`turn/steer CAS error without a recoverable id: ${resp.error.message}`);
					resp = await request("turn/steer", { threadId, expectedTurnId: realId, input, clientUserMessageId });
					if (!resp.error) {
						// P2#2 fix: write back the recovered id so the next wake steers it and
						// turn/completed(realId) can clear it.
						activeTurns.set(threadId, realId);
						return { turnId: realId, delivered: await waiter.promise, mode: "turn/steer" };
					}
					// second steer failed: only fall back if it now confirms no active turn.
					if (classifySteerError(resp.error) === "no-active-turn") {
						activeTurns.delete(threadId);
						return await startTurn();
					}
					throw new Error(`turn/steer retry failed: ${resp.error.message}`);
				}
				if (kind === "no-active-turn") {
					// Confirmed no active turn: nothing was injected, safe to start fresh (reuse id ok).
					activeTurns.delete(threadId);
					return await startTurn();
				}
				// Terminal (internal error / RPC timeout): the steer may or may not have landed —
				// never start a second turn (double-inject risk). Reject; the catch cancels the waiter.
				throw new Error(`turn/steer failed (terminal, no fallback): ${resp.error.message}`);
			}
			return { turnId: expected, delivered: await waiter.promise, mode: "turn/steer" };
		} catch (err) {
			// P2#3 fix: terminal failure must not leave the delivery waiter/timer behind.
			waiter.cancel();
			throw err;
		}
	}

	return {
		async start() {
			const resp = await request("initialize", { clientInfo: { name: "codex-openmax", version: "0.0.0" } });
			if (resp.error) throw new Error(`initialize failed: ${resp.error.message}`);
			transport.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
		},
		stop() {
			transport.close();
		},
		async startThread(opts) {
			const resp = await request("thread/start", { cwd: opts?.cwd, ephemeral: opts?.ephemeral ?? false });
			if (resp.error) throw new Error(`thread/start failed: ${resp.error.message}`);
			const id = resp.result?.thread?.id;
			if (typeof id !== "string") throw new Error("thread/start returned an unexpected response shape (no thread id)");
			return id;
		},
		activeTurnId: (threadId) => activeTurns.get(threadId) ?? null,
		inject(threadId, text, opts) {
			// Serialized per thread (see injectChains above). The uncontended case starts
			// synchronously (same timing as before the fix); a contended call chains behind the
			// thread's previous inject — bounded by the RPC (30s) + delivery (10s) timeouts — and
			// a failed inject never wedges the chain (catch-link keeps the chain resolvable).
			const prev = injectChains.get(threadId);
			const run = prev ? prev.then(() => doInject(threadId, text, opts)) : doInject(threadId, text, opts);
			const link = run.catch(() => {});
			injectChains.set(threadId, link);
			void link.then(() => {
				if (injectChains.get(threadId) === link) injectChains.delete(threadId);
			});
			return run;
		},
		async injectItems(threadId, items) {
			const resp = await request("thread/inject_items", { threadId, items });
			if (resp.error) throw new Error(`thread/inject_items failed: ${resp.error.message}`);
		},
		onAgentMessage: (cb) => agentMessageCbs.push(cb),
		onTurnCompleted: (cb) => turnCompletedCbs.push(cb),
		onError: (cb) => errorCbs.push(cb),
		onServerRequest: (handlers) => {
			serverRequestHandlers = handlers;
		},
		isConnected: () => connected,
		pendingDeliveryCount: () => awaitingDelivery.size,
	};
}
