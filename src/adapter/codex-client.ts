// codex app-server JSON-RPC client (carrier layer).
// Protocol facts are spike-validated against codex-cli 0.136.0 — see docs/p0-spike-findings.md:
// transport = JSONL over stdio child process (`--listen ws` does not exist in 0.136.0);
// no-turn wake = turn/start; active-turn wake = turn/steer (CAS on expectedTurnId, the
// error message carries the real active id); delivered-confirmation = item/completed of
// the injected userMessage (matched via clientUserMessageId); agentMessage payload is
// `item.text` (NOT item.content[]) — see the PONG round-trip in the spike doc.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Line-oriented JSON-RPC transport; real = child process stdio, tests = fake. */
export interface Transport {
	send(line: string): void;
	onLine(cb: (line: string) => void): void;
	/** Fires on child exit/spawn-error; message is a human-readable cause. */
	onExit(cb: (reason: string) => void): void;
	close(): void;
}

export function spawnAppServerTransport(codexBin = "codex"): Transport {
	const child = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
	const lineCbs: Array<(line: string) => void> = [];
	const exitCbs: Array<(reason: string) => void> = [];
	let ended = false;
	const fireExit = (reason: string) => {
		if (ended) return;
		ended = true;
		for (const cb of exitCbs) cb(reason);
	};
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += d.toString();
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (line.trim()) for (const cb of lineCbs) cb(line);
		}
	});
	child.on("error", (err) => fireExit(`spawn error: ${String(err)}`));
	child.on("exit", (code, signal) => fireExit(`app-server exited (code=${code}, signal=${signal})`));
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
// A registered handler returns the typed result; with no handler we apply a safe
// NON-INTERACTIVE policy: schema-shaped DENY where a decline exists, else fail closed.
// It NEVER approves anything.
export type ServerRequestMethod =
	| "item/commandExecution/requestApproval"
	| "item/fileChange/requestApproval"
	| "execCommandApproval"
	| "applyPatchApproval"
	| "item/tool/requestUserInput"
	| "mcpServer/elicitation/request"
	| "item/permissions/requestApproval"
	| "item/tool/call";

export interface ServerRequest<M extends string = string> {
	id: number | string;
	method: M;
	params: unknown;
}

// Method → response result type (subset of the schema we can answer non-interactively).
export type ServerRequestResult =
	| { decision: "accept" | "acceptForSession" | "decline" | "cancel" } // command/file approval
	| { decision: "approved" | "approved_for_session" | "denied" | "timed_out" | "abort" } // exec/patch (ReviewDecision)
	| { answers: Record<string, unknown> } // tool user-input
	| { action: "accept" | "decline" | "cancel" }; // MCP elicitation

/** Handler answers with a typed result, or throws to fail the request closed. */
export type ServerRequestHandler = (req: ServerRequest<ServerRequestMethod | string>) => Promise<ServerRequestResult>;

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
	 * Register the typed handler for app-server→client requests (approvals, tool input…).
	 * With no handler, the non-interactive default policy applies (DENY / fail closed);
	 * a request is never silently ignored or auto-approved.
	 */
	onServerRequest(handler: ServerRequestHandler): void;
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
	let serverRequestHandler: ServerRequestHandler | null = null;
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
			const req: ServerRequest = { id: msg.id, method: msg.method, params: msg.params };
			if (!serverRequestHandler) {
				respond(msg.id, defaultServerRequestResponse(msg.method));
				return;
			}
			serverRequestHandler(req)
				.then((result) => respond(msg.id, { result }))
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
			return resp.result.thread.id as string;
		},
		activeTurnId: (threadId) => activeTurns.get(threadId) ?? null,
		async inject(threadId, text, opts) {
			if (!connected) throw new Error("cannot inject: transport disconnected");
			const clientUserMessageId = randomUUID();
			const input = [{ type: "text", text }];
			const timeoutMs = opts?.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
			const waiter = createDeliveryWaiter(clientUserMessageId, timeoutMs);

			try {
				const startTurn = async (): Promise<InjectOutcome> => {
					const resp = await request("turn/start", { threadId, input, clientUserMessageId });
					if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
					const turnId = resp.result.turn.id;
					activeTurns.set(threadId, turnId);
					return { turnId, delivered: await waiter.promise, mode: "turn/start" };
				};

				const expected = activeTurns.get(threadId);
				if (!expected) return await startTurn();

				let resp = await request("turn/steer", { threadId, expectedTurnId: expected, input, clientUserMessageId });
				if (resp.error) {
					// CAS lost: the error carries the real active id — retry once with it;
					// fall back to turn/start when the turn ended meanwhile.
					const realId = activeTurnIdFromSteerError(resp.error.message);
					if (realId) {
						resp = await request("turn/steer", { threadId, expectedTurnId: realId, input, clientUserMessageId });
						if (!resp.error) {
							// P2#2 fix: write back the recovered id so the next wake steers it and
							// turn/completed(realId) can clear it.
							activeTurns.set(threadId, realId);
							return { turnId: realId, delivered: await waiter.promise, mode: "turn/steer" };
						}
					}
					return await startTurn();
				}
				return { turnId: expected, delivered: await waiter.promise, mode: "turn/steer" };
			} catch (err) {
				// P2#3 fix: terminal failure must not leave the delivery waiter/timer behind.
				waiter.cancel();
				throw err;
			}
		},
		async injectItems(threadId, items) {
			const resp = await request("thread/inject_items", { threadId, items });
			if (resp.error) throw new Error(`thread/inject_items failed: ${resp.error.message}`);
		},
		onAgentMessage: (cb) => agentMessageCbs.push(cb),
		onTurnCompleted: (cb) => turnCompletedCbs.push(cb),
		onError: (cb) => errorCbs.push(cb),
		onServerRequest: (handler) => {
			serverRequestHandler = handler;
		},
		isConnected: () => connected,
		pendingDeliveryCount: () => awaitingDelivery.size,
	};
}
