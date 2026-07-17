// codex app-server JSON-RPC client (carrier layer).
// Protocol facts are spike-validated against codex-cli 0.136.0 — see docs/p0-spike-findings.md:
// transport = JSONL over stdio child process (`--listen ws` does not exist in 0.136.0);
// no-turn wake = turn/start; active-turn wake = turn/steer (CAS on expectedTurnId, the
// error message carries the real active id); delivered-confirmation = item/completed of
// the injected userMessage (matched via clientUserMessageId).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Line-oriented JSON-RPC transport; real = child process stdio, tests = fake. */
export interface Transport {
	send(line: string): void;
	onLine(cb: (line: string) => void): void;
	onExit(cb: (code: number | null) => void): void;
	close(): void;
}

export function spawnAppServerTransport(codexBin = "codex"): Transport {
	const child = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
	const lineCbs: Array<(line: string) => void> = [];
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
	return {
		send: (line) => child.stdin.write(line + "\n"),
		onLine: (cb) => lineCbs.push(cb),
		onExit: (cb) => child.on("exit", cb),
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
	activeTurnId(): string | null;
	/**
	 * Wake path: steer the active turn if one exists, else start a new turn.
	 * `delivered` flips true only after the injected message is confirmed in
	 * model-visible history (item/completed with our clientUserMessageId) —
	 * the ok:true gate (invariants.ts).
	 */
	inject(threadId: string, text: string, opts?: { deliveryTimeoutMs?: number }): Promise<InjectOutcome>;
	/** Context-only append (no turn started); items are raw Responses API shapes. */
	injectItems(threadId: string, items: unknown[]): Promise<void>;
	onAgentMessage(cb: (e: AgentMessageEvent) => void): void;
	onTurnCompleted(cb: (e: { threadId: string; turnId: string }) => void): void;
	onError(cb: (e: CodexErrorEvent) => void): void;
}

interface JsonRpcResponse {
	id: number;
	result?: any;
	error?: { code: number; message: string };
}

const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

/** Parse the real active turn id out of a turn/steer CAS failure message. */
export function activeTurnIdFromSteerError(message: string): string | null {
	const m = /but found `([^`]+)`/.exec(message);
	return m ? m[1] : null;
}

export function createCodexClient(transport: Transport): CodexClient {
	let nextId = 0;
	const pending = new Map<number, (resp: JsonRpcResponse) => void>();
	let activeTurn: string | null = null;
	// clientUserMessageId -> resolve delivered
	const awaitingDelivery = new Map<string, () => void>();
	const agentMessageCbs: Array<(e: AgentMessageEvent) => void> = [];
	const turnCompletedCbs: Array<(e: { threadId: string; turnId: string }) => void> = [];
	const errorCbs: Array<(e: CodexErrorEvent) => void> = [];

	function request(method: string, params: unknown): Promise<JsonRpcResponse> {
		const id = ++nextId;
		transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return new Promise((resolve) => pending.set(id, resolve));
	}

	transport.onLine((line) => {
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
			pending.get(msg.id)?.(msg);
			pending.delete(msg.id);
			return;
		}
		switch (msg.method) {
			case "turn/started":
				activeTurn = msg.params?.turn?.id ?? null;
				break;
			case "turn/completed": {
				const turnId = msg.params?.turn?.id;
				if (activeTurn === turnId) activeTurn = null;
				for (const cb of turnCompletedCbs) cb({ threadId: msg.params?.threadId, turnId });
				break;
			}
			case "item/completed": {
				const item = msg.params?.item;
				if (item?.type === "userMessage" && item.clientId && awaitingDelivery.has(item.clientId)) {
					awaitingDelivery.get(item.clientId)!();
					awaitingDelivery.delete(item.clientId);
				} else if (item?.type === "agentMessage") {
					const text = (item.content ?? []).map((c: any) => c?.text ?? "").join("");
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
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				awaitingDelivery.delete(clientId);
				resolve(false);
			}, timeoutMs);
			awaitingDelivery.set(clientId, () => {
				clearTimeout(timer);
				resolve(true);
			});
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
		activeTurnId: () => activeTurn,
		async inject(threadId, text, opts) {
			const clientUserMessageId = randomUUID();
			const input = [{ type: "text", text }];
			const timeoutMs = opts?.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
			const deliveredP = waitDelivered(clientUserMessageId, timeoutMs);

			const startTurn = async (): Promise<InjectOutcome> => {
				const resp = await request("turn/start", { threadId, input, clientUserMessageId });
				if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
				return { turnId: resp.result.turn.id, delivered: await deliveredP, mode: "turn/start" };
			};

			const expected = activeTurn;
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
	};
}
