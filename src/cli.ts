#!/usr/bin/env node
// codex-openmax CLI — the mechanical layer under the platform-rendered onboarding prompt
// (docs/onboarding-design.md):
//   init  — non-interactive: connection material (stdin JSON: bff_url/ws_url/org_id + EITHER
//           a provisioned api_key + identity_id OR an invitation_id + invitation_token) ->
//           exchange JWT (self-registering first if using an invitation) -> hydrate self ->
//           write config.json (0600). Never echoes secrets.
//   start — load config.json -> real SDK bridge -> main() (adapter server), foreground,
//           graceful SIGINT/SIGTERM.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { buildConfig, writeConfigFile, type FetchLike, type OnboardInput } from "./onboarding.js";
import { loadConfig, type AppConfig } from "./config.js";

function usage(): never {
	console.error(`usage:
  codex-openmax init --stdin-json   # read one JSON blob from stdin (onboarding prompt path)
  codex-openmax start               # run the adapter (foreground)`);
	process.exit(2);
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
	// The SDK ships plain JS/ESM with no type declarations; construct via dynamic import.
	const sdk = (await import("@openmaxai/openmax-agent-sdk")) as Record<string, any>;
	const { createSdkCwsBridge } = await import("./bridge/sdk-bridge.js");
	const { main } = await import("./index.js");
	const { server, agent, cfAccess, orgs } = config;
	const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
	const logger = { info: log, warn: log, error: log, debug: () => {}, log };
	// The SDK's cfAccessHeaders() reads `cfg.cf_access.{client_id,client_secret}` (WRAPPED),
	// so the bare block must be wrapped as { cf_access: ... }; env COCO_CF_ACCESS_* still wins
	// inside the SDK. Omitted entirely when no cf_access is configured.
	const cfAccessWrapped = cfAccess ? { cf_access: cfAccess } : undefined;
	// enabled:false opts an org out (mirrors claude-openmax / the openmax component).
	const activeOrgs = orgs.filter((o) => o.enabled !== false);
	const defaultOrgId = () => activeOrgs[0]?.org_id ?? orgs[0].org_id;
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
				callbacks: { syncSelf: async () => ({ nameReady: true }) },
				reporters: { metrics: false },
			}),
	);
	const handle = await main(bridge);
	log(`[codex-openmax] online — adapter on :${handle.port}, orgs=${activeOrgs.map((o) => o.org_id).join(",")}`);
	const stop = async () => {
		log("[codex-openmax] stopping…");
		await handle.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
}

const [, , cmd, ...rest] = process.argv;
if (cmd === "init") void cmdInit(rest);
else if (cmd === "start") void cmdStart();
else usage();
