# codex-openmax

**Codex CLI ⇆ OpenMax/CWS channel adapter** (Category B).

Connects the [OpenAI Codex **CLI**](https://github.com/openai/codex) (a bare runtime with no built-in channel) to the OpenMax / CWS platform, following the shared **Bridge + Runtime Adapter** two-layer architecture:

- **Layer 1 · Bridge** — uses the shared `@openmaxai/cws-agent-sdk` to talk the CWS protocol over WebSocket (connect / auth / heartbeat / reconnect / message send-recv).
- **Layer 2 · Runtime Adapter** — Codex-specific: exposes local HTTP `POST /wake` (inject a CWS message into Codex) and `POST /send` (relay Codex output back to CWS), driving Codex by spawning `codex app-server` and speaking JSON-RPC over its **stdio** (see P0 findings — there is no `--listen ws` in codex-cli 0.136.0).

> Integration target is the **Codex CLI** (`codex app-server` · `turn/start` · `turn/steer` · `thread/inject_items`), **not** the desktop / IDE extension — those lack a stable programmatic injection surface. See `docs/`.

## Status

✅ **P0 closed · P1 in progress.** Injection model decided and the stdio JSON-RPC client + `injectWake` + outbound capture are implemented against real protocol shapes (`docs/p0-spike-findings.md` — includes a live PONG round-trip). Full architecture + phased plan: [`docs/architecture.md`](docs/architecture.md).

## Layout

```
src/
  index.ts              # entry: wire Bridge + Adapter
  config.ts             # config load/validate
  types.ts              # /wake /send contract types
  bridge/cws-bridge.ts  # Layer 1 (uses @openmaxai/cws-agent-sdk; mocked until SDK v0)
  adapter/
    server.ts           # local HTTP: POST /wake, POST /send
    codex-client.ts     # codex app-server stdio JSON-RPC client (turn tracking, server-req handling, bounded failure)
    inject.ts           # injection model: turn/steer (active) / turn/start (no-turn); ok:true delivery gate
    outbound.ts         # capture Codex agentMessage output -> /send
    invariants.ts       # ok:true "truly delivered" + failureClass
test/                   # unit + killing regressions (parser / multi-thread / server-req / failure convergence)
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
