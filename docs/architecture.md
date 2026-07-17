# codex-openmax — Architecture & Plan

## Where this fits

Part of the OpenMax Agent Runtime integration: four external runtimes (OpenClaw, Hermes, Claude Code, **Codex**) connect to OpenMax/CWS via a shared **Bridge + Runtime Adapter** two-layer pattern. Constraints: extract a shared SDK (don't share the `zylos-openmax` component); one independent repo per runtime under `github.com/openmaxai`; split by runtime capability; don't reinvent session/compaction.

Codex is a **Category B** runtime — a bare CLI with no built-in channel — so this repo builds a channel adapter (pattern borrowed from `raft-external-agents`).

## Two layers

```
CWS Server ⟷ WebSocket ⟷ [ Layer 1 Bridge (@openmaxai/cws-agent-sdk) ]
                          ⟷ local HTTP /wake · /send ⟷
                          [ Layer 2 Runtime Adapter (Codex-specific) ]
                          ⟷ app-server JSON-RPC ⟷ Codex CLI
```

- **Layer 1 (Bridge)** — thin; the shared SDK handles CWS protocol (connect/auth/heartbeat/reconnect, message send-recv, identity). Mocked until SDK v0 ships.
- **Layer 2 (Adapter)** — Codex-specific; the bulk of this repo.

## Interface contract (Layer1 ↔ Layer2, local HTTP)

- `POST /wake` `{schema, messageId, conversationId, senderId, contentPreview}` → `{ok:true, runtimeSession}` | `{ok:false, failureClass, retryAfterMs}`
- `POST /send` `{conversationId, content, replyTo?}` → `{ok:true, messageId}`

**Key invariant:** `ok:true` MUST mean the message truly entered Codex's visible context — never "return success but drop it" (upstream would abandon retry → silent loss).

## Integration target: Codex CLI (not desktop/IDE)

The OpenAI Codex **CLI** is the only surface exposing a stable programmatic injection interface: `codex app-server` (JSON-RPC, stdio or `--listen ws://…`), `codex mcp-server` (`codex()` / `codex-reply(threadId)`), `turn.steer`. Desktop/IDE extensions lack this, so they are out of scope for Layer 2's wake→inject. Exact protocol details are pinned in P0 against the current Codex CLI version.

## Three design decisions (resolve in P0, before implementation)

1. **Injection model** — `turn.steer` (into a running turn) vs `codex-reply(threadId)` (external) vs `app-server --listen ws` as the carrier. Leaning: ws JSON-RPC carrier + `turn.steer`, `codex-reply` as fallback.
2. **No active turn** — how a wake is handled when no turn is running (start a new turn? queue?). Codex-specific gap.
3. **`ok:true` = truly delivered** — how to verify injection actually reached Codex's visible context.

## Phases

| Phase | Content | Output |
|---|---|---|
| **P0 Spike** | run `codex app-server --listen ws`, prove "external JSON-RPC injects a message → Codex sees it and replies" | injection model decided + no-turn conclusion |
| **P1 MVP** | repo init → SDK v0 wiring → Inbound (/wake→inject) → Outbound (output→/send) → basic round-trip test | bidirectional connectivity, contract aligned |
| **P2 Hardening** | ok:true invariant + verification; failureClass + backoff; no-turn/backpressure/concurrent wakes; outbound streaming | contract invariants + edge cases |
| **P3 Integration** | Workspace scheduling adapter; live end-to-end; regression tests | end-to-end green |

## Open items (from review of the proposal)

- Shared SDK boundary: it must NOT pull in `zylos-openmax`-specific pieces (WS→session injection, auto-upgrade, cf-access, access-control config, memory/scheduler).
- Contract gaps to fill: outbound streaming, `failureClass` enumeration, multi-org context in wake, backpressure while a turn is running.
- SDK v0 is the critical-path dependency for all adapters — ship it in two beats (connect+auth+send/recv first).
