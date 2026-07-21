// Self-name hydration + owner sync (pull-based).
//
// Ported from zylos-openmax comm-bridge.js syncOwnerFromCore. The bot's local
// `orgs.<id>.owner` block is a CACHE; cws-core holds the authoritative owner
// (our own member record's `owner_member_id`). On the connect-time hydration
// barrier (SDK callbacks.syncSelf) AND on a periodic timer / owner_changed event,
// we pull our own member record and reconcile.
//
// Two things happen off the ONE self-member read (no extra round-trip, matching zylos):
//   1. self.display_name ← core (so inbound @-mention detection matches the exact
//      name cws-fe shows, not a hand-configured self.name that silently drifts).
//   2. owner ← core.owner_member_id, resolving the owner's display_name for the cache.
//
// INVARIANTS:
//   - Pull-based ONLY: a pushed WS frame never sets ownership (a forged frame must not
//     be able to hand the bot to an attacker). owner_changed just TRIGGERS this pull.
//   - NEVER clear a locally-set owner when core reports none — that keeps the first-DM
//     auto-bind fallback working (zylos comm-bridge.js:1811-1814).
//   - Fail-open: never throws. The SDK's hydration barrier retries; a failed sync must
//     report nameReady:false (with a reason), never be mistaken for success.
import type { ConfigProvider, Logger } from "./runtime-config.js";
import type { OrgConfig } from "./config.js";

/** The subset of the SDK's CwsHttpClient this module needs. */
export interface HttpForOrg {
	getForOrg(orgId: string, path: string, query?: unknown): Promise<unknown>;
	apiPath(p: string): string;
}

/** Result the SDK self-name hydration barrier expects (identity/self-name-hydration.js):
 * `nameReady:true` ONLY once the authoritative self-member record was actually read. */
export type SyncSelfResult = { nameReady: true; displayName?: string } | { nameReady: false; reason: string };

/** A member record as returned by GET /members/{id} (only the fields we read). */
interface MemberRecord {
	display_name?: string;
	username?: string;
	owner_member_id?: string;
}

/**
 * Build the syncSelf function bound to `http` + `provider`. The returned function serves
 * BOTH as the SDK `callbacks.syncSelf` (connect-time barrier) and as the periodic /
 * owner_changed owner re-sync (its result is ignored by those callers).
 */
export function makeSyncSelf(http: HttpForOrg, provider: ConfigProvider, log: Logger): (orgConfig: OrgConfig) => Promise<SyncSelfResult> {
	return async function syncSelf(orgConfig: OrgConfig): Promise<SyncSelfResult> {
		const orgId = orgConfig.org_id;
		const selfMemberId = orgConfig.self?.member_id;
		if (!selfMemberId) {
			// member_id is written back by the token exchange; not there yet → retry next round.
			return { nameReady: false, reason: "self.member_id not available yet (token exchange write-back pending)" };
		}

		let member: MemberRecord;
		try {
			member = (await http.getForOrg(orgId, http.apiPath(`/members/${selfMemberId}`))) as MemberRecord;
		} catch (err) {
			log.warn?.(`[${orgId}] owner-sync: fetch self member failed: ${err instanceof Error ? err.message : String(err)} — keeping local owner`);
			return { nameReady: false, reason: `fetch self member failed: ${err instanceof Error ? err.message : String(err)}` };
		}

		// (1) self display_name ← core (cosmetic-but-important: @-mention matching).
		const coreDisplayName = member?.display_name || "";
		if (coreDisplayName && coreDisplayName !== orgConfig.self?.display_name) {
			provider.setSelfDisplayName(orgId, coreDisplayName);
			orgConfig.self = { ...(orgConfig.self || { member_id: selfMemberId }), display_name: coreDisplayName };
			log.info?.(`[${orgId}] self display_name synced from core: ${coreDisplayName}`);
		}

		// (2) owner ← core. Core has no owner → LEAVE the local binding as-is (invariant).
		const coreOwnerId = member?.owner_member_id || "";
		if (!coreOwnerId) return { nameReady: true, displayName: coreDisplayName || undefined };

		const localOwnerId = orgConfig.owner?.member_id || "";
		if (coreOwnerId === localOwnerId) return { nameReady: true, displayName: coreDisplayName || undefined };

		let ownerName = "";
		try {
			const ownerMember = (await http.getForOrg(orgId, http.apiPath(`/members/${coreOwnerId}`))) as MemberRecord;
			ownerName = ownerMember?.display_name || ownerMember?.username || "";
		} catch {
			// owner display_name is cosmetic — a fetch failure must not block the owner bind.
		}
		provider.setOwner(orgId, coreOwnerId, ownerName);
		orgConfig.owner = { member_id: coreOwnerId, name: ownerName };
		log.info?.(`[${orgId}] owner synced from core: ${localOwnerId || "(none)"} → ${coreOwnerId}${ownerName ? ` (${ownerName})` : ""}`);

		return { nameReady: true, displayName: coreDisplayName || undefined };
	};
}
