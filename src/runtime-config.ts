// Runtime config provider + persistence.
//
// The SDK's CwsAgentBridge NEVER writes config.json — it classifies agent.config.*
// events and hands them to callbacks, and it captures each orgConfig BY REFERENCE.
// This module owns the mutable in-memory config state and the single on-disk writer,
// mirroring the claude-openmax sibling's buildRuntime/persist/configProvider.
//
// It exposes the config-provider shape the SDK's CommService expects
// (enabledOrgs / getOrgByOrgId / updateConfig / setOwner), plus the two write-backs
// the adapter drives directly (setSelfDisplayName, persist). Because `orgs` is kept
// as the SAME array of objects handed to the SDK as `orgConfigs`, a mutation here is
// visible to the SDK's live copies without a restart.
import * as fs from "node:fs";
import { writeConfigFile } from "./onboarding.js";
import type { AppConfig, OrgConfig } from "./config.js";

/** Logger shape used across the adapter (cli.ts builds one from console). */
export interface Logger {
	info: (...a: unknown[]) => void;
	warn: (...a: unknown[]) => void;
	error?: (...a: unknown[]) => void;
}

/** The config-provider seam the SDK CommService (and our own owner-sync / config-events)
 * consume. `updateConfig` hands `fn` an org_id-keyed VIEW; mutations are synced back to
 * the array and persisted. */
export interface ConfigProvider {
	enabledOrgs(): OrgConfig[];
	getOrgByOrgId(id: string): OrgConfig | undefined;
	updateConfig(fn: (cfg: { orgs: Record<string, OrgConfig> }) => void): { orgs: Record<string, OrgConfig> };
	setOwner(orgId: string, memberId: string, name: string): void;
	setSelfDisplayName(orgId: string, name: string): void;
	persist(): void;
}

/** Serialize one internal org record back to its on-disk (bridge / openmax) form.
 * Mirrors onboarding.ts assemble + config.ts parseOrgs so it round-trips through loadConfig. */
function serializeOrg(o: OrgConfig): Record<string, unknown> {
	return {
		...(o.enabled !== undefined ? { enabled: o.enabled } : {}),
		org_id: o.org_id,
		org_name: o.org_name || "",
		owner: o.owner || { member_id: "", name: "" },
		self: o.self || { member_id: "", name: "", display_name: "" },
		access: o.access || {},
	};
}

/** Assemble the full org_id-keyed, snake_case on-disk config from the camelCase AppConfig.
 * The whole file is rewritten on every persist, so EVERY known block must be reproduced here
 * (dropping one would erase it from disk on the next write-back). */
function assembleOnDisk(cfg: AppConfig): Record<string, unknown> {
	return {
		...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
		server: { bff_url: cfg.server.bffUrl, ws_url: cfg.server.wsUrl, frontend_base_path: cfg.server.frontendBasePath },
		agent: { identity_id: cfg.agent.identityId, api_key: cfg.agent.apiKey, device_id: cfg.agent.deviceId, app_version: cfg.agent.appVersion },
		...(cfg.cfAccess ? { cf_access: cfg.cfAccess } : {}),
		orgs: Object.fromEntries(cfg.orgs.map((o) => [o.org_id, serializeOrg(o)])),
		codex: { bin: cfg.codex.bin, cwd: cfg.codex.cwd },
		bridge: { localHttpPort: cfg.bridge.localHttpPort },
		...(cfg.versionCheck
			? {
					version_check: {
						...(cfg.versionCheck.enabled !== undefined ? { enabled: cfg.versionCheck.enabled } : {}),
						...(cfg.versionCheck.intervalHours !== undefined ? { interval_hours: cfg.versionCheck.intervalHours } : {}),
					},
				}
			: {}),
	};
}

/**
 * Build the runtime config provider. `cfg` is mutated in place (its `orgs` array IS the
 * array of objects handed to the SDK as `orgConfigs`), and `persist()` writes the whole
 * config back to `filePath` atomically at 0o600 via the shared writeConfigFile.
 */
export function buildConfigProvider(cfg: AppConfig, filePath: string, logger: Logger): ConfigProvider {
	const orgByOrgId = (id: string): OrgConfig | undefined => cfg.orgs.find((o) => o.org_id === id);
	// `enabled: false` opts an org out of the SDK-facing view, but persist() still writes ALL
	// orgs so a disabled one is never dropped from disk.
	const enabledOrgs = (): OrgConfig[] => cfg.orgs.filter((o) => o.enabled !== false);

	const persist = (): void => {
		try {
			// 0o600 + atomic tmp+rename — the config holds secrets (agent.api_key, cf_access).
			writeConfigFile(fs, filePath, assembleOnDisk(cfg));
		} catch (e) {
			logger.warn?.(`config persist failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const updateConfig = (fn: (view: { orgs: Record<string, OrgConfig> }) => void): { orgs: Record<string, OrgConfig> } => {
		// The view maps to the SAME org objects (by reference); mutating a nested field on
		// view.orgs[id] mutates the SDK's live copy too. fn must not REPLACE an org object.
		const view = { orgs: Object.fromEntries(cfg.orgs.map((o) => [o.org_id, o])) };
		fn(view);
		cfg.orgs = Object.values(view.orgs);
		persist();
		return view;
	};

	const setOwner = (orgId: string, memberId: string, name: string): void => {
		const org = orgByOrgId(orgId);
		if (org) {
			org.owner = { member_id: memberId, name: name || "" };
			persist();
		}
	};

	const setSelfDisplayName = (orgId: string, name: string): void => {
		const org = orgByOrgId(orgId);
		if (org) {
			org.self = { ...(org.self || { member_id: "" }), display_name: name };
			persist();
		}
	};

	return { enabledOrgs, getOrgByOrgId: orgByOrgId, updateConfig, setOwner, setSelfDisplayName, persist };
}
