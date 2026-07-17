# codex-openmax

**Codex CLI ⇆ OpenMax/CWS channel adapter** (Category B).

Connects the [OpenAI Codex **CLI**](https://github.com/openai/codex) (a bare runtime with no built-in channel) to the OpenMax / CWS platform, following the shared **Bridge + Runtime Adapter** two-layer architecture:

- **Layer 1 · Bridge** — uses the shared `@openmaxai/cws-agent-sdk` to talk the CWS protocol over WebSocket (connect / auth / heartbeat / reconnect / message send-recv).
- **Layer 2 · Runtime Adapter** — Codex-specific: exposes local HTTP `POST /wake` (inject a CWS message into Codex) and `POST /send` (relay Codex output back to CWS), driving Codex via its `app-server` (JSON-RPC over WebSocket) / `mcp-server` interfaces.

> Integration target is the **Codex CLI** (`codex app-server` / `codex mcp-server` / `turn·steer`), **not** the desktop / IDE extension — those lack a stable programmatic injection surface. See `docs/`.

## Status

🚧 **Scaffold — pre-P0.** Structural stubs only; no implementation yet. The three up-front design decisions (injection model / no-active-turn handling / `ok:true`=truly-delivered verification) are resolved in **P0 Spike** before implementation. Full architecture + phased plan: [`docs/architecture-and-plan.md`](docs/architecture-and-plan.md).

## Layout

```
src/
  index.ts              # entry: wire Bridge + Adapter
  config.ts             # config load/validate
  types.ts              # /wake /send contract types
  bridge/cws-bridge.ts  # Layer 1 (uses @openmaxai/cws-agent-sdk; mocked until SDK v0)
  adapter/
    server.ts           # local HTTP: POST /wake, POST /send
    codex-client.ts     # codex app-server ws JSON-RPC client
    inject.ts           # injection model: turn/steer + codex-reply fallback + no-turn
    outbound.ts         # capture Codex output -> /send
    invariants.ts       # ok:true "truly delivered" + failureClass
test/                   # unit + e2e (P2 killing regressions land here)
docs/                   # architecture & development plan
```

## Dependency note

Layer 1 will depend on **`@openmaxai/cws-agent-sdk`** once **SDK v0** (connect + auth + send/recv) is published; until then `bridge/` mocks that interface so the adapter can start (see the plan's P1 前置依赖).

## Dev

```bash
npm install
npm run typecheck
npm test
```
