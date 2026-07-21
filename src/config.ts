// Config load/validate: CWS server + agent credentials (bridge / openmax-mirrored
// format), per-org access policy, PLUS codex-openmax runtime-specific fields (the
// codex binary + the local HTTP/wake port).
//
// The on-disk config.json now mirrors the claude-openmax / openmax-bridge shape so
// the server/agent/orgs blocks are portable between the sibling adapters, with two
// codex-only additions (`codex`, `bridge`) that have no analog there:
//
//   {
//     "enabled": true,
//     "server": { "bff_url", "ws_url", "frontend_base_path" },
//     "agent":  { "identity_id", "api_key", "device_id", "app_version" },
//     "cf_access": { "client_id", "client_secret" },        // optional (test/CF envs)
//     "orgs": { "<org_id>": {                                // KEYED by org_id
//       "enabled", "org_id", "org_name",
//       "owner":  { "member_id", "name" },
//       "self":   { "member_id", "name", "display_name" },
//       "access": { "dmPolicy", "dmAllowFrom", "groupPolicy", "groups" }
//     } },
//     "codex":  { "bin", "cwd" },                            // codex-openmax ONLY
//     "bridge": { "localHttpPort" }                          // codex-openmax ONLY (local /wake server)
//   }
//
// Secrets come from config.json / env and are never committed (see .gitignore, config.example.json).
// P0 finding: app-server speaks JSONL over stdio (no ws listener in codex-cli 0.136.0),
// so we configure the binary to spawn, not a URL — see docs/p0-spike-findings.md.
import { readFileSync } from "node:fs";

const DEFAULT_APP_VERSION = "codex-openmax/0.1.0";
const DEFAULT_FRONTEND_BASE_PATH = "/workspace";
const DEFAULT_DEVICE_ID = "codex-openmax-device";
const DEFAULT_LOCAL_HTTP_PORT = 8787;

/** Per-org access policy — full bridge shape (DM + group). Passed VERBATIM to the
 * SDK's CwsAgentBridge as part of each orgConfig, so the SDK can enforce group
 * access policy (the old `{dmPolicy}`-only shape could not express this). */
export interface OrgAccess {
	dmPolicy?: string;
	dmAllowFrom?: string[];
	groupPolicy?: string;
	groups?: Record<string, unknown>;
}

/** One org, in the bridge / openmax-mirrored shape handed straight to the SDK
 * (orgConfigs). Kept snake_case because the SDK reads these keys directly. */
export interface OrgConfig {
	enabled?: boolean;
	org_id: string;
	org_name?: string;
	owner?: { member_id: string; name: string };
	self: { member_id: string; name?: string; display_name?: string };
	access: OrgAccess;
}

export interface AppConfig {
	enabled?: boolean;
	server: { bffUrl: string; wsUrl: string; frontendBasePath: string };
	agent: { identityId: string; apiKey: string; deviceId: string; appVersion: string };
	cfAccess?: { client_id: string; client_secret: string };
	orgs: OrgConfig[];
	// codex-openmax runtime-specific (no analog in claude-openmax / openmax):
	codex: { bin: string; cwd: string };
	bridge: { localHttpPort: number };
}

const REQUIRED = [
	["server.bff_url", (c: AppConfig) => c.server.bffUrl],
	["server.ws_url", (c: AppConfig) => c.server.wsUrl],
	["agent.identity_id", (c: AppConfig) => c.agent.identityId],
	["agent.api_key", (c: AppConfig) => c.agent.apiKey],
	["codex.bin", (c: AppConfig) => c.codex.bin],
] as const;

/** Normalize the org_id-keyed on-disk `orgs` map into an array of orgConfigs. Each
 * org's `access` block is passed through as-is (defaulting to {} when absent) so the
 * full DM + group policy the config carries reaches the SDK unchanged. */
function parseOrgs(raw: Record<string, any>): OrgConfig[] {
	const orgsRaw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const orgs: OrgConfig[] = [];
	for (const [orgIdKey, org] of Object.entries(orgsRaw)) {
		if (!org || typeof org !== "object") continue;
		const org_id = (org as any).org_id || orgIdKey;
		if (!org_id) continue;
		orgs.push({
			...((org as any).enabled !== undefined ? { enabled: (org as any).enabled } : {}),
			org_id,
			org_name: (org as any).org_name || "",
			owner: (org as any).owner || { member_id: "", name: "" },
			self: (org as any).self || { member_id: "", name: "", display_name: "" },
			access: (org as any).access || {},
		});
	}
	return orgs;
}

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

	const cfAccessRaw = raw.cf_access as { client_id?: string; client_secret?: string } | undefined;
	const cfg: AppConfig = {
		...(raw.enabled !== undefined ? { enabled: raw.enabled } : {}),
		server: {
			bffUrl: process.env.CWS_BFF_URL ?? raw.server?.bff_url ?? "",
			wsUrl: process.env.CWS_WS_URL ?? raw.server?.ws_url ?? "",
			frontendBasePath: raw.server?.frontend_base_path ?? DEFAULT_FRONTEND_BASE_PATH,
		},
		agent: {
			identityId: process.env.CWS_IDENTITY_ID ?? raw.agent?.identity_id ?? "",
			apiKey: process.env.CWS_API_KEY ?? raw.agent?.api_key ?? "",
			deviceId: raw.agent?.device_id ?? DEFAULT_DEVICE_ID,
			appVersion: raw.agent?.app_version ?? DEFAULT_APP_VERSION,
		},
		// Only surface cf_access when it actually carries a client_id — an empty
		// { client_id: "", client_secret: "" } block (as in config.example.json) stays
		// inert so we never emit empty CF-Access headers.
		...(cfAccessRaw?.client_id ? { cfAccess: { client_id: cfAccessRaw.client_id, client_secret: cfAccessRaw.client_secret ?? "" } } : {}),
		orgs: parseOrgs(raw.orgs),
		codex: {
			bin: process.env.CODEX_BIN ?? raw.codex?.bin ?? "codex",
			cwd: process.env.CODEX_CWD ?? raw.codex?.cwd ?? process.cwd(),
		},
		bridge: {
			localHttpPort: Number(process.env.BRIDGE_HTTP_PORT ?? raw.bridge?.localHttpPort ?? DEFAULT_LOCAL_HTTP_PORT),
		},
	};

	const missing = REQUIRED.filter(([, get]) => !get(cfg)).map(([name]) => name);
	if (missing.length) throw new Error(`config: missing required field(s): ${missing.join(", ")}`);
	if (!Number.isInteger(cfg.bridge.localHttpPort) || cfg.bridge.localHttpPort <= 0) {
		throw new Error(`config: bridge.localHttpPort must be a positive integer (got ${cfg.bridge.localHttpPort})`);
	}
	return cfg;
}
