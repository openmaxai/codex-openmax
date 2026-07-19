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

const VALID = {
	cws: { bffUrl: "https://openmax.com", wsUrl: "wss://openmax.com/ws", identityId: "id_1", apiKey: "cwsk_x" },
	codex: { bin: "codex", cwd: "/tmp" },
	bridge: { localHttpPort: 8787 },
};

describe("loadConfig (P1 MVP)", () => {
	it("loads a valid config file", () => {
		const p = tmpConfig(VALID);
		const c = loadConfig(p);
		expect(c.cws.apiKey).toBe("cwsk_x");
		expect(c.codex.bin).toBe("codex");
		expect(c.bridge.localHttpPort).toBe(8787);
		rmSync(p, { force: true });
	});

	it("env overrides file values", () => {
		const p = tmpConfig(VALID);
		process.env.CWS_API_KEY = "cwsk_from_env";
		process.env.BRIDGE_HTTP_PORT = "9999";
		const c = loadConfig(p);
		expect(c.cws.apiKey).toBe("cwsk_from_env");
		expect(c.bridge.localHttpPort).toBe(9999);
		rmSync(p, { force: true });
	});

	it("throws listing every missing required field", () => {
		const p = tmpConfig({ cws: { bffUrl: "https://x", wsUrl: "wss://x" }, codex: {}, bridge: {} });
		expect(() => loadConfig(p)).toThrow(/missing required field\(s\).*cws\.identityId.*cws\.apiKey/s);
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
		expect(c.cws.apiKey).toBe("cwsk_env");
	});
});
