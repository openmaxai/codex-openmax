// P2-① init plumbing: JWT exchange + org self-hydration (docs/onboarding-design.md).
// Two supported onboarding credential shapes: (a) a platform-provisioned api_key +
// identity_id supplied directly, or (b) an invitation_id + invitation_token, which init
// redeems itself via self-register -> identity-only JWT -> accept invitation -> org JWT.
// (Corrected 2026-07-20: an earlier read of a live 401/MEMBER_INVALID_AGENT_OWNER response
// was misdiagnosed as "agents can't self-accept invitations" — cws-core's own tests
// (TestAcceptInvitationSetsInviterAsAgentOwner, TestAcceptInvitationUsesRequestedOwnerOverInviter)
// confirm agent self-accept works; that error fires only when the invitation's resolved
// owner field is itself invalid, unrelated to whether the acceptor is an agent. This is the
// same flow the platform's default "zylos" agent type already uses for self-onboarding.)
// Header/endpoint shapes pinned from the SDK's TokenManager + a live check.
// fetch is injected for tests; node 20 global fetch in production.
//
// CF-Access: on a CF-gated deployment (e.g. cws-int), every request below needs
// CF-Access-Client-Id/Secret or Cloudflare Access rejects it before it ever reaches
// cws-core — unrelated to cws-core auth. Reused from the SDK's own cfAccessHeaders()
// (reads COCO_CF_ACCESS_CLIENT_ID/SECRET from env; {} when unset, so it's safe to
// spread unconditionally on unprotected deployments too).
import { cfAccessHeaders } from "@openmaxai/openmax-agent-sdk";

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; redirect?: "manual" | "follow" };
export type FetchLike = (url: string, init?: FetchInit) => Promise<{
	ok: boolean;
	status: number;
	headers?: { get(name: string): string | null };
	text(): Promise<string>;
}>;
type FetchResponse = Awaited<ReturnType<FetchLike>>;

// ── redirect handling (credential-leak guard, mirrors the SDK's TokenManager/CwsHttpClient
// P1-C) ──────────────────────────────────────────────────────────────────────────────────
// register/token/accept/me all carry a Bearer credential (api_key or JWT) to cws-core.
// Native fetch auto-follows 3xx and RE-SENDS those headers to the redirect target — for a
// cross-origin redirect that leaks the credential to a third party. We disable auto-follow
// and refuse any hop that leaves the origin we started from.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

function safeOrigin(u: string): string {
	try {
		return new URL(u).origin;
	} catch {
		return u;
	}
}

// Matches native fetch's method/body semantics per the WHATWG Fetch spec: 301/302 downgrade
// POST->GET; 303 downgrades any non-GET/HEAD; 307/308 preserve method+body.
function rewriteInitForRedirect(init: FetchInit, status: number): FetchInit {
	const method = (init.method ?? "GET").toUpperCase();
	const isGetOrHead = method === "GET" || method === "HEAD";
	const downgradeToGet = (status === 303 && !isGetOrHead) || ((status === 301 || status === 302) && method === "POST");
	if (!downgradeToGet) return init;
	const { body: _body, ...rest } = init;
	return { ...rest, method: "GET" };
}

async function fetchNoAutoFollow(fetchFn: FetchLike, url: string, init: FetchInit): Promise<FetchResponse> {
	const startOrigin = safeOrigin(url);
	let curUrl = url;
	let curInit: FetchInit = { ...init, redirect: "manual" };
	for (let hop = 0; ; hop++) {
		const res = await fetchFn(curUrl, curInit);
		if (!REDIRECT_STATUSES.has(res.status)) return res;
		const loc = res.headers?.get("location") ?? res.headers?.get("Location") ?? null;
		if (!loc) return res;
		if (hop >= MAX_REDIRECT_HOPS) throw new Error(`too many redirects (>${MAX_REDIRECT_HOPS}) from ${url}`);
		let nextUrl: string;
		try {
			nextUrl = new URL(loc, curUrl).toString();
		} catch {
			throw new Error(`invalid redirect Location "${loc}" from ${curUrl}`);
		}
		if (safeOrigin(nextUrl) !== startOrigin) {
			throw new Error(`refusing cross-origin redirect to ${safeOrigin(nextUrl)} that would carry the auth credential (from ${startOrigin})`);
		}
		curUrl = nextUrl;
		curInit = rewriteInitForRedirect(curInit, res.status);
	}
}

/** `label` is the REDACTED endpoint name used in every user-visible error — never the raw
 * URL. Defensive: no current endpoint embeds a secret in its URL, but the platform prompt
 * invites users to paste failures back, so error text must never carry credential material. */
async function postJson(fetchFn: FetchLike, url: string, label: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
	const res = await fetchNoAutoFollow(fetchFn, url, {
		method: "POST",
		headers: { "content-type": "application/json", ...cfAccessHeaders(), ...headers },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`${label} → HTTP ${res.status}, non-JSON body`);
	}
	if (!res.ok) {
		// cws-core errors are RFC 9457 problem+json — `detail` is the human-readable message,
		// `code` a stable identifier (e.g. MEMBER_INVALID_AGENT_OWNER); there is NO `message` or
		// `error` key. Those two are kept as a defensive fallback (matches the SDK's own
		// `detail || error || message` priority) in case a non-cws-core hop in front (e.g. an
		// edge proxy) ever returns a differently-shaped error body.
		const p = parsed as { detail?: string; code?: string; message?: string; error?: string };
		const msg = p.detail ?? p.error ?? p.message ?? "";
		const code = p.code ? ` (${p.code})` : "";
		throw new Error(`${label} → HTTP ${res.status}${msg ? `: ${msg}` : ""}${code}`);
	}
	// cws-core envelope: { $schema, data, request_id, ... } — unwrap when present.
	const o = parsed as Record<string, unknown>;
	return (typeof o.data === "object" && o.data !== null ? o.data : o) as Record<string, unknown>;
}

/** POST /auth/agent/token {org_id} with `Authorization: Bearer <api_key>` — the shape the
 * SDK's own TokenManager sends (transport/token.js) and cws-core reads; pinned by 0t's R1
 * against SDK contract auth-lifecycle.md (the live logs showed URL+body only, headers were
 * TokenManager-internal — do not "re-derive" this header from logs again).
 *
 * `orgId` is optional: when omitted, the `org_id` key is left out of the body entirely (NOT
 * sent as an empty string — cws-core's contract distinguishes "key absent" from "key present
 * but empty") and the returned JWT is identity-only, not org-scoped. The self-register flow
 * needs an identity-only JWT to call acceptInvitation before any org membership exists. */
export async function exchangeAgentToken(fetchFn: FetchLike, bffUrl: string, apiKey: string, orgId?: string): Promise<string> {
	const body: Record<string, string> = {};
	if (orgId !== undefined) body.org_id = orgId;
	const data = await postJson(fetchFn, `${bffUrl}/auth/agent/token`, "agent token exchange (/auth/agent/token)", body, { authorization: `Bearer ${apiKey}` });
	const jwt = data.access_token;
	if (typeof jwt !== "string") throw new Error(`agent token exchange returned no access_token (keys: ${Object.keys(data).join(", ")})`);
	return jwt;
}

/** POST /auth/register/agent — self-registration, no auth required. Returns a fresh
 * identity_id + api_key in the standard D8 envelope. This is the same first step the
 * platform's default "zylos" agent type uses to onboard itself (cws-core's zylosInstallSpec
 * prompt template): register -> identity-only JWT -> accept invitation -> org-scoped JWT. */
export async function registerAgent(fetchFn: FetchLike, bffUrl: string): Promise<{ identityId: string; apiKey: string }> {
	const data = await postJson(fetchFn, `${bffUrl}/auth/register/agent`, "agent self-registration (/auth/register/agent)", {});
	const identityId = data.identity_id;
	const apiKey = data.api_key;
	if (typeof identityId !== "string" || typeof apiKey !== "string") {
		throw new Error(`agent self-registration returned no identity_id/api_key (keys: ${Object.keys(data).join(", ")})`);
	}
	return { identityId, apiKey };
}

/** POST /api/v1/invitations/{invitationId}/accept with `Authorization: Bearer <identity-only
 * JWT>` (from exchangeAgentToken called WITHOUT orgId) and body `{token}`. Live-tested and
 * confirmed to return 200 with `{member_id, org_id, role_slug}` for an agent-held identity
 * JWT — this is not human-only (see the file-header note above). The returned `org_id` is
 * authoritative: it's what the invitation actually resolved to, independent of whatever
 * org_id the caller may have supplied for reference. */
export async function acceptInvitation(
	fetchFn: FetchLike,
	bffUrl: string,
	identityJwt: string,
	invitationId: string,
	token: string,
): Promise<{ memberId: string; orgId: string; roleSlug: string }> {
	const data = await postJson(
		fetchFn,
		`${bffUrl}/api/v1/invitations/${invitationId}/accept`,
		"invitation accept (/api/v1/invitations/{id}/accept)",
		{ token },
		{ authorization: `Bearer ${identityJwt}` },
	);
	const memberId = data.member_id;
	const orgId = data.org_id;
	const roleSlug = data.role_slug;
	if (typeof memberId !== "string" || typeof orgId !== "string" || typeof roleSlug !== "string") {
		throw new Error(`invitation accept returned incomplete data (keys: ${Object.keys(data).join(", ")})`);
	}
	return { memberId, orgId, roleSlug };
}

export interface SelfInfo {
	memberId: string;
	displayName: string;
}

/** GET /api/v1/me with the org JWT — hydrates the config's org.self block. */
export async function fetchSelf(fetchFn: FetchLike, bffUrl: string, jwt: string): Promise<SelfInfo> {
	const res = await fetchNoAutoFollow(fetchFn, `${bffUrl}/api/v1/me`, { method: "GET", headers: { authorization: `Bearer ${jwt}`, ...cfAccessHeaders() } });
	const text = await res.text();
	if (!res.ok) {
		// Same RFC 9457 problem+json shape as postJson's error path — see its comment for why
		// `detail`/`code` (not `message`/`error`) are the real cws-core fields.
		let p: { detail?: string; code?: string; message?: string; error?: string } = {};
		try {
			p = JSON.parse(text);
		} catch {
			// non-JSON body — fall through with an empty detail
		}
		const msg = p.detail ?? p.error ?? p.message ?? "";
		const code = p.code ? ` (${p.code})` : "";
		throw new Error(`/api/v1/me → HTTP ${res.status}${msg ? `: ${msg}` : ""}${code}`);
	}
	const o = JSON.parse(text) as { data?: Record<string, unknown> };
	const d = (o.data ?? o) as Record<string, unknown>;
	const memberId = d.member_id ?? d.id;
	const displayName = d.display_name ?? d.name;
	if (typeof memberId !== "string" || typeof displayName !== "string") {
		throw new Error(`/api/v1/me lacks member_id/display_name (keys: ${Object.keys(d).join(", ")})`);
	}
	return { memberId, displayName };
}

export interface OnboardInput {
	bff_url: string;
	ws_url: string;
	org_id: string;
	// Two credential shapes — direct takes priority when both are supplied:
	//  (a) direct — a platform-provisioned agent api_key + identity_id, supplied as-is (the
	//      "Add Codex agent" human-already-logged-in flow). Wins if any of api_key/identity_id
	//      is present, even alongside an invitation_id/invitation_token.
	//  (b) self-register — an invitation_id + invitation_token, used only when neither
	//      api_key nor identity_id is present. `buildConfig` self-registers a
	//      new agent identity (POST /auth/register/agent), exchanges an identity-only JWT,
	//      accepts the invitation with it, then exchanges an org-scoped JWT using the same
	//      api_key. Same self-register -> identity JWT -> accept -> org JWT pattern the
	//      platform's default "zylos" agent type already uses.
	api_key?: string;
	identity_id?: string;
	invitation_id?: string;
	invitation_token?: string;
	local_http_port?: number;
}

/** Full init pipeline → the config.json object (same shape the P1 stack already runs on).
 * Dispatches on which credential shape `input` supplies — see OnboardInput. Validates fully
 * before any network call either way (config.ts demands agent.identity_id; a config missing it
 * would be written only for `start` to reject it). */
export async function buildConfig(fetchFn: FetchLike, input: OnboardInput): Promise<Record<string, unknown>> {
	const { api_key: apiKey, identity_id: identityId, invitation_id: invitationId, invitation_token: invitationToken } = input;
	const hasAnyDirect = Boolean(apiKey || identityId);
	const hasAnyInvitation = Boolean(invitationId || invitationToken);

	if (hasAnyDirect || !hasAnyInvitation) {
		// Direct-credential shape (also the fallback when neither shape is fully present, so
		// the error names the primary field first).
		if (!apiKey) throw new Error("missing required field: api_key");
		if (!identityId) throw new Error("missing required field: identity_id");
		const jwt = await exchangeAgentToken(fetchFn, input.bff_url, apiKey, input.org_id);
		const self = await fetchSelf(fetchFn, input.bff_url, jwt);
		return assembleConfig(input, identityId, apiKey, input.org_id, self);
	}

	// Self-register shape: register -> identity-only JWT -> accept invitation -> org JWT.
	if (!invitationId) throw new Error("missing required field: invitation_id");
	if (!invitationToken) throw new Error("missing required field: invitation_token");
	const registered = await registerAgent(fetchFn, input.bff_url);
	const identityJwt = await exchangeAgentToken(fetchFn, input.bff_url, registered.apiKey);
	const accepted = await acceptInvitation(fetchFn, input.bff_url, identityJwt, invitationId, invitationToken);
	// accepted.orgId is authoritative (what the invitation actually resolved to), not the
	// caller-supplied input.org_id — trust the accept response over the reference value.
	const orgJwt = await exchangeAgentToken(fetchFn, input.bff_url, registered.apiKey, accepted.orgId);
	const self = await fetchSelf(fetchFn, input.bff_url, orgJwt);
	return assembleConfig(input, registered.identityId, registered.apiKey, accepted.orgId, self);
}

/** Assemble the config.json object in the bridge / openmax-mirrored shape (see
 * config.ts for the full field map), keeping the codex-openmax runtime-specific
 * blocks (`codex`, `bridge`). The per-org `access` block is emitted COMPLETE
 * ({dmPolicy, dmAllowFrom, groupPolicy, groups}) with claude-openmax's onboarding
 * defaults — a private-by-default posture the old `{dmPolicy:"open"}` could not
 * express — so an operator can widen it later without hand-editing the shape. */
function assembleConfig(input: OnboardInput, identityId: string, apiKey: string, orgId: string, self: SelfInfo): Record<string, unknown> {
	return {
		enabled: true,
		server: { bff_url: input.bff_url, ws_url: input.ws_url, frontend_base_path: "/workspace" },
		agent: {
			identity_id: identityId,
			api_key: apiKey,
			// Global device id derived from the resolved member_id (preserves the old
			// per-org derivation as a stable, human-recognizable default).
			device_id: `codex-openmax-${self.memberId.slice(-6)}`,
			app_version: "codex-openmax/0.1.0",
		},
		orgs: {
			[orgId]: {
				enabled: true,
				org_id: orgId,
				org_name: "",
				owner: { member_id: "", name: "" },
				self: { member_id: self.memberId, name: self.displayName, display_name: self.displayName },
				access: { dmPolicy: "owner", dmAllowFrom: [], groupPolicy: "allowlist", groups: {} },
			},
		},
		codex: { bin: "codex", cwd: "." },
		bridge: { localHttpPort: input.local_http_port ?? 8787 },
	};
}

/** Write config.json guaranteeing FINAL 0600 permissions even when overwriting an existing
 * (possibly wider-mode) file. Three layers, because `writeFileSync`'s `mode` only applies at
 * CREATION (0t R1) — including for the TEMP file itself if its predictable path pre-exists
 * (0t R2, same root cause one level down):
 *   1. remove any stale/planted temp first — never truncate-in-place a file we didn't create;
 *   2. exclusive create (`wx`) — if something races the temp back in, we throw instead of
 *      inheriting its mode;
 *   3. explicit chmod 0600 before rename — holds regardless of creation semantics or umask. */
export function writeConfigFile(
	fs: Pick<typeof import("node:fs"), "writeFileSync" | "renameSync" | "rmSync" | "chmodSync">,
	path: string,
	config: unknown,
): void {
	const tmp = `${path}.tmp-${process.pid}`;
	fs.rmSync(tmp, { force: true });
	fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, path);
}
