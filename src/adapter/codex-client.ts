// codex app-server WebSocket JSON-RPC client (carrier layer).
// `codex app-server --listen ws://...`; manages connection / turn state / turn.steer /
// codex-reply(threadId). Integration target = Codex CLI (not desktop/IDE), see Architecture Part 2.1.
export interface CodexClient {
	connect(): Promise<void>;
	hasActiveTurn(): boolean;
	steer(text: string): Promise<void>; // inject into the running turn
	reply(threadId: string, text: string): Promise<void>; // no-turn fallback / external orchestration
}

export function createCodexClient(_wsUrl: string): CodexClient {
	throw new Error("createCodexClient() not implemented (P0 spike resolves protocol details first)");
}
