// Config load/validate: CWS credentials, codex binary, local HTTP port.
// Secrets come from config.json / env and are never committed (see .gitignore, config.example.json).
// P0 finding: app-server speaks JSONL over stdio (no ws listener in codex-cli 0.136.0),
// so we configure the binary to spawn, not a URL — see docs/p0-spike-findings.md.
import { readFileSync } from "node:fs";

export interface AppConfig {
	cws: { bffUrl: string; wsUrl: string; identityId: string; apiKey: string };
	codex: { bin: string; cwd: string };
	bridge: { localHttpPort: number };
}

const REQUIRED = [
	["cws.bffUrl", (c: AppConfig) => c.cws.bffUrl],
	["cws.wsUrl", (c: AppConfig) => c.cws.wsUrl],
	["cws.identityId", (c: AppConfig) => c.cws.identityId],
	["cws.apiKey", (c: AppConfig) => c.cws.apiKey],
	["codex.bin", (c: AppConfig) => c.codex.bin],
] as const;

/**
 * Load config from a JSON file (path arg, else $CODEX_OPENMAX_CONFIG, else ./config.json),
 * then apply env overrides, then validate required fields. Throws on missing/invalid.
 */
export function loadConfig(path?: string): AppConfig {
	const file = path ?? process.env.CODEX_OPENMAX_CONFIG ?? "config.json";
	let raw: Record<string, any> = {};
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		if (path || process.env.CODEX_OPENMAX_CONFIG) throw new Error(`config: cannot read ${file}: ${String(err)}`);
		// default path missing is tolerated — env-only config is valid
	}

	const cfg: AppConfig = {
		cws: {
			bffUrl: process.env.CWS_BFF_URL ?? raw.cws?.bffUrl ?? "",
			wsUrl: process.env.CWS_WS_URL ?? raw.cws?.wsUrl ?? "",
			identityId: process.env.CWS_IDENTITY_ID ?? raw.cws?.identityId ?? "",
			apiKey: process.env.CWS_API_KEY ?? raw.cws?.apiKey ?? "",
		},
		codex: {
			bin: process.env.CODEX_BIN ?? raw.codex?.bin ?? "codex",
			cwd: process.env.CODEX_CWD ?? raw.codex?.cwd ?? process.cwd(),
		},
		bridge: {
			localHttpPort: Number(process.env.BRIDGE_HTTP_PORT ?? raw.bridge?.localHttpPort ?? 8787),
		},
	};

	const missing = REQUIRED.filter(([, get]) => !get(cfg)).map(([name]) => name);
	if (missing.length) throw new Error(`config: missing required field(s): ${missing.join(", ")}`);
	if (!Number.isInteger(cfg.bridge.localHttpPort) || cfg.bridge.localHttpPort <= 0) {
		throw new Error(`config: bridge.localHttpPort must be a positive integer (got ${cfg.bridge.localHttpPort})`);
	}
	return cfg;
}
