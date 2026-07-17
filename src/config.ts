// Config load/validate: CWS credentials, codex binary, local HTTP port.
// Secrets come from config.json / env and are never committed (see .gitignore, config.example.json).
// P0 finding: app-server speaks JSONL over stdio (no ws listener in codex-cli 0.136.0),
// so we configure the binary to spawn, not a URL — see docs/p0-spike-findings.md.
export interface AppConfig {
	cws: { bffUrl: string; wsUrl: string; identityId: string; apiKey: string };
	codex: { bin: string; cwd: string };
	bridge: { localHttpPort: number };
}

export function loadConfig(): AppConfig {
	// P1: read from config.json / env and validate. Scaffold placeholder.
	throw new Error("loadConfig() not implemented (P1)");
}
