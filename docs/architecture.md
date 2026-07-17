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

The OpenAI Codex **CLI** is the only surface exposing a stable programmatic injection interface: `codex app-server` (JSON-RPC over **stdio** — there is no `--listen ws` in 0.136.0), with `turn/start` / `turn/steer` / `thread/inject_items`. Desktop/IDE extensions lack this, so they are out of scope for Layer 2's wake→inject. Exact protocol shapes are pinned in `p0-spike-findings.md` against the current Codex CLI version.

## Three design decisions (RESOLVED in P0 — see `p0-spike-findings.md`)

1. **Injection model** — DECIDED: spawn `codex app-server` as a stdio child; active turn → `turn/steer` (CAS on `expectedTurnId`; the error carries the real id → retry once, else fall back); no active turn → `turn/start`; context-only append → `thread/inject_items`. The `codex mcp-server` `codex-reply` fallback is **not needed**.
2. **No active turn** — DECIDED: `turn/start` on the same app-server connection (a bare `turn/steer` with no active turn errors `no active turn to steer`).
3. **`ok:true` = truly delivered** — DECIDED: gate on the injected `userMessage`'s `item/completed` (matched by `clientUserMessageId`); RPC-accepted-but-unconfirmed ⇒ `inject_failed`, never `ok:true`.

## Phases

| Phase | Content | Output |
|---|---|---|
| **P0 Spike** ✅ | spawn `codex app-server` (stdio JSON-RPC), prove "external JSON-RPC injects a message → Codex sees it and replies" (live PONG done) | injection model decided + no-turn conclusion |
| **P1 MVP** 🚧 | repo init ✅ → codex-client + inject + outbound ✅ → SDK v0 wiring → local HTTP /wake /send → bidirectional round-trip test | bidirectional connectivity, contract aligned |
| **P2 Hardening** | ok:true invariant + verification; failureClass + backoff; no-turn/backpressure/concurrent wakes; outbound streaming | contract invariants + edge cases |
| **P3 Integration** | Workspace scheduling adapter; live end-to-end; regression tests | end-to-end green |

## Deferred to P2 Hardening (owner decision A — merge-now-harden-later, 2026-07-17)

- **Full-fidelity server-request contract** (from PR #1 R5 review): today the handler types + runtime
  validator model the answerable methods faithfully — structured decision variants
  (execpolicy / network-policy amendments) + deep JsonValue validation — and fail closed on the
  four no-safe-default methods. Still to do when the approval path is actually integrated: derive/
  import the pinned official generated bindings, model all 10 methods' `params` exactly, and
  generate conformance fixtures from the same authoritative schema. Until a handler is registered,
  the safe default-deny policy runs (no runtime exposure), which is why this is P2, not a P1 merge gate.

## Open items (from review of the proposal)

- Shared SDK boundary: it must NOT pull in `zylos-openmax`-specific pieces (WS→session injection, auto-upgrade, cf-access, access-control config, memory/scheduler).
- Contract gaps to fill: outbound streaming, `failureClass` enumeration, multi-org context in wake, backpressure while a turn is running.
- SDK v0 is the critical-path dependency for all adapters — ship it in two beats (connect+auth+send/recv first).
