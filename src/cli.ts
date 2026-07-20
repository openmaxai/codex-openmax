#!/usr/bin/env node
// codex-openmax CLI — the mechanical layer under the generated onboarding prompt
// (docs/onboarding-design.md):
//   init  — non-interactive: connection material (stdin JSON) -> redeem invitation ->
//           hydrate self -> write config.json (0600). Never echoes secrets.
//   start — load config.json -> real SDK bridge -> main() (adapter server), foreground,
//           graceful SIGINT/SIGTERM.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { buildConfig, writeConfigFile, type FetchLike, type OnboardInput } from "./onboarding.js";

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
	for (const f of ["bff_url", "ws_url", "org_id", "api_key", "identity_id"] as const) {
		if (typeof input[f] !== "string" || !input[f]) {
			console.error(`init: missing required field "${f}"`);
			process.exit(1);
		}
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
		const org = (config.org as { self?: { display_name?: string } }).self?.display_name ?? "?";
		// Machine-readable success line. No secrets: display name + org only.
		console.log(JSON.stringify({ ok: true, org: input.org_id, self: org, codex: codexOk }));
	} catch (e) {
		console.error(`init: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	}
}

async function cmdStart(): Promise<void> {
	let cfg: Record<string, unknown>;
	try {
		cfg = JSON.parse(readFileSync("config.json", "utf8")) as Record<string, unknown>;
	} catch {
		console.error("start: ./config.json missing or invalid — run `codex-openmax init` first");
		process.exit(1);
	}
	if (!(cfg.org as { org_id?: string } | undefined)?.org_id) {
		console.error("start: config.json lacks an org block — re-run init");
		process.exit(1);
	}
	// The SDK ships plain JS/ESM with no type declarations; construct via dynamic import.
	const sdk = (await import("@openmaxai/openmax-agent-sdk")) as Record<string, any>;
	const { createSdkCwsBridge } = await import("./bridge/sdk-bridge.js");
	const { main } = await import("./index.js");
	const cws = cfg.cws as { bffUrl: string; wsUrl: string; apiKey: string };
	const org = cfg.org as { org_id: string; self: { member_id: string } };
	const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
	const logger = { info: log, warn: log, error: log, debug: () => {}, log };
	const tokenManager = new sdk.TokenManager({
		apiKey: cws.apiKey,
		coreUrl: cws.bffUrl,
		storage: sdk.memoryStorage(),
		resolveDefaultOrgId: () => org.org_id,
		logger,
	});
	const http = new sdk.CwsHttpClient({
		baseUrl: cws.bffUrl,
		apiKey: cws.apiKey,
		tokenManager,
		resolveDefaultOrgId: () => org.org_id,
		logger,
	});
	const bridge = createSdkCwsBridge(
		(deliver) =>
			new sdk.CwsAgentBridge({
				http,
				tokenManager,
				ws: { baseUrl: cws.wsUrl, deviceId: `codex-openmax-${org.self.member_id.slice(-6)}`, clientVersion: "codex-openmax/0.0.1" },
				orgConfigs: [cfg.org],
				providers: { logger, inbound: { deliver } },
				callbacks: { syncSelf: async () => ({ nameReady: true }) },
				reporters: { metrics: false },
			}),
	);
	const handle = await main(bridge);
	log(`[codex-openmax] online — adapter on :${handle.port}, org=${org.org_id}`);
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
