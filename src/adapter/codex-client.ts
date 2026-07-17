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
	// spawn failure (e.g. bad bin → ENOENT) surfaces on the child, not stdin.
	child.on("error", (err) => fireExit(`spawn error: ${String(err)}`));
	child.on("exit", (code, signal) => fireExit(`app-server exited (code=${code}, signal=${signal})`));
	return {
		send: (line) => {
			// stdin write after death would throw EPIPE; swallow — onExit already reported.
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

/**
 * app-server → client request (id + method + params) requiring a response, e.g. command/file
 * approval, tool user-input, MCP elicitation/permissions. The handler MUST return a result
 * object; there is no safe default that auto-approves.
 */
export interface ServerRequest {
	id: number | string;
	method: string;
	params: unknown;
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
	 * the ok:true gate (invariants.ts). Rejects if the transport disconnects.
	 */
	inject(threadId: string, text: string, opts?: { deliveryTimeoutMs?: number }): Promise<InjectOutcome>;
	/** Context-only append (no turn started); items are raw Responses API shapes. */
	injectItems(threadId: string, items: unknown[]): Promise<void>;
	onAgentMessage(cb: (e: AgentMessageEvent) => void): void;
	onTurnCompleted(cb: (e: { threadId: string; turnId: string }) => void): void;
	onError(cb: (e: CodexErrorEvent) => void): void;
	/**
	 * Register the handler for app-server→client requests (approvals, tool input…).
	 * Return a result object to answer; return/throw with no handler set →
	 * the request is denied (a JSON-RPC error), never silently ignored or auto-approved.
	 */
	onServerRequest(handler: (req: ServerRequest) => Promise<object>): void;
	/** True until the transport disconnects. */
	isConnected(): boolean;
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

export function createCodexClient(
	transport: Transport,
	opts?: { requestTimeoutMs?: number },
): CodexClient {
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
	let serverRequestHandler: ((req: ServerRequest) => Promise<object>) | null = null;
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
				// No handler → deny (never auto-approve, never silently drop).
				respond(msg.id, {
					error: { code: -32601, message: `no handler for server request ${msg.method}; denied` },
				});
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

	function waitDelivered(clientId: string, timeoutMs: number): Promise<boolean> {
		if (!connected) return Promise.resolve(false);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				awaitingDelivery.delete(clientId);
				resolve(false);
			}, timeoutMs);
			awaitingDelivery.set(clientId, { resolve, timer });
		});
	}

	return {
		async start() {
			const resp = await request("initialize", {
				clientInfo: { name: "codex-openmax", version: "0.0.0" },
			});
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
			const deliveredP = waitDelivered(clientUserMessageId, timeoutMs);

			const startTurn = async (): Promise<InjectOutcome> => {
				const resp = await request("turn/start", { threadId, input, clientUserMessageId });
				if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
				return { turnId: resp.result.turn.id, delivered: await deliveredP, mode: "turn/start" };
			};

			const expected = activeTurns.get(threadId);
			if (!expected) return startTurn();

			let resp = await request("turn/steer", { threadId, expectedTurnId: expected, input, clientUserMessageId });
			if (resp.error) {
				// CAS lost: the error carries the real active id — retry once with it;
				// fall back to turn/start when the turn ended meanwhile.
				const realId = activeTurnIdFromSteerError(resp.error.message);
				if (realId) {
					resp = await request("turn/steer", { threadId, expectedTurnId: realId, input, clientUserMessageId });
					if (!resp.error) return { turnId: realId, delivered: await deliveredP, mode: "turn/steer" };
				}
				return startTurn();
			}
			return { turnId: expected, delivered: await deliveredP, mode: "turn/steer" };
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
	};
}
