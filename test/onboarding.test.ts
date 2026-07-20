import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, exchangeAgentToken, fetchSelf, writeConfigFile, type FetchLike } from "../src/onboarding.js";

/** Scripted fetch: match by URL substring, record calls (headers/body) for assertions. */
function fakeFetch(routes: Array<{ match: string; status?: number; data?: unknown; raw?: string }>) {
	const calls: Array<{ url: string; headers?: Record<string, string>; body?: string }> = [];
	const fetchFn: FetchLike = async (url, init) => {
		calls.push({ url, headers: init?.headers, body: init?.body });
		const r = routes.find((r) => url.includes(r.match));
		if (!r) return { ok: false, status: 404, text: async () => JSON.stringify({ message: "no route" }) };
		const status = r.status ?? 200;
		return {
			ok: status < 300,
			status,
			text: async () => r.raw ?? JSON.stringify({ $schema: "x", data: r.data, request_id: "r" }),
		};
	};
	return { fetchFn, calls };
}

describe("onboarding: token exchange + self hydration", () => {
	it("KILLING (0t R1 P1): exchanges org JWT via `Authorization: Bearer <api_key>` — the SDK TokenManager/cws-core contract shape, NOT x-api-key", async () => {
		const { fetchFn, calls } = fakeFetch([{ match: "/auth/agent/token", data: { access_token: "jwt_1" } }]);
		expect(await exchangeAgentToken(fetchFn, "https://x.test", "sk", "org_1")).toBe("jwt_1");
		expect(calls[0].headers?.authorization).toBe("Bearer sk");
		expect(calls[0].headers?.["x-api-key"]).toBeUndefined();
		expect(JSON.parse(calls[0].body!)).toEqual({ org_id: "org_1" });
	});

	it("HTTP-error messages use the endpoint LABEL, not the raw URL (postJson redaction — defensive: keeps any future id-bearing URL out of user-visible errors)", async () => {
		const { fetchFn } = fakeFetch([{ match: "/auth/agent/token", status: 401, raw: JSON.stringify({ message: "bad key" }) }]);
		const err = await exchangeAgentToken(fetchFn, "https://secret-host.test", "sk", "org_1").catch((e: Error) => e);
		expect((err as Error).message).toContain("agent token exchange");
		expect((err as Error).message).not.toContain("https://secret-host.test");
	});

	it("fetchSelf reads /api/v1/me with Bearer and maps member_id/display_name", async () => {
		const { fetchFn, calls } = fakeFetch([{ match: "/api/v1/me", data: { member_id: "m_9", display_name: "codex-bot" } }]);
		expect(await fetchSelf(fetchFn, "https://x.test", "jwt_1")).toEqual({ memberId: "m_9", displayName: "codex-bot" });
		expect(calls[0].headers?.authorization).toBe("Bearer jwt_1");
	});
});

describe("onboarding: buildConfig pipeline (api_key + identity_id)", () => {
	const ROUTES = [
		{ match: "/auth/agent/token", data: { access_token: "jwt_1" } },
		{ match: "/api/v1/me", data: { member_id: "m_9", display_name: "codex-bot" } },
	];

	it("exchange -> hydrate -> config shape the P1 stack runs on; no redemption endpoint touched", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		const cfg = await buildConfig(fetchFn, {
			bff_url: "https://x.test",
			ws_url: "wss://x.test/ws",
			org_id: "org_1",
			api_key: "sk_direct",
			identity_id: "id_direct",
			local_http_port: 9999,
		});
		expect(cfg).toEqual({
			cws: { bffUrl: "https://x.test", wsUrl: "wss://x.test/ws", identityId: "id_direct", apiKey: "sk_direct" },
			codex: { bin: "codex", cwd: "." },
			bridge: { localHttpPort: 9999 },
			org: { org_id: "org_1", self: { member_id: "m_9", display_name: "codex-bot" }, access: { dmPolicy: "open" } },
		});
		expect(calls.some((c) => c.url.includes("/accept"))).toBe(false); // no agent-side invitation redemption exists
	});

	it("default port when omitted", async () => {
		const { fetchFn } = fakeFetch(ROUTES);
		const cfg = await buildConfig(fetchFn, { bff_url: "https://x.test", ws_url: "wss://x.test/ws", org_id: "org_1", api_key: "sk", identity_id: "id" });
		expect((cfg.bridge as { localHttpPort: number }).localHttpPort).toBe(8787);
	});

	it("KILLING: missing api_key -> hard error before any network call", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		await expect(
			buildConfig(fetchFn, { bff_url: "https://x.test", ws_url: "wss://x.test/ws", org_id: "org_1", identity_id: "id" } as never),
		).rejects.toThrow(/api_key/);
		expect(calls).toHaveLength(0);
	});

	it("KILLING (0t R1 P2): missing identity_id -> rejected before any network call (start's validation would refuse the config)", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		await expect(
			buildConfig(fetchFn, { bff_url: "https://x.test", ws_url: "wss://x.test/ws", org_id: "org_1", api_key: "sk" } as never),
		).rejects.toThrow(/identity_id/);
		expect(calls).toHaveLength(0);
	});
});

describe("writeConfigFile (0600 guarantee)", () => {
	it("KILLING (0t R1 P2): overwriting an EXISTING 0644 config still ends at 0600 (temp + atomic rename; writeFileSync mode only applies at creation)", () => {
		const dir = fs.mkdtempSync(join(tmpdir(), "cfg-"));
		const target = join(dir, "config.json");
		fs.writeFileSync(target, "{}", { mode: 0o644 });
		expect(fs.statSync(target).mode & 0o777).toBe(0o644); // precondition
		writeConfigFile(fs, target, { a: 1 });
		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
		expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ a: 1 });
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("KILLING (0t R2): a PRE-EXISTING 0644 temp file at the predictable path cannot leak into a 0644 config (0t's exact repro)", () => {
		const dir = fs.mkdtempSync(join(tmpdir(), "cfg-"));
		const target = join(dir, "config.json");
		const tmp = `${target}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, "planted", { mode: 0o644 });
		expect(fs.statSync(tmp).mode & 0o777).toBe(0o644); // precondition: loose stale temp
		writeConfigFile(fs, target, { a: 2 });
		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
		expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ a: 2 });
		expect(fs.existsSync(tmp)).toBe(false); // temp consumed by rename
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
