#!/usr/bin/env node
// codex-openmax CLI — the mechanical layer under the generated onboarding prompt
// (docs/onboarding-design.md). Two subcommands:
//   init  — non-interactive: consume connection material -> write config.json
//   start — load config.json -> real SDK bridge -> main() (adapter server), foreground
// SKELETON (P2-①): command surface + config plumbing land first; invitation redemption
// and org hydration are implemented against the platform/SDK docs in this same PR before
// it leaves draft — `init` currently fails loudly on the unimplemented path rather than
// pretending.

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
	const raw = JSON.parse(await readStdin()) as Record<string, unknown>;
	for (const f of ["bff_url", "ws_url", "org_id"]) {
		if (typeof raw[f] !== "string" || !raw[f]) {
			console.error(`init: missing required field "${f}"`);
			process.exit(1);
		}
	}
	const hasInvitation = typeof raw.invitation_id === "string" && typeof raw.invitation_token === "string";
	const hasApiKey = typeof raw.api_key === "string";
	if (!hasInvitation && !hasApiKey) {
		console.error("init: need either invitation_id+invitation_token or api_key");
		process.exit(1);
	}
	if (hasInvitation && !hasApiKey) {
		// TODO(P2-① before un-draft): redeem the invitation for identity_id+api_key against
		// the platform endpoint (pin from SDK/onboarding docs — do not guess), then hydrate
		// the org block (self/owner) with the fresh JWT. Fail-closed until implemented:
		console.error("init: invitation redemption not implemented yet (see docs/onboarding-design.md)");
		process.exit(1);
	}
	console.error("init: api_key path not implemented yet either — skeleton");
	process.exit(1);
}

async function cmdStart(): Promise<void> {
	// TODO(P2-①): productize scripts/live-roundtrip.ts here (config load -> TokenManager/
	// CwsHttpClient/CwsAgentBridge -> main(bridge)) with graceful SIGINT/SIGTERM stop.
	console.error("start: not implemented yet — use `npx vite-node scripts/live-roundtrip.ts` meanwhile");
	process.exit(1);
}

const [, , cmd, ...rest] = process.argv;
if (cmd === "init") void cmdInit(rest);
else if (cmd === "start") void cmdStart();
else usage();
