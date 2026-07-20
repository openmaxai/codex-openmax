// P2-① init plumbing: invitation redemption + org hydration (docs/onboarding-design.md).
// Endpoints pinned from the installed SDK (services/core.js invitationAccept → apiPath
// `/api/v1${p}`) and from the proven live-roundtrip logs (/auth/agent/token exchange).
// fetch is injected for tests; node 20 global fetch in production.

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
	ok: boolean;
	status: number;
	text(): Promise<string>;
}>;

/** `label` is the REDACTED endpoint name used in every user-visible error — never the raw
 * URL: the invitation-accept URL embeds the invitation id, and the prompt contract promises
 * failures can be pasted back without leaking credential material. */
async function postJson(fetchFn: FetchLike, url: string, label: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
	const res = await fetchFn(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
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
		const msg = (parsed as { message?: string; error?: string }).message ?? (parsed as { error?: string }).error ?? "";
		throw new Error(`${label} → HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
	}
	// cws-core envelope: { $schema, data, request_id, ... } — unwrap when present.
	const o = parsed as Record<string, unknown>;
	return (typeof o.data === "object" && o.data !== null ? o.data : o) as Record<string, unknown>;
}

export interface RedeemResult {
	identityId: string;
	apiKey: string;
	memberId?: string;
	displayName?: string;
}

/** POST /api/v1/invitations/{id}/accept {token} — the token IS the credential (no auth header).
 * Field names follow the platform's snake_case; fail loudly listing received keys (never values)
 * if the shape drifts, so a contract change surfaces as an actionable error, not a bad config. */
export async function redeemInvitation(
	fetchFn: FetchLike,
	bffUrl: string,
	invitationId: string,
	token: string,
): Promise<RedeemResult> {
	const data = await postJson(fetchFn, `${bffUrl}/api/v1/invitations/${invitationId}/accept`, "invitation accept (/api/v1/invitations/…/accept)", { token });
	const identityId = data.identity_id ?? data.identityId;
	const apiKey = data.api_key ?? data.apiKey;
	if (typeof identityId !== "string" || typeof apiKey !== "string") {
		throw new Error(`invitation accepted but response lacks identity_id/api_key (got keys: ${Object.keys(data).join(", ")})`);
	}
	const memberId = data.member_id ?? data.memberId;
	const displayName = data.display_name ?? data.displayName;
	return {
		identityId,
		apiKey,
		...(typeof memberId === "string" ? { memberId } : {}),
		...(typeof displayName === "string" ? { displayName } : {}),
	};
}

/** POST /auth/agent/token {org_id} with `Authorization: Bearer <api_key>` — the shape the
 * SDK's own TokenManager sends (transport/token.js) and cws-core reads; pinned by 0t's R1
 * against SDK contract auth-lifecycle.md (the live logs showed URL+body only, headers were
 * TokenManager-internal — do not "re-derive" this header from logs again). */
export async function exchangeAgentToken(fetchFn: FetchLike, bffUrl: string, apiKey: string, orgId: string): Promise<string> {
	const data = await postJson(fetchFn, `${bffUrl}/auth/agent/token`, "agent token exchange (/auth/agent/token)", { org_id: orgId }, { authorization: `Bearer ${apiKey}` });
	const jwt = data.access_token;
	if (typeof jwt !== "string") throw new Error(`agent token exchange returned no access_token (keys: ${Object.keys(data).join(", ")})`);
	return jwt;
}

export interface SelfInfo {
	memberId: string;
	displayName: string;
}

/** GET /api/v1/me with the org JWT — hydrates the config's org.self block. */
export async function fetchSelf(fetchFn: FetchLike, bffUrl: string, jwt: string): Promise<SelfInfo> {
	const res = await fetchFn(`${bffUrl}/api/v1/me`, { method: "GET", headers: { authorization: `Bearer ${jwt}` } });
	const text = await res.text();
	if (!res.ok) throw new Error(`/api/v1/me → HTTP ${res.status}`);
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
	invitation_id?: string;
	invitation_token?: string;
	api_key?: string;
	identity_id?: string;
	local_http_port?: number;
}

/** Full init pipeline → the config.json object (same shape the P1 stack already runs on). */
export async function buildConfig(fetchFn: FetchLike, input: OnboardInput): Promise<Record<string, unknown>> {
	let apiKey = input.api_key;
	let identityId = input.identity_id;
	if (apiKey) {
		// Direct-key path: identity_id is REQUIRED (config.ts validation demands cws.identityId;
		// a config without it would be written here only to be rejected by `start`). Validated
		// before any network call.
		if (!identityId) throw new Error("api_key path requires identity_id (start's config validation demands it)");
	} else {
		if (!input.invitation_id || !input.invitation_token) throw new Error("need invitation_id+invitation_token or api_key");
		const redeemed = await redeemInvitation(fetchFn, input.bff_url, input.invitation_id, input.invitation_token);
		apiKey = redeemed.apiKey;
		identityId = redeemed.identityId;
	}
	const jwt = await exchangeAgentToken(fetchFn, input.bff_url, apiKey, input.org_id);
	const self = await fetchSelf(fetchFn, input.bff_url, jwt);
	return {
		cws: { bffUrl: input.bff_url, wsUrl: input.ws_url, identityId, apiKey },
		codex: { bin: "codex", cwd: "." },
		bridge: { localHttpPort: input.local_http_port ?? 8787 },
		org: {
			org_id: input.org_id,
			self: { member_id: self.memberId, display_name: self.displayName },
			access: { dmPolicy: "open" },
		},
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
