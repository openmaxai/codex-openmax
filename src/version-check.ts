// Version check — option 甲: periodically ask npm whether a newer @openmaxai/codex-openmax
// is published and, if so, DM the org owner. It NEVER self-upgrades (unlike the zylos
// auto-upgrade PM2 machinery it is trimmed down from) — the owner runs the upgrade.
//
// Ported from zylos-openmax auto-upgrade.js: resolveAutoUpgradeSchedule (disabled by
// default) and compareSemver — fixed to sort prerelease tags correctly (the naive numeric
// split mis-sorts `0.1.0-alpha.3`).
import { readFileSync } from "node:fs";
import type { ConfigProvider, Logger } from "./runtime-config.js";

const REGISTRY_URL = "https://registry.npmjs.org/@openmaxai/codex-openmax/latest";
const DEFAULT_INTERVAL_HOURS = 24;
const FETCH_TIMEOUT_MS = 5000;

/** Read this package's own version. From dist/version-check.js OR src/version-check.ts the
 * package.json is one directory up (dist/ and src/ both sit directly under the repo root). */
export function readLocalVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
		return pkg.version || "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/** GET the latest published version from the npm registry. Throws on network/HTTP failure. */
export async function fetchLatestVersion(): Promise<string> {
	const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`npm registry ${res.status}: ${res.statusText}`);
	const data = (await res.json()) as { version?: string };
	return (data.version || "").replace(/^v/, "");
}

/** Compare a prerelease identifier list (semver §11): numeric < non-numeric, fewer fields
 * has lower precedence. `alpha.3` < `alpha.4`; `alpha` < `alpha.1`. */
function comparePre(a: string, b: string): number {
	const as = a.split(".");
	const bs = b.split(".");
	const len = Math.max(as.length, bs.length);
	for (let i = 0; i < len; i++) {
		if (as[i] === undefined) return -1;
		if (bs[i] === undefined) return 1;
		const an = /^\d+$/.test(as[i]);
		const bn = /^\d+$/.test(bs[i]);
		if (an && bn) {
			const d = Number(as[i]) - Number(bs[i]);
			if (d !== 0) return d < 0 ? -1 : 1;
		} else if (an) return -1;
		else if (bn) return 1;
		else if (as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1;
	}
	return 0;
}

/** semver compare, prerelease-aware. Returns -1 | 0 | 1. A release outranks a prerelease of
 * the same core (`0.1.0` > `0.1.0-alpha.3`). */
export function compareSemver(a: string, b: string): number {
	const parse = (v: string): { nums: number[]; pre: string | null } => {
		const [core, ...preParts] = v.replace(/^v/, "").split("-");
		return { nums: core.split(".").map((n) => Number(n) || 0), pre: preParts.length ? preParts.join("-") : null };
	};
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < 3; i++) {
		const x = pa.nums[i] || 0;
		const y = pb.nums[i] || 0;
		if (x < y) return -1;
		if (x > y) return 1;
	}
	if (pa.pre === null && pb.pre === null) return 0;
	if (pa.pre === null) return 1; // release > prerelease
	if (pb.pre === null) return -1;
	return comparePre(pa.pre, pb.pre);
}

export type VersionCheckSchedule = { enabled: false } | { enabled: true; intervalHours: number; intervalMs: number };

/** Resolve the check schedule from config.versionCheck. DISABLED unless enabled === true. */
export function resolveVersionCheckSchedule(settings?: { enabled?: boolean; intervalHours?: number }): VersionCheckSchedule {
	if (settings?.enabled !== true) return { enabled: false };
	const intervalHours = Number(settings.intervalHours) || DEFAULT_INTERVAL_HOURS;
	return { enabled: true, intervalHours, intervalMs: intervalHours * 3600_000 };
}

/** Minimal CommService surface used to DM the owner (SDK createCommService(http, provider)). */
export interface CommForNotify {
	createDm(params: { peerMemberId: string }): Promise<{ conversation?: { id?: string } } | undefined>;
	send(params: { conversationId: string; content: string }): Promise<unknown>;
}

export interface VersionCheckDeps {
	provider: ConfigProvider;
	comm: CommForNotify;
	log: Logger;
	/** Injectable for tests. */
	fetchLatest?: () => Promise<string>;
	localVersion?: string;
}

/** Build the periodic check function. On a newer published version it DMs each enabled org's
 * owner AT MOST ONCE per (org, latest-version) — the last-notified version is tracked in
 * memory. Same-or-older → no notification. Never throws. */
export function makeVersionCheck(deps: VersionCheckDeps): () => Promise<void> {
	const { provider, comm, log } = deps;
	const fetchLatest = deps.fetchLatest || fetchLatestVersion;
	const localVersion = deps.localVersion ?? readLocalVersion();
	// orgId → last latest-version we already notified about (dedupe repeated cycles).
	const notified = new Map<string, string>();

	return async function check(): Promise<void> {
		let latest: string;
		try {
			latest = await fetchLatest();
		} catch (e) {
			log.warn?.(`[version-check] fetch latest failed: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (!latest) return;
		if (compareSemver(localVersion, latest) >= 0) {
			log.info?.(`[version-check] up to date (local ${localVersion}, latest ${latest})`);
			return;
		}

		const text =
			`codex-openmax ${localVersion}→${latest} 有新版，请运行 \`npm i -g @openmaxai/codex-openmax\` 并重启。`;
		for (const org of provider.enabledOrgs()) {
			const ownerId = org.owner?.member_id;
			if (!ownerId) continue;
			if (notified.get(org.org_id) === latest) continue;
			try {
				const dm = await comm.createDm({ peerMemberId: ownerId });
				const convId = dm?.conversation?.id;
				if (!convId) {
					log.warn?.(`[version-check] [${org.org_id}] could not resolve owner DM conversation`);
					continue;
				}
				await comm.send({ conversationId: convId, content: text });
				notified.set(org.org_id, latest);
				log.info?.(`[version-check] [${org.org_id}] owner notified of ${localVersion}→${latest}`);
			} catch (e) {
				log.warn?.(`[version-check] [${org.org_id}] notify failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	};
}
