import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, exchangeAgentToken, fetchSelf, redeemInvitation, writeConfigFile, type FetchLike } from "../src/onboarding.js";

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

describe("onboarding: invitation redemption", () => {
	it("posts the token to /api/v1/invitations/{id}/accept and unwraps identity/api key", async () => {
		const { fetchFn, calls } = fakeFetch([
			{ match: "/invitations/inv_1/accept", data: { identity_id: "id_1", api_key: "sk_test", member_id: "m_1" } },
		]);
		const r = await redeemInvitation(fetchFn, "https://x.test", "inv_1", "tok_1");
		expect(r).toEqual({ identityId: "id_1", apiKey: "sk_test", memberId: "m_1" });
		expect(calls[0].url).toBe("https://x.test/api/v1/invitations/inv_1/accept");
		expect(JSON.parse(calls[0].body!)).toEqual({ token: "tok_1" });
		expect(calls[0].headers?.authorization).toBeUndefined(); // the token IS the credential
	});

	it("KILLING: contract drift (accepted but no api_key) fails loudly with key names, never silently mis-configures", async () => {
		const { fetchFn } = fakeFetch([{ match: "/accept", data: { identity_id: "id_1", something_else: "x" } }]);
		await expect(redeemInvitation(fetchFn, "https://x.test", "inv_1", "t")).rejects.toThrow(/identity_id\/api_key.*something_else/s);
	});

	it("HTTP error surfaces status + server message (no retry, no secret echo)", async () => {
		const { fetchFn } = fakeFetch([{ match: "/accept", status: 410, raw: JSON.stringify({ message: "invitation expired" }) }]);
		await expect(redeemInvitation(fetchFn, "https://x.test", "inv_1", "t")).rejects.toThrow(/410.*invitation expired/);
	});

	it("KILLING (0t R1 P2): failure errors NEVER contain the invitation id — the prompt tells users to paste errors back", async () => {
		const { fetchFn } = fakeFetch([{ match: "/accept", status: 410, raw: JSON.stringify({ message: "invitation expired" }) }]);
		const err = await redeemInvitation(fetchFn, "https://x.test", "inv_SECRET_1234", "tok").catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).not.toContain("inv_SECRET_1234");
		expect((err as Error).message).not.toContain("tok");
	});
});

describe("onboarding: token exchange + self hydration", () => {
	it("KILLING (0t R1 P1): exchanges org JWT via `Authorization: Bearer <api_key>` — the SDK TokenManager/cws-core contract shape, NOT x-api-key", async () => {
		const { fetchFn, calls } = fakeFetch([{ match: "/auth/agent/token", data: { access_token: "jwt_1" } }]);
		expect(await exchangeAgentToken(fetchFn, "https://x.test", "sk", "org_1")).toBe("jwt_1");
		expect(calls[0].headers?.authorization).toBe("Bearer sk");
		expect(calls[0].headers?.["x-api-key"]).toBeUndefined();
		expect(JSON.parse(calls[0].body!)).toEqual({ org_id: "org_1" });
	});

	it("fetchSelf reads /api/v1/me with Bearer and maps member_id/display_name", async () => {
		const { fetchFn, calls } = fakeFetch([{ match: "/api/v1/me", data: { member_id: "m_9", display_name: "codex-bot" } }]);
		expect(await fetchSelf(fetchFn, "https://x.test", "jwt_1")).toEqual({ memberId: "m_9", displayName: "codex-bot" });
		expect(calls[0].headers?.authorization).toBe("Bearer jwt_1");
	});
});

describe("onboarding: buildConfig pipeline", () => {
	const ROUTES = [
		{ match: "/invitations/inv_1/accept", data: { identity_id: "id_1", api_key: "sk_new" } },
		{ match: "/auth/agent/token", data: { access_token: "jwt_1" } },
		{ match: "/api/v1/me", data: { member_id: "m_9", display_name: "codex-bot" } },
	];

	it("invitation path: redeem -> exchange -> hydrate -> config shape the P1 stack runs on", async () => {
		const { fetchFn } = fakeFetch(ROUTES);
		const cfg = await buildConfig(fetchFn, {
			bff_url: "https://x.test",
			ws_url: "wss://x.test/ws",
			org_id: "org_1",
			invitation_id: "inv_1",
			invitation_token: "tok_1",
		});
		expect(cfg).toEqual({
			cws: { bffUrl: "https://x.test", wsUrl: "wss://x.test/ws", identityId: "id_1", apiKey: "sk_new" },
			codex: { bin: "codex", cwd: "." },
			bridge: { localHttpPort: 8787 },
			org: { org_id: "org_1", self: { member_id: "m_9", display_name: "codex-bot" }, access: { dmPolicy: "open" } },
		});
	});

	it("api_key path (with required identity_id) skips redemption entirely; custom port honored; config carries identityId", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		const cfg = await buildConfig(fetchFn, {
			bff_url: "https://x.test",
			ws_url: "wss://x.test/ws",
			org_id: "org_1",
			api_key: "sk_direct",
			identity_id: "id_direct",
			local_http_port: 9999,
		});
		expect(cfg.cws).toEqual({ bffUrl: "https://x.test", wsUrl: "wss://x.test/ws", identityId: "id_direct", apiKey: "sk_direct" });
		expect((cfg.bridge as { localHttpPort: number }).localHttpPort).toBe(9999);
		expect(calls.some((c) => c.url.includes("/accept"))).toBe(false);
	});

	it("KILLING (0t R1 P2): api_key WITHOUT identity_id is rejected before any network call — start's validation would refuse the config", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		await expect(
			buildConfig(fetchFn, { bff_url: "https://x.test", ws_url: "wss://x.test/ws", org_id: "org_1", api_key: "sk_direct" }),
		).rejects.toThrow(/identity_id/);
		expect(calls).toHaveLength(0);
	});

	it("KILLING: neither invitation nor api_key -> hard error before any network call", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		await expect(
			buildConfig(fetchFn, { bff_url: "https://x.test", ws_url: "wss://x.test/ws", org_id: "org_1" }),
		).rejects.toThrow(/invitation_id\+invitation_token or api_key/);
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
});
