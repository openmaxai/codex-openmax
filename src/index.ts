// Entry point: wire Layer 1 Bridge + Layer 2 Adapter (local HTTP) + the codex app-server client.
// Inbound:  CWS --(bridge)--> POST /wake --> ensureThread --> injectWake(codex)  => ok:true only if delivered
// Outbound: codex agentMessage --> attachOutbound --> POST /send --> bridge.send --> CWS
// The bridge is the mock until @openmaxai/cws-agent-sdk v0 lands (same CwsBridge interface).
import { attachOutbound } from "./adapter/outbound.js";
import { createCodexClient, spawnAppServerTransport } from "./adapter/codex-client.js";
import { injectWake } from "./adapter/inject.js";
import { startAdapterServer } from "./adapter/server.js";
import { createMockCwsBridge, type CwsBridge } from "./bridge/cws-bridge.js";
import { createWakeQueue } from "./adapter/wake-queue.js";
import { loadConfig } from "./config.js";
import type { SendRequest, WakeRequest, WakeResponse } from "./types.js";

export interface RuntimeHandle {
	port: number;
	stop: () => Promise<void>;
}

/**
 * Wire the full adapter. `bridge` is injectable so tests (and, later, the SDK-backed bridge)
 * can supply their own; defaults to the in-memory mock for P1 MVP.
 */
export async function main(bridge: CwsBridge = createMockCwsBridge()): Promise<RuntimeHandle> {
	const config = loadConfig();
	const log = (m: string) => console.error(`[codex-openmax] ${m}`);

	const client = createCodexClient(spawnAppServerTransport(config.codex.bin));
	await client.start();

	// conversationId <-> threadId registry (one Codex thread per CWS conversation).
	const threadByConversation = new Map<string, string>();
	const conversationByThread = new Map<string, string>();
	async function ensureThread(conversationId: string): Promise<string> {
		const existing = threadByConversation.get(conversationId);
		if (existing) return existing;
		const threadId = await client.startThread({ cwd: config.codex.cwd });
		threadByConversation.set(conversationId, threadId);
		conversationByThread.set(threadId, conversationId);
		return threadId;
	}

	// Per-conversation FIFO + messageId dedup + depth-capped backpressure (wake-queue.ts).
	// Serialization also closes the ensureThread race: one conversation never runs two
	// wakes concurrently, so a first-wake pair can't both spawn a thread.
	const wakeQueue = createWakeQueue(async (wake: WakeRequest) => {
		const threadId = await ensureThread(wake.conversationId);
		return injectWake(client, threadId, wake);
	});

	const server = await startAdapterServer(
		{
			handleWake: (wake: WakeRequest) => wakeQueue.enqueue(wake),
			handleSend: (req: SendRequest) => bridge.send(req).then((r) => (r.ok && r.messageId ? { ok: true as const, messageId: r.messageId } : { ok: false as const, failureClass: "runtime_error" as const })),
			log,
		},
		config.bridge.localHttpPort,
	);

	// Inbound: the bridge hands each CWS message to the local /wake endpoint. The /wake
	// response is returned to the bridge VERBATIM — the SDK's deliver() resolves with it, and
	// ok:true is what commits its dedupe/ledger/sync markers (wake-result invariant). A
	// transport failure here is a typed retryable failure, never a fabricated ok.
	bridge.onInbound(async (wake) => {
		try {
			const res = await fetch(`http://127.0.0.1:${server.port}/wake`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(wake),
			});
			const resp = (await res.json()) as WakeResponse;
			// Observability: a failed wake must say WHY (the SDK log only shows ok=false).
			if (!resp.ok) log(`wake failed msg=${wake.messageId} conv=${wake.conversationId}: ${JSON.stringify(resp)}`);
			return resp;
		} catch (e) {
			log(`inbound /wake failed: ${String(e)}`);
			return { ok: false, failureClass: "runtime_error", retryAfterMs: 15_000 };
		}
	});

	// Outbound: a completed Codex agentMessage → POST /send (which hands to the bridge).
	attachOutbound(
		client,
		(threadId) => conversationByThread.get(threadId),
		async (req) => {
			await fetch(`http://127.0.0.1:${server.port}/send`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(req),
			}).catch((e) => log(`outbound /send failed: ${String(e)}`));
		},
		log,
	);

	await bridge.start();
	log(`ready on :${server.port}`);

	return {
		port: server.port,
		stop: async () => {
			await bridge.stop();
			await server.close();
			client.stop();
		},
	};
}
