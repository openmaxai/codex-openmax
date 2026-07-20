# codex-openmax

**Codex CLI ⇆ OpenMax/CWS channel adapter** (Category B) — connects the
[OpenAI Codex **CLI**](https://github.com/openai/codex) (a bare runtime with no built-in
channel) to the OpenMax / CWS platform.

[![npm](https://img.shields.io/npm/v/@openmaxai/codex-openmax/alpha)](https://www.npmjs.com/package/@openmaxai/codex-openmax)

## Status

**Alpha — published.** `@openmaxai/codex-openmax@0.1.0-alpha.0` is on npm. P1 MVP (the
`/wake`+`/send` bridge, wake queue, SDK-backed CWS bridge) and P2-① (the `init`/`start`
onboarding CLI) are shipped. Backed by the real `@openmaxai/openmax-agent-sdk`; verified with
a live end-to-end round-trip against openmax.com.

## What it is

Two layers, following the shared **Bridge + Runtime Adapter** architecture:

- **Layer 1 · Bridge** — uses `@openmaxai/openmax-agent-sdk` to speak the CWS protocol over
  WebSocket (connect / auth / heartbeat / reconnect / sync / message send-recv).
- **Layer 2 · Runtime Adapter** — Codex-specific: a local HTTP server exposing `POST /wake`
  (inject an inbound CWS message into Codex) and `POST /send` (relay Codex output back to
  CWS), driving Codex by spawning `codex app-server` and speaking JSON-RPC over its **stdio**.

> Integration target is the **Codex CLI** (`codex app-server` · `turn/start` · `turn/steer`),
> **not** the desktop / IDE extension — those lack a stable programmatic injection surface.
> (A `codex app-server --listen ws://` transport exists as of codex-cli 0.144.5 and is
> tracked as a future option; the shipped adapter uses stdio.) See [`docs/`](docs/).

## Install

```bash
npm install -g @openmaxai/codex-openmax
```

## Usage

The adapter is normally onboarded by the **OpenMax workspace** ("Add Codex agent"), which
renders a prompt with the connection material inlined; pasting it into a Codex runs the two
commands below with zero interactive input. You can also run them directly.

`init` accepts either of two mutually-exclusive credential shapes on stdin:

```bash
# 1a. Initialize with a provisioned api_key + identity_id (direct).
codex-openmax init --stdin-json <<'ONBOARD'
{
  "bff_url": "https://openmax.com",
  "ws_url": "wss://openmax.com/ws",
  "org_id": "<org id>",
  "api_key": "<provisioned agent api key>",
  "identity_id": "<provisioned identity id>"
}
ONBOARD

# 1b. …or self-register with an invitation (no pre-provisioned credential needed).
codex-openmax init --stdin-json <<'ONBOARD'
{
  "bff_url": "https://openmax.com",
  "ws_url": "wss://openmax.com/ws",
  "org_id": "<org id>",
  "invitation_id": "<invitation id>",
  "invitation_token": "<invitation token>"
}
ONBOARD

# 2. Start — connect to CWS and run the adapter (foreground).
codex-openmax start
```

With the invitation shape, `init` self-registers a new agent identity
(`POST /auth/register/agent`), exchanges an identity-only JWT, accepts the invitation with it,
then exchanges an org-scoped JWT — the same self-register → identity-JWT → accept → org-JWT
pattern the platform's default "zylos" agent type already uses. Either way, `init` exchanges
the org JWT, hydrates the agent's own member info, and writes `config.json` (mode `0600`; the
api_key — direct-supplied or self-minted — is never echoed). `start` reads that config,
connects the SDK bridge, and serves the adapter until `SIGINT`/`SIGTERM`. Requires the `codex`
binary on `PATH`. Full field contract + security notes:
[`docs/onboarding-design.md`](docs/onboarding-design.md).

**`start` is an independent process, not tied to your current shell session.** It keeps
running after you close the terminal, CLI, or agent session you launched it from — closing
that session does not stop the adapter. To stop it, `Ctrl+C` the process (or `kill` its PID)
in the terminal it's actually running in.

### Running as a persistent service (optional)

If you want `codex-openmax` to survive a reboot or keep running unattended, run `start` under
a process manager instead of a bare foreground shell. **This is optional and changes system
state (a boot-persistent service) — ask the user before setting it up; don't do it silently as
part of the default init/start flow.**

systemd (user service, survives reboot with `loginctl enable-linger`):

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/codex-openmax.service <<'UNIT'
[Unit]
Description=codex-openmax adapter

[Service]
WorkingDirectory=%h/path/to/your/config-dir
ExecStart=codex-openmax start
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now codex-openmax
loginctl enable-linger "$USER"   # keep the user service running across reboots/logout
```

pm2:

```bash
pm2 start codex-openmax --name codex-openmax -- start
pm2 save
pm2 startup   # prints the command to enable pm2 itself on boot
```

Either way, run `codex-openmax init` once beforehand so `config.json` already exists in the
working directory the service starts from.

## Layout

```
src/
  index.ts               # entry: wire Bridge + Adapter, main(bridge)
  cli.ts                 # `codex-openmax init` / `start`
  onboarding.ts          # init plumbing: JWT exchange, self-hydration, 0600 config write
  config.ts              # config load/validate
  types.ts               # /wake /send contract types
  bridge/
    cws-bridge.ts        # CwsBridge interface (+ mock for tests)
    sdk-bridge.ts        # Layer 1: adapts @openmaxai/openmax-agent-sdk → CwsBridge
  adapter/
    server.ts            # local HTTP: POST /wake, POST /send
    codex-client.ts      # codex app-server stdio JSON-RPC client (turn tracking, bounded failure)
    inject.ts            # injection model: turn/steer (active) / turn/start (no-turn); ok:true delivery gate
    wake-queue.ts        # per-conversation serialization, dedup, backpressure
    outbound.ts          # capture Codex agentMessage output → /send
    invariants.ts        # ok:true "truly delivered" + failureClass semantics
test/                    # unit + killing regressions + SDK-golden contract conformance
docs/                    # architecture, onboarding design, P0 spike findings
scripts/live-roundtrip.ts  # manual full-stack live run against real CWS + codex
```

## Dev

```bash
npm install
npm run typecheck
npm test          # includes the type-test gate + SDK contract conformance
npm run build
```

Publishing is tag-driven: a `v*` tag on a commit contained in `main` triggers the release
workflow (`npm publish` with provenance). See [`.github/workflows/release.yml`](.github/workflows/release.yml).
