// LIVE end-to-end runner: real CWS (openmax.com) ⟷ real SDK CwsAgentBridge ⟷ sdk-bridge
// ⟷ local HTTP /wake /send ⟷ real codex app-server. Run with `npx vite-node scripts/live-roundtrip.ts`
// from the repo root; credentials come from ./config.json (gitignored) — see config.example.json
// plus an `org` block ({slug, org_id, self, owner, access}).
import { readFileSync } from "node:fs";
// @ts-expect-error — the alpha SDK ships no type declarations yet (plain JS/ESM)
import { CwsAgentBridge, CwsHttpClient, TokenManager, memoryStorage } from "@openmaxai/openmax-agent-sdk";
import { createSdkCwsBridge } from "../src/bridge/sdk-bridge.js";
import { main } from "../src/index.js";

const cfg = JSON.parse(readFileSync("config.json", "utf8"));
if (!cfg.org?.org_id) throw new Error("config.json needs an `org` block for the live run");

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const logger = { info: log, warn: log, error: log, debug: () => {}, log };

const tokenManager = new TokenManager({
	apiKey: cfg.cws.apiKey,
	coreUrl: cfg.cws.bffUrl,
	storage: memoryStorage(),
	resolveDefaultOrgId: () => cfg.org.org_id,
	logger,
});
const http = new CwsHttpClient({
	baseUrl: cfg.cws.bffUrl,
	apiKey: cfg.cws.apiKey,
	tokenManager,
	resolveDefaultOrgId: () => cfg.org.org_id,
	logger,
});

const bridge = createSdkCwsBridge(
	(deliver) =>
		new CwsAgentBridge({
			http,
			tokenManager,
			ws: { baseUrl: cfg.cws.wsUrl, deviceId: `codex-openmax-${cfg.org.self.member_id.slice(-6)}`, clientVersion: "codex-openmax/0.0.1" },
			orgConfigs: [cfg.org],
			providers: { logger, inbound: { deliver } },
			callbacks: { syncSelf: async () => ({ nameReady: true }) },
			reporters: { metrics: false },
		}),
);

const handle = await main(bridge);
log(`[live] full stack up — local adapter on :${handle.port}, org=${cfg.org.slug}, self=${cfg.org.self.display_name}`);
log("[live] waiting for inbound CWS messages (send the agent a DM)…");

process.on("SIGINT", async () => {
	log("[live] stopping…");
	await handle.stop();
	process.exit(0);
});
