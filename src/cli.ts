#!/usr/bin/env node
// codex-openmax CLI — the mechanical layer under the platform-rendered onboarding prompt
// (docs/onboarding-design.md):
//   init  — non-interactive: connection material (stdin JSON: bff_url/ws_url/org_id + EITHER
//           a provisioned api_key + identity_id OR an invitation_id + invitation_token) ->
//           exchange JWT (self-registering first if using an invitation) -> hydrate self ->
//           write config.json (0600). Never echoes secrets.
//   start — load config.json -> real SDK bridge -> main() (adapter server), foreground,
//           graceful SIGINT/SIGTERM.
//   report-policy — one-shot: force-push the local access block to cws-core. The escape
//           hatch for "I edited config.json by hand and want the server to match": the
//           periodic reconcile is pull-first (the server wins once it holds a row) and
//           this adapter has no config file watcher, so overriding is an explicit act.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { buildConfig, writeConfigFile, type FetchLike, type OnboardInput } from "./onboarding.js";
import { loadConfig, resolveConfigPath, type AppConfig } from "./config.js";
import { buildConfigProvider, type ConfigProvider, type Logger } from "./runtime-config.js";
import { makeSyncSelf } from "./owner-sync.js";
import { handleConfigEvent } from "./config-events.js";
import { everyMs } from "./scheduler.js";
import { makeReconcilePolicy, startPeriodicOrgSync, type HttpPolicy } from "./policy-sync.js";
import { resolveVersionCheckSchedule, makeVersionCheck } from "./version-check.js";

// Owner re-sync cadence for long-lived connections (the SDK only hydrates self at
// connect time). 5 min mirrors the zylos OWNER_SYNC_INTERVAL_MS.
const OWNER_SYNC_INTERVAL_MS = 5 * 60 * 1000;

function usage(): never {
	console.error(`usage:
  codex-openmax init --stdin-json   # read one JSON blob from stdin (onboarding prompt path)
  codex-openmax start               # run the adapter (foreground)
  codex-openmax report-policy       # push the local access policy to cws-core (local wins, once)`);
	process.exit(2);
}

/**
 * Build the SDK token manager + HTTP client from config. Shared by `start` and
 * `report-policy` so the two agree on auth, CF-Access and default-org resolution.
 */
async function buildClients(config: AppConfig, provider: ConfigProvider, logger: Logger) {
	// The SDK ships plain JS/ESM with no type declarations; construct via dynamic import.
	const sdk = (await import("@openmaxai/openmax-agent-sdk")) as Record<string, any>;
	const { server, agent, cfAccess } = config;
	// The SDK's cfAccessHeaders() reads `cfg.cf_access.{client_id,client_secret}` (WRAPPED),
	// so the bare block must be wrapped as { cf_access: ... }; env COCO_CF_ACCESS_* still wins
	// inside the SDK. Omitted entirely when no cf_access is configured.
	const cfAccessWrapped = cfAccess ? { cf_access: cfAccess } : undefined;
	// enabled:false opts an org out (mirrors claude-openmax / the openmax component).
	const activeOrgs = provider.enabledOrgs();
	const defaultOrgId = () => activeOrgs[0]?.org_id ?? config.orgs[0].org_id;
	const tokenManager = new sdk.TokenManager({
		apiKey: agent.apiKey,
		coreUrl: server.bffUrl,
		...(cfAccessWrapped ? { cfAccess: cfAccessWrapped } : {}),
		storage: sdk.memoryStorage(),
		resolveDefaultOrgId: defaultOrgId,
		logger,
	});
	const http = new sdk.CwsHttpClient({
		baseUrl: server.bffUrl,
		apiKey: agent.apiKey,
		deviceId: agent.deviceId,
		clientVersion: agent.appVersion,
		...(cfAccessWrapped ? { cfAccess: cfAccessWrapped } : {}),
		frontendBasePath: server.frontendBasePath,
		tokenManager,
		resolveDefaultOrgId: defaultOrgId,
		logger,
	});
	return { sdk, http: http as HttpPolicy, tokenManager, cfAccessWrapped, activeOrgs };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function cmdInit(args: string[]): Promise<void> {
	if (!args.includes("--stdin-json")) usage();
	let input: OnboardInput;
	try {
		input = JSON.parse(await readStdin()) as OnboardInput;
	} catch {
		console.error("init: stdin is not valid JSON");
		process.exit(1);
	}
	for (const f of ["bff_url", "ws_url", "org_id"] as const) {
		if (typeof input[f] !== "string" || !input[f]) {
			console.error(`init: missing required field "${f}"`);
			process.exit(1);
		}
	}
	const hasDirect = typeof input.api_key === "string" && !!input.api_key && typeof input.identity_id === "string" && !!input.identity_id;
	const hasInvitation = typeof input.invitation_id === "string" && !!input.invitation_id && typeof input.invitation_token === "string" && !!input.invitation_token;
	if (!hasDirect && !hasInvitation) {
		console.error(`init: missing required fields — supply either ("api_key" + "identity_id") or ("invitation_id" + "invitation_token")`);
		process.exit(1);
	}
	try {
		const config = await buildConfig(globalThis.fetch as unknown as FetchLike, input);
		writeConfigFile(fs, "config.json", config); // 0600 guaranteed even on overwrite (temp + atomic rename)
		// Preflight (warn-only here; `start` hard-fails): the runtime this adapter drives.
		let codexOk = false;
		try {
			execFileSync("codex", ["--version"], { stdio: "pipe" });
			codexOk = true;
		} catch {
			console.error("init: WARNING — `codex` binary not found on PATH; install it before `start`");
		}
		const orgs = config.orgs as Record<string, { self?: { display_name?: string } }>;
		const self = Object.values(orgs)[0]?.self?.display_name ?? "?";
		// Machine-readable success line. No secrets: display name + org only.
		console.log(JSON.stringify({ ok: true, org: input.org_id, self, codex: codexOk }));
	} catch (e) {
		console.error(`init: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	}
}

async function cmdStart(): Promise<void> {
	let config: AppConfig;
	try {
		config = loadConfig();
	} catch (e) {
		console.error(`start: ${e instanceof Error ? e.message : String(e)} — run \`codex-openmax init\` first`);
		process.exit(1);
	}
	if (!config.orgs.length) {
		console.error("start: config.json has no orgs — re-run init");
		process.exit(1);
	}
	const { createSdkCwsBridge } = await import("./bridge/sdk-bridge.js");
	const { main } = await import("./index.js");
	const { server, agent } = config;
	const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
	const logger = { info: log, warn: log, error: log, debug: () => {}, log };
	// Runtime config provider: owns the mutable config state + the single on-disk writer.
	// enabledOrgs() returns the SAME org objects handed to the SDK as orgConfigs (captured by
	// reference), so owner/self/access write-backs are visible to the SDK without a restart.
	const provider = buildConfigProvider(config, resolveConfigPath(), logger);
	const { sdk, http, tokenManager, cfAccessWrapped, activeOrgs } = await buildClients(config, provider, logger);
	// syncSelf hydrates self.display_name + owner from cws-core (pull-based). Serves the
	// SDK's connect-time self-name barrier AND the periodic owner re-sync below.
	const syncSelf = makeSyncSelf(http, provider, logger);
	// reconcilePolicy keeps the local access block and cws-core's agent-policy row in
	// agreement. Pull-first by construction — see policy-sync.ts.
	const reconcilePolicy = makeReconcilePolicy(http, provider, logger);
	const bridge = createSdkCwsBridge(
		(deliver) =>
			new sdk.CwsAgentBridge({
				http,
				tokenManager,
				ws: {
					baseUrl: server.wsUrl,
					deviceId: agent.deviceId,
					clientVersion: agent.appVersion,
					...(cfAccessWrapped ? { cfAccess: cfAccessWrapped } : {}),
				},
				orgConfigs: activeOrgs,
				providers: { logger, inbound: { deliver } },
				callbacks: {
					syncSelf,
					// The SDK reads this at the hydration barrier; org_id-keyed enabled-org view.
					loadConfig: () => ({ orgs: Object.fromEntries(provider.enabledOrgs().map((o) => [o.org_id, o])) }),
					// agent.config.* → apply to access + persist. Let it throw so the SDK retries.
					onConfigEvent: async (orgConfig: any, evt: any) =>
						handleConfigEvent(provider, orgConfig, { event: evt.event, data: evt.data }, { log: logger, resyncOwner: syncSelf }),
					// Owner auto-bind fallback (core had none) / owner name hint → persist.
					onOwnerBind: (orgId: string, memberId: string, displayName: string) => provider.setOwner(orgId, memberId, displayName || ""),
					onOwnerNameHint: (orgId: string, name: string) => {
						const org = provider.getOrgByOrgId(orgId);
						if (org) {
							org.owner = { ...(org.owner || { member_id: "" }), name };
							provider.persist();
						}
					},
				},
				reporters: { metrics: false },
			}),
	);
	const handle = await main(bridge);
	log(`[codex-openmax] online — adapter on :${handle.port}, orgs=${activeOrgs.map((o) => o.org_id).join(",")}`);

	// Registered BEFORE the bootstrap round-trip below: that loop is the first network I/O in
	// this function, and a Ctrl+C landing inside it used to bypass stop() entirely. stop() is
	// only defined further down, so the handler holds a ref and remembers a signal that lands
	// before it is filled in.
	let requestStop: (() => void) | null = null;
	let stopRequested = false;
	const onSignal = () => {
		if (requestStop) requestStop();
		else stopRequested = true;
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	// Bootstrap reconcile. bridge.start() has already awaited the SDK's self-name hydration
	// barrier, so self.member_id and the org JWT are both in place by here — the earliest
	// point at which the policy round-trip can succeed, and a full interval before the first
	// periodic tick would otherwise get to it.
	for (const org of provider.enabledOrgs()) log(`[${org.org_id}] policy reconcile (bootstrap): ${await reconcilePolicy(org)}`);

	// Periodic timers (disposed in stop()). All background work swallows rejections (everyMs).
	const disposers: Array<() => void> = [];
	// (1) Owner re-sync + policy reconcile — cover long-lived connections the connect-time
	// barrier can't. The policy half MUST stay the GET-first reconcile: an unconditional PUT
	// on a timer is the openclaw index.ts:916 bug, which erases whatever the server holds and
	// the local config does not express.
	disposers.push(
		startPeriodicOrgSync(OWNER_SYNC_INTERVAL_MS, {
			enabledOrgs: () => provider.enabledOrgs(),
			syncSelf,
			reconcilePolicy,
		}),
	);
	// (2) Version check (option 甲) — opt-in; DM the owner on a newer npm release, never self-upgrade.
	const vcSchedule = resolveVersionCheckSchedule(config.versionCheck);
	if (vcSchedule.enabled) {
		const comm = sdk.createCommService(http, provider);
		const check = makeVersionCheck({ provider, comm, log: logger });
		disposers.push(everyMs(vcSchedule.intervalMs, check));
		log(`[codex-openmax] version-check enabled (every ${vcSchedule.intervalHours}h)`);
	}

	const stop = async () => {
		log("[codex-openmax] stopping…");
		for (const dispose of disposers) dispose();
		await handle.stop();
		process.exit(0);
	};
	requestStop = () => void stop();
	if (stopRequested) requestStop();
}

/**
 * One-shot force push of the local access block. Deliberately the ONLY bare PUT in the
 * adapter: the periodic reconcile reads before it writes and lets the server win once a
 * policy row exists, so making the local config authoritative has to be a human action.
 */
async function cmdReportPolicy(): Promise<void> {
	let config: AppConfig;
	try {
		config = loadConfig();
	} catch (e) {
		console.error(`report-policy: ${e instanceof Error ? e.message : String(e)} — run \`codex-openmax init\` first`);
		process.exit(1);
	}
	if (!config.orgs.length) {
		console.error("report-policy: config.json has no orgs — re-run init");
		process.exit(1);
	}
	const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a);
	const logger = { info: log, warn: log, error: log, debug: () => {}, log };
	const provider = buildConfigProvider(config, resolveConfigPath(), logger);
	const { http } = await buildClients(config, provider, logger);
	const reconcilePolicy = makeReconcilePolicy(http, provider, logger);
	const results: Record<string, string> = {};
	for (const org of provider.enabledOrgs()) results[org.org_id] = await reconcilePolicy(org, { force: true });
	// every() on [] is true: with no enabled org nothing was attempted, which is not success.
	const attempted = Object.values(results);
	const ok = attempted.length > 0 && attempted.every((r) => r === "pushed");
	// Machine-readable result line on stdout (logs go to stderr). No secrets.
	console.log(JSON.stringify({ ok, orgs: results }));
	// exitCode rather than exit(): the JSON line above is still draining to a pipe, and the
	// reconcile is fail-open so there is nothing left running that needs to be cut off.
	if (!ok) process.exitCode = 1;
}

const [, , cmd, ...rest] = process.argv;
if (cmd === "init") void cmdInit(rest);
else if (cmd === "start") void cmdStart();
else if (cmd === "report-policy") void cmdReportPolicy();
else usage();
