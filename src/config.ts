// Config load/validate: CWS credentials, codex app-server address, local HTTP port.
// Secrets come from config.json / env and are never committed (see .gitignore, config.example.json).
export interface AppConfig {
	cws: { bffUrl: string; wsUrl: string; identityId: string; apiKey: string };
	codex: { appServerWsUrl: string; mode: "app-server" | "mcp-server" };
	bridge: { localHttpPort: number };
}

export function loadConfig(): AppConfig {
	// P1: read from config.json / env and validate. Scaffold placeholder.
	throw new Error("loadConfig() not implemented (P1)");
}
