// Agent access-policy reconcile between the local `access` block and cws-core.
//
// THE BUG THIS FIXES: this adapter never reported its access policy. cws-comm's
// `cws_agent_policies` therefore had no row for the agent, and cws-core's GetFullPolicy
// synthesizes a default snapshot when the row is missing (dm_policy "owner",
// group_scope "open", updated_at zero — cws-comm internal/app/agent_policy_service.go
// GetFullPolicy). So the settings page showed "open to all groups" while the agent
// locally ran groupPolicy=allowlist with an empty groups{} and refused every group; the
// group-allowlist editor also stayed unrendered because it only renders for
// scope=allowlist. Two sources of truth, no reconcile, and the page was the wrong one.
//
// WHY PULL-FIRST (GET before any PUT). A periodic unconditional PUT of the local block
// is the openclaw failure mode: everything the server holds but the local config does
// not express gets overwritten with the local default on the next tick, so a whitelist
// edited in the UI is erased minutes later. Every tick here starts with a GET and only
// PUTs when the read proves it is safe:
//   - the server has no policy row at all → nothing to erase → seed it (push),
//   - the server row changed since we last looked → the server is authoritative → adopt,
//   - the server is unchanged since our marker AND the local block changed → push,
//   - a failed GET → return. NEVER PUT on an unknown server state.
//
// CONSEQUENCE, DELIBERATE: once the server holds a row, the server wins. Editing
// config.json by hand on a running agent gets overwritten by the next tick. The escape
// hatch is the explicit `codex-openmax report-policy` command (force push), because this
// adapter has no config file watcher and cannot tell a human edit from a stale read.
//
// FAIL-OPEN: nothing here throws. Policy reporting is a projection of local state onto a
// dashboard; a reporting failure must never break message handling or the config-event
// path (config-events.ts rethrows genuine errors to get an SDK replay — a report error
// leaking into that path would spin the replay loop).
import type { ConfigProvider, Logger } from "./runtime-config.js";
import type { OrgConfig, OrgAccess } from "./config.js";
import type { HttpForOrg } from "./owner-sync.js";
import { everyMs } from "./scheduler.js";
// The gate's own enums, not a local copy: decideInbound branches on these exact strings, so
// a value it cannot read is a value that silently skips a gate. Re-exported from the package
// root (src/index.js `export * from './protocol/access-policy.js'`).
import { VALID_DM_POLICIES, VALID_GROUP_SCOPES, VALID_GROUP_MODES } from "@openmaxai/openmax-agent-sdk";

/**
 * Keep a server-supplied enum value only when the SDK's gate can actually read it.
 *
 * decideInbound tests group scope against 'disabled' and 'allowlist' and mode against
 * 'mention'; every other string falls through to handle:true. So an out-of-enum value
 * arriving on the wire (schema drift, a scope added server-side later, a proxy surprise)
 * would not merely be ignored — it would DISABLE the gate it was meant to configure.
 * Falls back to the local value, never to the server's own wider default.
 */
function adoptEnum(set: { has(v: string): boolean }, incoming: unknown, local: unknown, conservative: string): string {
	if (typeof incoming === "string" && set.has(incoming)) return incoming;
	if (typeof local === "string" && set.has(local)) return local;
	return conservative;
}

/**
 * HTTP surface this module needs: owner-sync's read-only `HttpForOrg` plus the PUT.
 * Declared as an EXTENSION rather than added to HttpForOrg so the existing read-only
 * fakes in test/owner-sync.test.ts and test/config-events.test.ts keep type-checking —
 * their "throw on anything unexpected" behaviour is a feature worth preserving. The
 * real SDK CwsHttpClient satisfies both structurally, so cli.ts passes one client
 * to both modules.
 */
export interface HttpPolicy extends HttpForOrg {
	putForOrg(orgId: string, path: string, body: unknown): Promise<unknown>;
}

/** One group entry on the wire (cws-core agentGroupPolicyItem). */
export interface ReportedGroupPolicy {
	conversation_id: string;
	mode: string;
	allow_from: string[];
}

/** PUT /api/v1/agents/{id}/reported-policy body (cws-core reportPolicyRequest.Body). */
export interface ReportedPolicy {
	dm_policy: string;
	dm_allowlist: string[];
	groups: ReportedGroupPolicy[];
	group_scope: string;
	group_allowlist: string[];
}

/** GET /api/v1/agents/{id}/policy body (cws-core getPolicyResponse.Body, read fields). */
export interface ServerPolicySnapshot {
	dm_policy?: string;
	dm_allowlist?: string[];
	groups?: Array<{ conversation_id?: string; mode?: string; allow_from?: string[] }>;
	/** Two wire forms in circulation — see normalizeUpdatedAt. */
	updated_at?: number | string | null;
	group_scope?: string;
	group_allowlist?: string[];
}

export type ReconcileOutcome =
	| "skipped:no-member-id"
	| "skipped:unsupported-http"
	| "skipped:get-failed"
	| "seeded"
	| "adopted"
	| "pushed"
	| "push-failed"
	| "noop";

/**
 * Group modes that are meaningful end to end — used on BOTH directions, for two reasons
 * that happen to select the same pair.
 *
 * Enforcement: decideInbound special-cases mode === 'mention' and nothing else, so 'smart'
 * and 'mention' are the only modes the gate can act on. This is why the SDK's own
 * VALID_GROUP_MODES is the wrong set to clamp an ADOPTED mode against: it contains
 * 'silent', which the gate does not implement, so a stored 'silent' behaves like 'smart'
 * and answers every message — the clamp would fire for values nobody sends and no-op for
 * the one the server actually sends (cws-core does store 'silent'; config-events.ts:21
 * accepts it on the push channel and drops the entry rather than storing the mode).
 *
 * Reporting: cws-comm's
 * ReportPolicy validates every group's mode against smart|mention and returns an
 * InputError for the FIRST offender, which fails the WHOLE report (400) — one silent
 * group would sink the entire snapshot. Such a group is therefore dropped from `groups`
 * AND from `group_allowlist` (leaving it in the allowlist while omitting its settings
 * would re-open it at the server's default mention mode).
 *
 * NOTE on what 'silent' actually does, since it is easy to assume otherwise: the SDK gate
 * has no 'silent' branch. decideInbound special-cases mode === 'mention' only, so a group
 * left at mode 'silent' behaves like 'smart' — it answers EVERY message. "Configured but
 * not participating" is produced by config-events.ts deleting the entry, not by storing
 * the mode. That is also why the adopt path does not carry local 'silent' entries over: a
 * preserved entry would answer everything in a group the owner silenced, which is worse
 * than the group falling out of the allowlist.
 */
const ENFORCEABLE_GROUP_MODES = new Set(["smart", "mention"]);

/**
 * Wire form of "everyone in this group may trigger me".
 *
 * The SDK's decideInbound (protocol/access-policy.js) treats undefined, [] and a list
 * containing '*' as identical — all three skip the allowFrom gate — but the server
 * stores what it is given, and `[]` is a TRUTHY empty array in JS, so the tempting
 * `allowFrom || ['*']` yields `[]` and would be shown as "nobody" by the settings page.
 * Normalize all three to the explicit ['*'].
 */
/**
 * updated_at as an opaque monotonic token.
 *
 * Two wire forms are in circulation for the same field: cws-core's BFF sends a number
 * (unix seconds) and cws-comm's own HTTP surface sends RFC3339. `Number(v) || 0` yields 0
 * forever on the string form, which would be read as "no policy row" — turning the seed
 * branch into an unconditional PUT every tick, exactly the erasure this module exists to
 * prevent. Only equality and zero-ness are ever compared, so the unit does not matter;
 * being parseable does.
 */
/** Tolerate a non-array container: the module header promises nothing here throws. */
function arr<T>(v: unknown): T[] {
	return Array.isArray(v) ? (v as T[]) : [];
}

function normalizeUpdatedAt(v: unknown): number {
	if (typeof v === "number") return Number.isFinite(v) ? v : 0;
	if (typeof v === "string" && v.trim()) {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
		const t = Date.parse(v);
		if (Number.isFinite(t)) return t;
	}
	return 0;
}

function normalizeAllowFrom(list: string[] | undefined): string[] {
	if (!Array.isArray(list) || list.length === 0) return ["*"];
	return [...list];
}

/**
 * Project the local `access` block onto the reported-policy wire shape.
 *
 * Every default here is the LITERAL sentinel the SDK's decideInbound applies, so what
 * the dashboard shows is what the agent actually enforces:
 *   dmPolicy    ?? 'owner'      (access-policy.js: `access.dmPolicy || 'owner'`)
 *   dmAllowFrom ?? []           (`access.dmAllowFrom || []`)
 *   groupPolicy ?? 'allowlist'  (`access.groupPolicy || 'allowlist'`)
 *   group mode  ?? 'mention'    (`groupCfg?.mode || 'mention'`)
 *
 * `group_scope` is ALWAYS sent explicitly: cws-core's report-policy handler coerces an
 * absent group_scope to "open" (agent_policy.go, `groupScope := "open"` when the pointer
 * is nil), i.e. omitting it would silently publish "reachable from every group" —
 * the exact opposite of the SDK's local 'allowlist' default.
 *
 * `group_allowlist` is derived from the reported groups' ids: the local model has no
 * separate allowlist, membership in `groups{}` IS the allowlist (decideInbound's
 * `policy === 'allowlist' && !groupCfg` gate).
 *
 * The owner's DM exemption (decideInbound `dm:owner-exempt`) has no server-side
 * expression. The owner is deliberately NOT injected into dm_allowlist: that would
 * publish a member-scoped grant the local policy does not have, and it would survive a
 * later owner transfer in the server's list.
 */
export function buildReportedPolicy(access: OrgAccess = {}): ReportedPolicy {
	const groups = Object.entries(access.groups || {})
		.map(([conversationId, cfg]) => ({
			conversation_id: conversationId,
			mode: cfg?.mode || "mention",
			allow_from: normalizeAllowFrom(cfg?.allowFrom),
		}))
		.filter((g) => ENFORCEABLE_GROUP_MODES.has(g.mode))
		// Sorted so the body (and therefore the fingerprint) is a deterministic function
		// of the access block, independent of key insertion order.
		.sort((a, b) => (a.conversation_id < b.conversation_id ? -1 : a.conversation_id > b.conversation_id ? 1 : 0));
	return {
		dm_policy: access.dmPolicy || "owner",
		dm_allowlist: [...(access.dmAllowFrom || [])],
		groups,
		group_scope: access.groupPolicy || "allowlist",
		group_allowlist: groups.map((g) => g.conversation_id),
	};
}

/**
 * Turn a server snapshot into a local `access` block (the pull direction).
 *
 * Membership derivation depends on the scope, because the server keeps allowlist
 * membership and per-group settings in two columns with different lifetimes:
 *
 * - Under 'allowlist' the `group_allowlist` column IS the authoritative membership list
 *   and `groups[]` only supplies mode/allowFrom for ids on it. Unioning here would
 *   resurrect a revoked group: cws-comm's UpdateGroupAllowlist("remove") drops the id
 *   from the allowlist and LEAVES the per-group row (agent_policy_service.go — the
 *   function contains no DeleteAgentGroupPolicies call), so the surviving row would put
 *   the group straight back and the owner's revocation could never stick.
 * - Under 'open'/'disabled' the allowlist is not a gate, so the two are unioned to keep
 *   per-group modes that would otherwise be lost.
 *
 * An id allowlisted with no per-group row yet (the UI's "add group" path) is still
 * adopted in both cases; its synthesized entry matches config-events.ts's own
 * group_allowlist_changed default, `{mode:'mention', allowFrom:['*']}`.
 *
 * Every enum arrives through adoptEnum: absent, empty AND out-of-enum values all fall
 * back to the local value, then to the conservative literal — never to the server's own
 * wider default. A malformed response must never widen the agent's exposure.
 */
export function adoptServerPolicy(snapshot: ServerPolicySnapshot | null | undefined, local: OrgAccess = {}): OrgAccess {
	const groupPolicy = adoptEnum(VALID_GROUP_SCOPES, snapshot?.group_scope, local.groupPolicy, "allowlist");

	// Per-group settings, keyed by conversation. Modes are clamped against the gate's enum
	// and fall back to whatever this conversation already had locally.
	const rows: NonNullable<OrgAccess["groups"]> = {};
	// 'silent' is not a mode this side can store: the gate cannot enforce it, so keeping it
	// verbatim answers everything and clamping it to 'mention' answers on @ — both contradict
	// the owner. It is a DROP SIGNAL, exactly as config-events.ts:108 treats the same value
	// arriving on the WS channel ("'silent' means don't participate → drop the entry"). Handled
	// here rather than in adoptEnum because the conversation must also leave the membership set
	// below: under allowlist scope the id is still sitting in the server's group_allowlist, and
	// synthesising a default entry for it would put the group straight back.
	const silenced = new Set<string>();
	for (const g of arr<{ conversation_id?: string; mode?: string; allow_from?: string[] }>(snapshot?.groups)) {
		const id = g?.conversation_id;
		if (!id) continue;
		if (g?.mode === "silent") {
			silenced.add(id);
			continue;
		}
		rows[id] = {
			mode: adoptEnum(ENFORCEABLE_GROUP_MODES, g?.mode, local.groups?.[id]?.mode, "mention"),
			allowFrom: normalizeAllowFrom(g?.allow_from),
		};
	}

	const allowlist = arr<string>(snapshot?.group_allowlist).filter(Boolean);
	const ids = (groupPolicy === "allowlist" ? allowlist : [...new Set([...Object.keys(rows), ...allowlist])]).filter((id) => !silenced.has(id));

	const groups: NonNullable<OrgAccess["groups"]> = {};
	for (const id of ids) groups[id] = rows[id] || { mode: "mention", allowFrom: ["*"] };

	return {
		dmPolicy: adoptEnum(VALID_DM_POLICIES, snapshot?.dm_policy, local.dmPolicy, "owner"),
		dmAllowFrom: [...arr<string>(snapshot?.dm_allowlist)],
		groupPolicy,
		groups,
	};
}

/**
 * Stable identity of the local policy AS REPORTED.
 *
 * Fingerprinting the projection rather than the raw access block buys two properties the
 * reconcile depends on: a local edit with no wire effect (a group left at its default
 * mode, an allowFrom of [] rewritten to ['*']) does not trigger a pointless PUT, and an
 * adopted snapshot fingerprints identically to the local block it was written into, so
 * the adopt path can recognise "already agreed" and skip the disk write.
 */
export function accessFingerprint(access: OrgAccess = {}): string {
	return JSON.stringify(buildReportedPolicy(access));
}

/** What the last completed reconcile saw, per org. See makeReconcilePolicy for why it lives in memory. */
interface PolicyMarker {
	/** accessFingerprint of the local block at that point. */
	fp: string;
	/** The snapshot's `updated_at` normalised to a comparable number; 0 when no row existed. */
	serverUpdatedAt: number;
}

function errStatus(err: unknown): number {
	return Number((err as { status?: unknown } | null)?.status) || 0;
}

function errText(err: unknown): string {
	const e = err as { message?: unknown; body?: unknown } | null;
	let text = typeof e?.message === "string" ? e.message : String(err);
	if (e?.body !== undefined) {
		try {
			text += ` ${JSON.stringify(e.body)}`;
		} catch {
			// non-serializable body — the message alone has to do.
		}
	}
	return text;
}

/**
 * Discriminate "the report named a group the server rejects" from "the endpoint does
 * not exist", both of which arrive as 404.
 *
 * cws-comm's ReportPolicy calls verifyAgentGroupMember for every reported group and
 * returns ErrNotFound (→ 404) wrapped as `group <conversation_id>: …` when the agent is
 * no longer a member of that conversation; a bad mode arrives the same way as a 400.
 * Both name the offending conversation, so the test is "does the error text contain one
 * of the conversation ids WE just reported" — that does not depend on the server's
 * wording. Treating every 404 as "endpoint missing" and then going permanently quiet
 * (the zylos behaviour) turns one stale group into a total reporting outage.
 */
export function findRejectedGroupId(err: unknown, body: ReportedPolicy): string {
	const status = errStatus(err);
	if (status < 400 || status >= 500) return "";
	const text = errText(err);
	for (const g of body.groups) {
		if (g.conversation_id && text.includes(g.conversation_id)) return g.conversation_id;
	}
	return "";
}

function withoutGroup(body: ReportedPolicy, conversationId: string): ReportedPolicy {
	return {
		...body,
		groups: body.groups.filter((g) => g.conversation_id !== conversationId),
		group_allowlist: body.group_allowlist.filter((id) => id !== conversationId),
	};
}

export interface ReconcileOptions {
	/**
	 * Skip the read-and-decide and push the local block (the `report-policy` command).
	 * This is the ONLY place a bare PUT is legal, and only because a human asked for
	 * "local wins" explicitly. Never set it on a timer.
	 */
	force?: boolean;
}

/**
 * Build the per-org policy reconcile bound to `http` + `provider`, shaped like
 * owner-sync's makeSyncSelf (same fail-open discipline, same in-place orgConfig write).
 *
 * The marker is per-factory IN-MEMORY state, not persisted. That is a safety choice, not
 * laziness: with no marker, a server row that exists always counts as "changed since we
 * last looked", so a fresh process ADOPTS the server before it can ever push. Persisting
 * the marker would let a restart decide the local block is newer and push a possibly
 * stale config over live server state — the erasure this module exists to prevent. The
 * cost is one extra adopt-shaped no-op per process start.
 */
export function makeReconcilePolicy(
	http: HttpPolicy,
	provider: ConfigProvider,
	log: Logger,
): (orgConfig: OrgConfig, opts?: ReconcileOptions) => Promise<ReconcileOutcome> {
	const markers = new Map<string, PolicyMarker>();
	// Once-guard for a cws-core without the reported-policy endpoint (mirrors the SDK
	// metrics reporter's runtime-metrics 404 guard): warn once, then stay quiet instead
	// of logging on every tick forever.
	let endpointMissingWarned = false;

	const policyPath = (selfMemberId: string) => http.apiPath(`/agents/${encodeURIComponent(selfMemberId)}/policy`);
	const reportPath = (selfMemberId: string) => http.apiPath(`/agents/${encodeURIComponent(selfMemberId)}/reported-policy`);

	/** `ok` is the outcome reported on success — "seeded" and "pushed" differ only in why
	 * we are writing, and keeping them apart is what makes the seed path observable. */
	const push = async (
		orgConfig: OrgConfig,
		selfMemberId: string,
		serverUpdatedAt: number,
		why: string,
		ok: Extract<ReconcileOutcome, "seeded" | "pushed">,
	): Promise<ReconcileOutcome> => {
		const orgId = orgConfig.org_id;
		const access = orgConfig.access || {};
		const body = buildReportedPolicy(access);
		const localGroups = Object.keys(access.groups || {}).length;
		const remember = () => markers.set(orgId, { fp: accessFingerprint(access), serverUpdatedAt });
		try {
			await http.putForOrg(orgId, reportPath(selfMemberId), body);
			remember();
			log.info?.(
				`[${orgId}] policy reported (${why}): dm=${body.dm_policy}/${body.dm_allowlist.length} scope=${body.group_scope} groups=${body.groups.length}/${localGroups}`,
			);
			return ok;
		} catch (err) {
			const rejected = findRejectedGroupId(err, body);
			if (rejected) {
				// A group we reported is not ours to report any more (agent removed from the
				// conversation). Drop just that one and retry once — the rest of the snapshot
				// must still land, and the next tick's adopt will clear it locally too.
				log.warn?.(`[${orgId}] policy report rejected for group ${rejected}: ${errText(err)} — retrying without it`);
				try {
					await http.putForOrg(orgId, reportPath(selfMemberId), withoutGroup(body, rejected));
					remember();
					log.info?.(`[${orgId}] policy reported (${why}) without group ${rejected}`);
					return ok;
				} catch (retryErr) {
					log.warn?.(`[${orgId}] policy report retry failed: ${errText(retryErr)}`);
					return "push-failed";
				}
			}
			if (errStatus(err) === 404) {
				if (!endpointMissingWarned) {
					endpointMissingWarned = true;
					log.warn?.(`[${orgId}] policy report endpoint not available on this cws-core (404) — policy will not be reported`);
				}
				return "push-failed";
			}
			log.warn?.(`[${orgId}] policy report failed: ${errText(err)}`);
			return "push-failed";
		}
	};

	return async function reconcilePolicy(orgConfig: OrgConfig, opts: ReconcileOptions = {}): Promise<ReconcileOutcome> {
		const orgId = orgConfig.org_id;
		const selfMemberId = orgConfig.self?.member_id;
		// (1) No self member id yet (token exchange write-back pending) — nothing to report as.
		if (!selfMemberId) return "skipped:no-member-id";
		// (2) Capability probe: an older SDK client has no putForOrg. Degrade, don't crash.
		if (typeof http.putForOrg !== "function" || typeof http.getForOrg !== "function") {
			if (!endpointMissingWarned) {
				endpointMissingWarned = true;
				log.warn?.(`[${orgId}] policy reconcile unavailable: http client has no getForOrg/putForOrg`);
			}
			return "skipped:unsupported-http";
		}

		if (opts.force) return push(orgConfig, selfMemberId, markers.get(orgId)?.serverUpdatedAt ?? 0, "forced", "pushed");

		// (3) Read first. A failed read leaves the server state UNKNOWN, and pushing into an
		// unknown state is exactly the erasure this module prevents — so: return, never PUT.
		let snapshot: ServerPolicySnapshot;
		try {
			snapshot = (await http.getForOrg(orgId, policyPath(selfMemberId))) as ServerPolicySnapshot;
		} catch (err) {
			if (errStatus(err) === 404 && !endpointMissingWarned) {
				endpointMissingWarned = true;
				log.warn?.(`[${orgId}] policy endpoint not available on this cws-core (404) — policy will not be reconciled`);
			} else {
				log.warn?.(`[${orgId}] policy read failed: ${errText(err)} — skipping this round (no push on an unknown server state)`);
			}
			return "skipped:get-failed";
		}

		const serverUpdatedAt = normalizeUpdatedAt(snapshot?.updated_at);
		// dm_allowlist counts too: a DM-only row is a real row, and mistaking it for "no row"
		// would authorise a push over it.
		const serverGroups =
			arr(snapshot?.groups).length + arr(snapshot?.group_allowlist).length + arr(snapshot?.dm_allowlist).length;
		const marker = markers.get(orgId);

		// (4) ASSUMPTION (server implementation detail, not a contract guarantee): cws-core
		// only fills `updated_at` from a real `cws_agent_policies` row (cws-comm's
		// GetFullPolicy leaves it zero and synthesizes dm_policy=owner / group_scope=open
		// when the row is absent). So updated_at==0 with nothing in groups/group_allowlist
		// reads as "no policy row" — the one state where a push cannot erase anything, and
		// the state this whole module exists to leave behind. If cws-core ever starts
		// stamping updated_at on synthesized snapshots, this branch stops firing and the
		// agent simply never seeds; it will not start erasing.
		if (serverUpdatedAt === 0 && serverGroups === 0) return push(orgConfig, selfMemberId, 0, "seeding: server has no policy row", "seeded");

		// (5) The server row moved since we last looked → the server is authoritative
		// (someone edited it in the UI) → adopt it locally and do NOT push.
		if (serverUpdatedAt !== marker?.serverUpdatedAt) {
			const adopted = adoptServerPolicy(snapshot, orgConfig.access || {});
			const adoptedFp = accessFingerprint(adopted);
			if (adoptedFp !== accessFingerprint(orgConfig.access || {})) {
				// Write to BOTH the persisted record and the SDK's live orgConfig, as an
				// idempotent assignment (config-events.ts applyBoth discipline: in the normal
				// wiring these are the same object, so double application must be safe).
				provider.updateConfig((cfg) => {
					const org = cfg.orgs[orgId];
					if (org) org.access = { ...adopted, groups: { ...adopted.groups } };
				});
				orgConfig.access = { ...adopted, groups: { ...adopted.groups } };
				log.info?.(`[${orgId}] policy adopted from server: dm=${adopted.dmPolicy} scope=${adopted.groupPolicy} groups=${Object.keys(adopted.groups || {}).length}`);
			}
			markers.set(orgId, { fp: adoptedFp, serverUpdatedAt });
			return "adopted";
		}

		// (6) Server unchanged since our marker, local block changed → ours is the new
		// intent → push it.
		const localFp = accessFingerprint(orgConfig.access || {});
		if (localFp !== marker.fp) return push(orgConfig, selfMemberId, serverUpdatedAt, "local policy changed", "pushed");

		// (7) Agreed. No write, no request — a steady state must not touch the disk.
		return "noop";
	};
}

/**
 * Start the periodic per-org sync tick: owner/self hydration followed by the policy
 * reconcile, for every enabled org.
 *
 * This wiring lives in a testable function ON PURPOSE. The defect being fixed is not a
 * wrong algorithm, it is a correct module that was never called — and "is it actually on
 * the tick" is unanswerable from a unit test of the module itself. `schedule` is
 * injectable so a test can drive one tick synchronously.
 */
export interface OrgSyncTickDeps {
	enabledOrgs: () => OrgConfig[];
	syncSelf: (orgConfig: OrgConfig) => Promise<unknown>;
	reconcilePolicy: (orgConfig: OrgConfig) => Promise<unknown>;
	/** Defaults to the real everyMs timer. */
	schedule?: (intervalMs: number, fn: () => void | Promise<void>) => () => void;
}

export function startPeriodicOrgSync(intervalMs: number, deps: OrgSyncTickDeps): () => void {
	const schedule = deps.schedule ?? everyMs;
	return schedule(intervalMs, async () => {
		for (const org of deps.enabledOrgs()) {
			await deps.syncSelf(org);
			await deps.reconcilePolicy(org);
		}
	});
}
