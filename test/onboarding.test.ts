import { describe, it, expect } from "vitest";
import { buildConfig, exchangeAgentToken, fetchSelf, redeemInvitation, type FetchLike } from "../src/onboarding.js";

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
});

describe("onboarding: token exchange + self hydration", () => {
	it("exchanges org JWT via x-api-key (proven live shape)", async () => {
		const { fetchFn, calls } = fakeFetch([{ match: "/auth/agent/token", data: { access_token: "jwt_1" } }]);
		expect(await exchangeAgentToken(fetchFn, "https://x.test", "sk", "org_1")).toBe("jwt_1");
		expect(calls[0].headers?.["x-api-key"]).toBe("sk");
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

	it("api_key path skips redemption entirely; custom port honored", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		const cfg = await buildConfig(fetchFn, {
			bff_url: "https://x.test",
			ws_url: "wss://x.test/ws",
			org_id: "org_1",
			api_key: "sk_direct",
			local_http_port: 9999,
		});
		expect((cfg.cws as { apiKey: string }).apiKey).toBe("sk_direct");
		expect((cfg.bridge as { localHttpPort: number }).localHttpPort).toBe(9999);
		expect(calls.some((c) => c.url.includes("/accept"))).toBe(false);
	});

	it("KILLING: neither invitation nor api_key -> hard error before any network call", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		await expect(
			buildConfig(fetchFn, { bff_url: "https://x.test", ws_url: "wss://x.test/ws", org_id: "org_1" }),
		).rejects.toThrow(/invitation_id\+invitation_token or api_key/);
		expect(calls).toHaveLength(0);
	});
});
