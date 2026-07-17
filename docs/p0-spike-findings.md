# P0 Spike Findings — Injection Model (M1)

Date: 2026-07-17 · Codex CLI: `codex-cli 0.136.0` · Method: live JSON-RPC probe against `codex app-server` (see `scripts/spike/appserver-probe.mjs`), protocol schema via `codex app-server generate-json-schema`.

## Verdict (M1: injection model decided)

| Situation | Mechanism | Verified |
|---|---|---|
| Wake, **no active turn** | `turn/start { threadId, input }` — starts a new turn natively on the same connection | ✅ live |
| Wake, **active turn** | `turn/steer { threadId, expectedTurnId, input }` — CAS-guarded injection into the running turn | ✅ live (failure path) |
| Context-only append (no reply wanted) | `thread/inject_items { threadId, items }` — appends raw Responses API items to model-visible history without starting a turn | ✅ live |

The plan's assumed fallback — `codex-reply(threadId)` via `codex mcp-server` — is **not needed**: `turn/start` covers the no-turn case on the app-server connection itself.

## Key findings

1. **Transport drift vs. plan**: `codex app-server --listen ws://…` does **not exist** in 0.136.0. Actual options: (a) spawn `codex app-server` as a child process speaking JSONL JSON-RPC over **stdio** — verified working; (b) `codex app-server daemon start` + `codex app-server proxy` (stdio↔control socket) for a durable shared daemon, incl. `enable-remote-control`. Adapter should use (a) for MVP, evaluate (b) in P2 for restart-survival.

2. **Handshake**: `initialize { clientInfo }` → responds with `userAgent`, `codexHome`, platform. Then `thread/start { cwd, ephemeral }` → returns full thread object (id, status `idle`, model, provider) + `thread/started` notification.

3. **"ok:true = actually delivered" has a native signal** (design decision #3 answered): after `turn/start`, the server emits `item/started` + `item/completed` for the injected `userMessage` item (with threadId/turnId). That notification pair **is** the confirmation that the message entered model-visible history — the adapter's `/wake → ok:true` should be gated on it, not on the RPC response alone.

4. **`turn/steer` CAS semantics are recovery-friendly**: steering with a stale/wrong `expectedTurnId` fails with `-32600` and the error message **contains the actual active turn id** (`expected active turn id `X` but found `Y``). Recovery: parse/track and retry — no separate status query needed. Adapter should still track `turn/started` / `turn/completed` notifications as the primary source of the active-turn id.

5. **`thread/inject_items` works mid-turn and idle**, returns `{}`. Items are raw Responses API shapes (e.g. `{type:"message", role:"user", content:[{type:"input_text", text}]}`). Useful for batching FYI messages without burning turns; the model sees them on the next turn.

6. **Structured error surface** (P2 failureClass input): model-call failures arrive as `error` notifications with `codexErrorInfo` (e.g. `responseStreamDisconnected.httpStatusCode: 401`), `willRetry`, and threadId/turnId attribution. Codex retries internally ("Reconnecting… n/5") before giving up.

7. **Outbound capture path**: `item/agentMessage/delta` (streaming) → `item/completed` (final item) → `turn/completed`. Track `thread/status/changed` (`idle`/`active`) for turn-state. 64 server notification methods total; schema dumps live in the spike scratchpad and can be regenerated any time via `codex app-server generate-json-schema --out <dir>`.

## Not yet verified (needs OpenAI auth)

The box has no OpenAI credentials (`codex login status` → Not logged in), so the final leg — a real model reply round-trip — 401s at `wss://api.openai.com/v1/responses`. Everything up to and including message-entered-history is verified. **Blocker for closing P0 completely: an OpenAI API key or ChatGPT-plan `codex login` on this machine.**

## Consequences for the P1 MVP

- `src/adapter/codex-client.ts`: child-process stdio JSONL client; maintain `activeTurnId` from notifications.
- `src/adapter/inject.ts`: wake → if `activeTurnId` present → `turn/steer` (retry once on CAS mismatch with returned id) else `turn/start`; resolve ok:true on the injected item's `item/completed`.
- `src/adapter/outbound.ts`: subscribe `item/agentMessage/delta` / `item/completed` / `turn/completed`; flush to bridge `/send` on item completion (streaming strategy = P2).
