// Layer 2 — local HTTP server: POST /wake, POST /send.
// /wake: receive a CWS message -> inject into Codex (handleWake) -> return WakeResponse
//        (ok:true only when "truly delivered" — the handler enforces that, see inject.ts).
// /send: receive a runtime reply -> hand to the Bridge (handleSend) -> return SendResponse.
// Contract: see types.ts / Architecture Part 1.5. Uses only node:http (no external deps).
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { SendRequest, SendResponse, WakeRequest, WakeResponse } from "../types.js";

export interface AdapterServerDeps {
	handleWake: (wake: WakeRequest) => Promise<WakeResponse>;
	handleSend: (req: SendRequest) => Promise<SendResponse>;
	log?: (msg: string) => void;
}

export interface AdapterServerHandle {
	port: number;
	close: () => Promise<void>;
}

function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > limitBytes) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

/** Minimal shape guards so a malformed POST body fails fast with 400, not deep in the handler. */
function isWakeRequest(v: unknown): v is WakeRequest {
	const o = v as Record<string, unknown>;
	return !!o && typeof o.messageId === "string" && typeof o.conversationId === "string" && typeof o.senderId === "string";
}
function isSendRequest(v: unknown): v is SendRequest {
	const o = v as Record<string, unknown>;
	return !!o && typeof o.conversationId === "string" && typeof o.content === "string";
}

/** Start the local adapter HTTP server. `port` 0 = ephemeral (tests); pass the configured port for real runs. */
export function startAdapterServer(deps: AdapterServerDeps, port = 0): Promise<AdapterServerHandle> {
	const log = deps.log ?? (() => {});
	const server: Server = createServer((req, res) => {
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.method !== "POST") return send(405, { error: "method not allowed" });

		void (async () => {
			let body: unknown;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return send(400, { error: `invalid body: ${String(e)}` });
			}
			if (req.url === "/wake") {
				if (!isWakeRequest(body)) return send(400, { error: "invalid WakeRequest" });
				// ok:false still returns HTTP 200 with the typed body — the caller reads `ok`;
				// a transport-level non-2xx would wrongly trigger its own retry semantics.
				const resp = await deps
					.handleWake(body)
					.catch((): WakeResponse => ({ ok: false, failureClass: "runtime_error", retryAfterMs: 15_000 }));
				return send(200, resp);
			}
			if (req.url === "/send") {
				if (!isSendRequest(body)) return send(400, { error: "invalid SendRequest" });
				const resp = await deps.handleSend(body).catch((): SendResponse => ({ ok: false, failureClass: "runtime_error" }));
				return send(200, resp);
			}
			return send(404, { error: "not found" });
		})();
	});

	return new Promise((resolve) => {
		server.listen(port, () => {
			const addr = server.address();
			const boundPort = typeof addr === "object" && addr ? addr.port : port;
			log(`adapter server listening on :${boundPort}`);
			resolve({ port: boundPort, close: () => new Promise<void>((res) => server.close(() => res())) });
		});
	});
}
