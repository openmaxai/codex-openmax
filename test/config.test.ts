import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
	"CODEX_OPENMAX_CONFIG",
	"CWS_BFF_URL",
	"CWS_WS_URL",
	"CWS_IDENTITY_ID",
	"CWS_API_KEY",
	"CODEX_BIN",
	"CODEX_CWD",
	"BRIDGE_HTTP_PORT",
];
afterEach(() => {
	for (const k of ENV_KEYS) delete process.env[k];
});

function tmpConfig(obj: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-openmax-cfg-"));
	const p = join(dir, "config.json");
	writeFileSync(p, JSON.stringify(obj));
	return p;
}

// Bridge / openmax-mirrored shape + codex-openmax runtime-specific blocks (codex, bridge).
const VALID = {
	enabled: true,
	server: { bff_url: "https://openmax.com", ws_url: "wss://openmax.com/ws", frontend_base_path: "/workspace" },
	agent: { identity_id: "id_1", api_key: "cwsk_x", device_id: "dev_1", app_version: "codex-openmax/9.9.9" },
	cf_access: { client_id: "cf_id", client_secret: "cf_secret" },
	orgs: {
		org_1: {
			enabled: true,
			org_id: "org_1",
			org_name: "Org One",
			owner: { member_id: "", name: "" },
			self: { member_id: "m_1", name: "Codex", display_name: "Codex" },
			access: { dmPolicy: "owner", dmAllowFrom: [], groupPolicy: "allowlist", groups: { conv_1: { mode: "mention", allowFrom: ["*"] } } },
		},
	},
	codex: { bin: "codex", cwd: "/tmp" },
	bridge: { localHttpPort: 8787 },
};

describe("loadConfig (bridge-format)", () => {
	it("loads a valid config file and maps the bridge shape to the runtime shape", () => {
		const p = tmpConfig(VALID);
		const c = loadConfig(p);
		expect(c.server.bffUrl).toBe("https://openmax.com");
		expect(c.server.wsUrl).toBe("wss://openmax.com/ws");
		expect(c.server.frontendBasePath).toBe("/workspace");
		expect(c.agent.identityId).toBe("id_1");
		expect(c.agent.apiKey).toBe("cwsk_x");
		expect(c.agent.deviceId).toBe("dev_1");
		expect(c.agent.appVersion).toBe("codex-openmax/9.9.9");
		expect(c.cfAccess).toEqual({ client_id: "cf_id", client_secret: "cf_secret" });
		expect(c.codex.bin).toBe("codex");
		expect(c.bridge.localHttpPort).toBe(8787);
		rmSync(p, { force: true });
	});

	it("parses the org_id-keyed orgs map into an array carrying the FULL access block (dm + group)", () => {
		const p = tmpConfig(VALID);
		const c = loadConfig(p);
		expect(c.orgs).toHaveLength(1);
		const org = c.orgs[0];
		expect(org.org_id).toBe("org_1");
		expect(org.self.member_id).toBe("m_1");
		// The whole point of the alignment: group access policy survives into orgConfigs.
		expect(org.access).toEqual({ dmPolicy: "owner", dmAllowFrom: [], groupPolicy: "allowlist", groups: { conv_1: { mode: "mention", allowFrom: ["*"] } } });
		rmSync(p, { force: true });
	});

	it("keys an org by its map key when the inner org_id is omitted", () => {
		const p = tmpConfig({ ...VALID, orgs: { org_from_key: { self: { member_id: "m" }, access: {} } } });
		const c = loadConfig(p);
		expect(c.orgs[0].org_id).toBe("org_from_key");
		rmSync(p, { force: true });
	});

	it("leaves cfAccess undefined when cf_access has an empty client_id (inert example block)", () => {
		const p = tmpConfig({ ...VALID, cf_access: { client_id: "", client_secret: "" } });
		const c = loadConfig(p);
		expect(c.cfAccess).toBeUndefined();
		rmSync(p, { force: true });
	});

	it("env overrides file values", () => {
		const p = tmpConfig(VALID);
		process.env.CWS_API_KEY = "cwsk_from_env";
		process.env.BRIDGE_HTTP_PORT = "9999";
		const c = loadConfig(p);
		expect(c.agent.apiKey).toBe("cwsk_from_env");
		expect(c.bridge.localHttpPort).toBe(9999);
		rmSync(p, { force: true });
	});

	it("throws listing every missing required field", () => {
		const p = tmpConfig({ server: { bff_url: "https://x", ws_url: "wss://x" }, agent: {}, codex: {}, bridge: {} });
		expect(() => loadConfig(p)).toThrow(/missing required field\(s\).*agent\.identity_id.*agent\.api_key/s);
		rmSync(p, { force: true });
	});

	it("rejects a non-positive port", () => {
		const p = tmpConfig({ ...VALID, bridge: { localHttpPort: 0 } });
		expect(() => loadConfig(p)).toThrow(/localHttpPort must be a positive integer/);
		rmSync(p, { force: true });
	});

	it("throws if an explicitly-named config file is unreadable", () => {
		expect(() => loadConfig("/no/such/config.json")).toThrow(/cannot read/);
	});

	it("env-only path: missing default config.json is tolerated, codex.bin defaults to 'codex'", () => {
		process.env.CWS_BFF_URL = "https://openmax.com";
		process.env.CWS_WS_URL = "wss://openmax.com/ws";
		process.env.CWS_IDENTITY_ID = "id_1";
		process.env.CWS_API_KEY = "cwsk_env";
		// no path arg + no CODEX_OPENMAX_CONFIG → default ./config.json absent → tolerated, env supplies all
		const c = loadConfig();
		expect(c.codex.bin).toBe("codex");
		expect(c.agent.apiKey).toBe("cwsk_env");
		expect(c.orgs).toEqual([]);
	});
});
