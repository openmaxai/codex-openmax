import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, exchangeAgentToken, fetchSelf, registerAgent, acceptInvitation, writeConfigFile, type FetchLike } from "../src/onboarding.js";

/** Scripted fetch: match by URL substring (checked in array order, first match wins — routes
 * for a redirect's target URL must come before a broader route it would also match), record
 * calls (headers/body) for assertions. `location` scripts a redirect response. */
function fakeFetch(routes: Array<{ match: string; status?: number; data?: unknown; raw?: string; location?: string }>) {
	const calls: Array<{ url: string; headers?: Record<string, string>; body?: string }> = [];
	const fetchFn: FetchLike = async (url, init) => {
		calls.push({ url, headers: init?.headers, body: init?.body });
		const r = routes.find((r) => url.includes(r.match));
		if (!r) return { ok: false, status: 404, text: async () => JSON.stringify({ message: "no route" }) };
		const status = r.status ?? 200;
		return {
			ok: status < 300,
			status,
			headers: { get: (name: string) => (name.toLowerCase() === "location" ? (r.location ?? null) : null) },
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

	it("KILLING: identity-only token exchange (orgId omitted) sends a body with NO org_id key at all — not an empty string, the key must be ABSENT (cws-core distinguishes the two)", async () => {
		const { fetchFn, calls } = fakeFetch([{ match: "/auth/agent/token", data: { access_token: "jwt_identity_only" } }]);
		expect(await exchangeAgentToken(fetchFn, "https://x.test", "sk")).toBe("jwt_identity_only");
		const body = JSON.parse(calls[0].body!) as Record<string, unknown>;
		expect(Object.keys(body)).toEqual([]);
		expect("org_id" in body).toBe(false);
	});

	it("KILLING: CF-Access headers (COCO_CF_ACCESS_CLIENT_ID/SECRET) are attached to every onboarding request — CF-gated deployments (e.g. cws-int) 403 at the Access layer without them, before ever reaching cws-core", async () => {
		const prevId = process.env.COCO_CF_ACCESS_CLIENT_ID;
		const prevSecret = process.env.COCO_CF_ACCESS_CLIENT_SECRET;
		process.env.COCO_CF_ACCESS_CLIENT_ID = "cf_id_1";
		process.env.COCO_CF_ACCESS_CLIENT_SECRET = "cf_secret_1";
		try {
			const { fetchFn: postFetch, calls: postCalls } = fakeFetch([{ match: "/auth/agent/token", data: { access_token: "jwt_1" } }]);
			await exchangeAgentToken(postFetch, "https://x.test", "sk", "org_1");
			expect(postCalls[0].headers?.["CF-Access-Client-Id"]).toBe("cf_id_1");
			expect(postCalls[0].headers?.["CF-Access-Client-Secret"]).toBe("cf_secret_1");

			const { fetchFn: getFetch, calls: getCalls } = fakeFetch([{ match: "/api/v1/me", data: { member_id: "m_9", display_name: "codex-bot" } }]);
			await fetchSelf(getFetch, "https://x.test", "jwt_1");
			expect(getCalls[0].headers?.["CF-Access-Client-Id"]).toBe("cf_id_1");
			expect(getCalls[0].headers?.["CF-Access-Client-Secret"]).toBe("cf_secret_1");
		} finally {
			if (prevId === undefined) delete process.env.COCO_CF_ACCESS_CLIENT_ID;
			else process.env.COCO_CF_ACCESS_CLIENT_ID = prevId;
			if (prevSecret === undefined) delete process.env.COCO_CF_ACCESS_CLIENT_SECRET;
			else process.env.COCO_CF_ACCESS_CLIENT_SECRET = prevSecret;
		}
	});

	it("KILLING: no CF-Access env set -> no CF-Access-Client-Id/Secret headers at all (unprotected deployments unaffected)", async () => {
		const { fetchFn, calls } = fakeFetch([{ match: "/auth/agent/token", data: { access_token: "jwt_1" } }]);
		await exchangeAgentToken(fetchFn, "https://x.test", "sk", "org_1");
		expect(calls[0].headers?.["CF-Access-Client-Id"]).toBeUndefined();
		expect(calls[0].headers?.["CF-Access-Client-Secret"]).toBeUndefined();
	});

	it("KILLING (credential-leak guard, mirrors SDK P1-C): a SAME-origin redirect is followed transparently", async () => {
		const { fetchFn, calls } = fakeFetch([
			{ match: "/auth/agent/token/v2", data: { access_token: "jwt_1" } },
			{ match: "/auth/agent/token", status: 302, location: "https://x.test/auth/agent/token/v2" },
		]);
		expect(await exchangeAgentToken(fetchFn, "https://x.test", "sk", "org_1")).toBe("jwt_1");
		expect(calls).toHaveLength(2);
		expect(calls[1].url).toBe("https://x.test/auth/agent/token/v2");
	});

	it("KILLING (credential-leak guard, mirrors SDK P1-C): a CROSS-origin redirect is refused — the Bearer api_key must never reach a third-party host", async () => {
		const { fetchFn, calls } = fakeFetch([{ match: "/auth/agent/token", status: 302, location: "https://evil.test/steal" }]);
		const err = await exchangeAgentToken(fetchFn, "https://x.test", "sk", "org_1").catch((e: Error) => e);
		expect((err as Error).message).toContain("cross-origin redirect");
		expect((err as Error).message).toContain("evil.test");
		expect(calls).toHaveLength(1); // never followed to the malicious host
	});

	it("HTTP-error messages use the endpoint LABEL, not the raw URL (postJson redaction — defensive: keeps any future id-bearing URL out of user-visible errors)", async () => {
		const { fetchFn } = fakeFetch([{ match: "/auth/agent/token", status: 401, raw: JSON.stringify({ message: "bad key" }) }]);
		const err = await exchangeAgentToken(fetchFn, "https://secret-host.test", "sk", "org_1").catch((e: Error) => e);
		expect((err as Error).message).toContain("agent token exchange");
		expect((err as Error).message).not.toContain("https://secret-host.test");
	});

	it("KILLING: cws-core errors are RFC 9457 problem+json (`detail`/`code`, NOT `message`/`error`) — the real error text must survive, not just a bare HTTP status", async () => {
		const { fetchFn } = fakeFetch([
			{
				match: "/invitations/inv_1/accept",
				status: 409,
				raw: JSON.stringify({ type: "https://git.coco.xyz/coco-workspace/cws-core/errors/MEMBER_INVALID_AGENT_OWNER", title: "Conflict", status: 409, detail: "new owner must be an active human member of the organization", code: "MEMBER_INVALID_AGENT_OWNER" }),
			},
		]);
		const err = await acceptInvitation(fetchFn, "https://x.test", "identity_jwt", "inv_1", "tok").catch((e: Error) => e);
		expect((err as Error).message).toContain("new owner must be an active human member");
		expect((err as Error).message).toContain("MEMBER_INVALID_AGENT_OWNER");
	});

	it("KILLING: fetchSelf surfaces the real cws-core `detail` on error too, not just a bare HTTP status (it previously discarded the body entirely)", async () => {
		const { fetchFn } = fakeFetch([{ match: "/api/v1/me", status: 403, raw: JSON.stringify({ detail: "org membership required", code: "ORG_MEMBERSHIP_REQUIRED" }) }]);
		const err = await fetchSelf(fetchFn, "https://x.test", "jwt_1").catch((e: Error) => e);
		expect((err as Error).message).toContain("org membership required");
		expect((err as Error).message).toContain("ORG_MEMBERSHIP_REQUIRED");
	});

	it("fetchSelf reads /api/v1/me with Bearer and maps member_id/display_name", async () => {
		const { fetchFn, calls } = fakeFetch([{ match: "/api/v1/me", data: { member_id: "m_9", display_name: "codex-bot" } }]);
		expect(await fetchSelf(fetchFn, "https://x.test", "jwt_1")).toEqual({ memberId: "m_9", displayName: "codex-bot" });
		expect(calls[0].headers?.authorization).toBe("Bearer jwt_1");
	});
});

describe("onboarding: self-registration + invitation accept (contra the file's earlier wrong claim that self-accept is human-only)", () => {
	it("KILLING: registerAgent POSTs /auth/register/agent with NO auth header and an empty body, unwraps identity_id/api_key from the D8 envelope", async () => {
		const { fetchFn, calls } = fakeFetch([{ match: "/auth/register/agent", data: { identity_id: "id_new", api_key: "sk_new" } }]);
		expect(await registerAgent(fetchFn, "https://x.test")).toEqual({ identityId: "id_new", apiKey: "sk_new" });
		expect(calls[0].url).toContain("/auth/register/agent");
		expect(calls[0].headers?.authorization).toBeUndefined();
		expect(JSON.parse(calls[0].body!)).toEqual({});
	});

	it("KILLING: acceptInvitation POSTs /api/v1/invitations/{id}/accept with Authorization: Bearer <identity JWT> and body {token} — this is NOT rejected for an agent-held JWT", async () => {
		const { fetchFn, calls } = fakeFetch([
			{ match: "/invitations/inv_123/accept", data: { member_id: "m_9", org_id: "org_from_accept", role_slug: "member" } },
		]);
		const result = await acceptInvitation(fetchFn, "https://x.test", "identity_jwt_1", "inv_123", "tok_abc");
		expect(result).toEqual({ memberId: "m_9", orgId: "org_from_accept", roleSlug: "member" });
		expect(calls[0].url).toContain("/api/v1/invitations/inv_123/accept");
		expect(calls[0].headers?.authorization).toBe("Bearer identity_jwt_1");
		expect(JSON.parse(calls[0].body!)).toEqual({ token: "tok_abc" });
	});

	it("acceptInvitation propagates a rejection (e.g. MEMBER_INVALID_AGENT_OWNER for an invalid resolved owner) without leaking the bearer JWT or token in the error message", async () => {
		const { fetchFn } = fakeFetch([
			{ match: "/invitations/inv_bad/accept", status: 422, raw: JSON.stringify({ message: "MEMBER_INVALID_AGENT_OWNER: new owner must be an active human member" }) },
		]);
		const err = await acceptInvitation(fetchFn, "https://x.test", "identity_jwt_SECRET", "inv_bad", "tok_SECRET").catch((e: Error) => e);
		expect((err as Error).message).toContain("invitation accept");
		expect((err as Error).message).not.toContain("identity_jwt_SECRET");
		expect((err as Error).message).not.toContain("tok_SECRET");
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

describe("onboarding: buildConfig pipeline (invitation_id + invitation_token, self-register)", () => {
	const ROUTES = [
		{ match: "/auth/register/agent", data: { identity_id: "id_registered", api_key: "sk_registered" } },
		{ match: "/invitations/inv_1/accept", data: { member_id: "m_accept", org_id: "org_from_accept", role_slug: "member" } },
		{ match: "/auth/agent/token", data: { access_token: "jwt_whichever" } },
		{ match: "/api/v1/me", data: { member_id: "m_9", display_name: "codex-bot" } },
	];

	it("KILLING: self-register -> identity JWT -> accept -> org JWT -> hydrate produces the IDENTICAL config.json shape as the direct-credential path", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		const cfg = await buildConfig(fetchFn, {
			bff_url: "https://x.test",
			ws_url: "wss://x.test/ws",
			org_id: "org_caller_supplied", // must be IGNORED in favor of the accept response's org_id
			invitation_id: "inv_1",
			invitation_token: "tok_1",
			local_http_port: 9999,
		});
		expect(cfg).toEqual({
			cws: { bffUrl: "https://x.test", wsUrl: "wss://x.test/ws", identityId: "id_registered", apiKey: "sk_registered" },
			codex: { bin: "codex", cwd: "." },
			bridge: { localHttpPort: 9999 },
			org: { org_id: "org_from_accept", self: { member_id: "m_9", display_name: "codex-bot" }, access: { dmPolicy: "open" } },
		});
		// full sequence: register, identity-only exchange, accept, org-scoped exchange, /me
		expect(calls.filter((c) => c.url.includes("/auth/register/agent"))).toHaveLength(1);
		expect(calls.filter((c) => c.url.includes("/accept"))).toHaveLength(1);
		expect(calls.filter((c) => c.url.includes("/auth/agent/token"))).toHaveLength(2); // identity-only, then org-scoped
		const tokenCallBodies = calls.filter((c) => c.url.includes("/auth/agent/token")).map((c) => JSON.parse(c.body!));
		expect(tokenCallBodies[0]).toEqual({}); // identity-only: no org_id key
		expect(tokenCallBodies[1]).toEqual({ org_id: "org_from_accept" }); // org-scoped, using the ACCEPT response's org_id
	});

	it("default port when omitted (self-register path)", async () => {
		const { fetchFn } = fakeFetch(ROUTES);
		const cfg = await buildConfig(fetchFn, { bff_url: "https://x.test", ws_url: "wss://x.test/ws", org_id: "org_x", invitation_id: "inv_1", invitation_token: "tok_1" });
		expect((cfg.bridge as { localHttpPort: number }).localHttpPort).toBe(8787);
	});

	it("KILLING: missing invitation_token -> hard error before any network call (no api_key/identity_id supplied either)", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		await expect(
			buildConfig(fetchFn, { bff_url: "https://x.test", ws_url: "wss://x.test/ws", org_id: "org_x", invitation_id: "inv_1" } as never),
		).rejects.toThrow(/invitation_token/);
		expect(calls).toHaveLength(0);
	});

	it("KILLING: missing invitation_id -> hard error before any network call", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		await expect(
			buildConfig(fetchFn, { bff_url: "https://x.test", ws_url: "wss://x.test/ws", org_id: "org_x", invitation_token: "tok_1" } as never),
		).rejects.toThrow(/invitation_id/);
		expect(calls).toHaveLength(0);
	});

	it("KILLING: neither shape present at all -> hard error before any network call, and the error never echoes any (nonexistent) secret material", async () => {
		const { fetchFn, calls } = fakeFetch(ROUTES);
		const err = await buildConfig(fetchFn, { bff_url: "https://x.test", ws_url: "wss://x.test/ws", org_id: "org_x" } as never).catch((e: Error) => e);
		expect((err as Error).message).toMatch(/api_key|identity_id|invitation_id|invitation_token/);
		expect(calls).toHaveLength(0);
	});

	it("a failing accept (e.g. bad/expired invitation token) never leaks the api_key registerAgent just minted", async () => {
		const { fetchFn } = fakeFetch([
			{ match: "/auth/register/agent", data: { identity_id: "id_registered", api_key: "sk_SECRET_MINTED" } },
			{ match: "/auth/agent/token", data: { access_token: "jwt_identity" } },
			{ match: "/invitations/inv_1/accept", status: 404, raw: JSON.stringify({ message: "invitation not found" }) },
		]);
		const err = await buildConfig(fetchFn, {
			bff_url: "https://x.test",
			ws_url: "wss://x.test/ws",
			org_id: "org_x",
			invitation_id: "inv_1",
			invitation_token: "tok_1",
		}).catch((e: Error) => e);
		expect((err as Error).message).not.toContain("sk_SECRET_MINTED");
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
