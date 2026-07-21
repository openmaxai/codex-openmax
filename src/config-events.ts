// agent.config.* event handling — the DM/group access-policy switch.
//
// Ported from zylos-openmax comm-bridge.js handleConfigUpdate (:1110-1282). The SDK
// classifies each agent.config.* frame, does the "not for us" target check, and hands
// us { event, data, frame } via callbacks.onConfigEvent — it does NOT persist. This
// module applies the change to the org's access block (persisted via the provider) AND
// mutates the passed orgConfig in place so the SDK's live copy takes effect without a
// restart.
//
// The mutation is written as an idempotent ASSIGNMENT (never an in-place push): the
// provider's org record and the SDK's orgConfig are the same object in the normal wiring,
// so applying the change to both must be safe under double application.
//
// owner_changed is special: ownership is NEVER set from a pushed frame (a forged frame
// must not hand the bot to an attacker) — it only TRIGGERS a pull-based owner re-sync.
import type { ConfigProvider, Logger } from "./runtime-config.js";
import type { OrgConfig, OrgAccess } from "./config.js";

const VALID_DM_POLICIES = new Set(["open", "allowlist", "owner"]);
const VALID_GROUP_SCOPES = new Set(["open", "allowlist", "disabled"]);
const VALID_GROUP_MODES = new Set(["smart", "mention", "silent"]);

export interface ConfigEvent {
	event: string;
	data: Record<string, unknown>;
}

export interface ConfigEventDeps {
	log: Logger;
	/** Pull-based owner re-sync for owner_changed (typically owner-sync's syncSelf). */
	resyncOwner?: (orgConfig: OrgConfig) => Promise<unknown>;
}

/**
 * Handle one agent.config.* event. Throws on a genuine (unexpected) error so the SDK
 * leaves the event unconsumed and retries on replay; a validation failure (bad policy,
 * missing field) is logged and returns without mutating.
 */
export async function handleConfigEvent(provider: ConfigProvider, orgConfig: OrgConfig, evt: ConfigEvent, deps: ConfigEventDeps): Promise<void> {
	const { event, data } = evt;
	const { log } = deps;
	const orgId = orgConfig.org_id;
	if (!data || typeof data !== "object") return;

	// Apply a mutation to BOTH the provider's record (persisted) and the SDK's live copy.
	// `apply` MUST be idempotent (assignment-only) — see file header.
	const applyBoth = (apply: (org: OrgConfig) => void): void => {
		provider.updateConfig((cfg) => {
			const o = cfg.orgs[orgId];
			if (o) apply(o);
		});
		apply(orgConfig);
	};
	const ensureAccess = (o: OrgConfig): OrgAccess => (o.access = o.access || {});

	switch (event) {
		case "agent.config.dm_policy_changed": {
			const policy = data.policy as string;
			if (!VALID_DM_POLICIES.has(policy)) {
				log.warn?.(`[${orgId}] dm_policy_changed: invalid policy "${policy}"`);
				return;
			}
			applyBoth((o) => {
				ensureAccess(o).dmPolicy = policy;
			});
			log.info?.(`[${orgId}] config updated: dmPolicy → ${policy} (by ${data.changed_by || "?"})`);
			return;
		}

		case "agent.config.dm_allowlist_changed": {
			const action = data.action as string;
			const memberIds = data.member_ids as string[];
			if (!Array.isArray(memberIds) || !memberIds.length) {
				log.warn?.(`[${orgId}] dm_allowlist_changed: missing or empty member_ids`);
				return;
			}
			if (!["add", "remove", "set"].includes(action)) {
				log.warn?.(`[${orgId}] dm_allowlist_changed: unknown action "${action}"`);
				return;
			}
			applyBoth((o) => {
				const access = ensureAccess(o);
				const current = access.dmAllowFrom || [];
				if (action === "add") access.dmAllowFrom = [...new Set([...current, ...memberIds])];
				else if (action === "remove") {
					const remove = new Set(memberIds.map(String));
					access.dmAllowFrom = current.filter((id) => !remove.has(String(id)));
				} else access.dmAllowFrom = [...memberIds];
			});
			log.info?.(`[${orgId}] config updated: dmAllowFrom ${action} ${memberIds.length} member(s) (by ${data.changed_by || "?"})`);
			return;
		}

		case "agent.config.group_mode_changed": {
			const mode = data.mode as string;
			const convId = data.conversation_id as string;
			if (!VALID_GROUP_MODES.has(mode)) {
				log.warn?.(`[${orgId}] group_mode_changed: invalid mode "${mode}"`);
				return;
			}
			if (!convId) {
				log.warn?.(`[${orgId}] group_mode_changed: missing conversation_id`);
				return;
			}
			applyBoth((o) => {
				const access = ensureAccess(o);
				const groups = (access.groups = access.groups || {});
				// 'silent' means "don't participate" → drop the entry entirely.
				if (mode === "silent") delete groups[convId];
				else {
					groups[convId] = groups[convId] || { allowFrom: ["*"] };
					groups[convId].mode = mode;
				}
			});
			log.info?.(`[${orgId}] config updated: group ${convId} mode → ${mode} (by ${data.changed_by || "?"})`);
			return;
		}

		case "agent.config.group_allowfrom_changed": {
			const allowFrom = data.allow_from as string[];
			const convId = data.conversation_id as string;
			if (!convId) {
				log.warn?.(`[${orgId}] group_allowfrom_changed: missing conversation_id`);
				return;
			}
			if (!Array.isArray(allowFrom)) {
				log.warn?.(`[${orgId}] group_allowfrom_changed: allow_from is not an array`);
				return;
			}
			applyBoth((o) => {
				const access = ensureAccess(o);
				const groups = (access.groups = access.groups || {});
				if (!groups[convId]) groups[convId] = { mode: "mention", allowFrom: [...allowFrom] };
				else groups[convId].allowFrom = [...allowFrom];
			});
			log.info?.(`[${orgId}] config updated: group ${convId} allowFrom → ${JSON.stringify(allowFrom)} (by ${data.changed_by || "?"})`);
			return;
		}

		case "agent.config.group_scope_changed": {
			const scope = data.scope as string;
			if (!VALID_GROUP_SCOPES.has(scope)) {
				log.warn?.(`[${orgId}] group_scope_changed: invalid scope "${scope}"`);
				return;
			}
			applyBoth((o) => {
				ensureAccess(o).groupPolicy = scope;
			});
			log.info?.(`[${orgId}] config updated: groupPolicy → ${scope} (by ${data.changed_by || "?"})`);
			return;
		}

		case "agent.config.group_allowlist_changed": {
			const action = data.action as string;
			const convIds = data.conversation_ids as string[];
			if (!Array.isArray(convIds)) {
				log.warn?.(`[${orgId}] group_allowlist_changed: conversation_ids is not an array`);
				return;
			}
			if (!["add", "remove", "set"].includes(action)) {
				log.warn?.(`[${orgId}] group_allowlist_changed: unknown action "${action}"`);
				return;
			}
			applyBoth((o) => {
				const access = ensureAccess(o);
				const groups = (access.groups = access.groups || {});
				if (action === "add") {
					for (const id of convIds) if (!groups[id]) groups[id] = { mode: "mention", allowFrom: ["*"] };
				} else if (action === "remove") {
					for (const id of convIds) delete groups[id];
				} else {
					// set: keep existing entries for the listed convs, drop the rest.
					const old = groups;
					const next: NonNullable<OrgAccess["groups"]> = {};
					for (const id of convIds) next[id] = old[id] || { mode: "mention", allowFrom: ["*"] };
					access.groups = next;
				}
			});
			log.info?.(`[${orgId}] config updated: group_allowlist ${action} ${convIds.length} conversation(s) (by ${data.changed_by || "?"})`);
			return;
		}

		case "agent.config.owner_changed": {
			const oldOwner = (data.old_owner_member_id as string) || "";
			const newOwner = (data.new_owner_member_id as string) || "";
			log.info?.(`[${orgId}] owner_changed event: ${oldOwner || "(none)"} → ${newOwner || "(none)"} by=${data.changed_by || "?"} — re-syncing from core`);
			// NEVER trust the pushed frame to set ownership — pull the authoritative record.
			if (deps.resyncOwner) await deps.resyncOwner(orgConfig);
			return;
		}

		default:
			log.warn?.(`[${orgId}] unknown config event: ${event}`);
			return;
	}
}
