# P2-① — `init`/`start` CLI (onboarding mechanical layer)

Decision (owner, 2026-07-17): the **primary user path** for connecting a Codex agent to
OpenMax is a **config-embedded generated prompt** — the workspace renders a prompt with all
connection material inlined; the user pastes the whole block into their Codex; Codex (the
agent itself) installs this package, writes its config, starts the service and reports
"online". Zero interactive input. **This repo owns the CLI (`init`/`start`) mechanical layer
the prompt drives; the workspace product owns rendering the prompt itself** (owner, 2026-07-20).
Humans can also call the CLI directly.

**Credential form — corrected after live testing (2026-07-20).** The prompt embeds a
provisioned agent **`api_key` + `identity_id`**, NOT an invitation to redeem. Live testing
against the box org proved `/api/v1/invitations/{id}/accept` is a **human-only** flow: an
unauthenticated call 401s, and an authenticated agent JWT is rejected
`MEMBER_INVALID_AGENT_OWNER: new owner must be an active human member`. So a Codex agent can
never self-redeem an invitation. The platform side ("Add Codex agent", where the human is
already logged in) provisions the api_key and embeds it in the rendered prompt — matching the
SDK README's "dashboard/api-key provisioning" being platform-owned. The 07-17 "embed
invitation token → agent self-redeems" framing was the untested assumption this replaces; the
api_key path is verified working end-to-end (init → JWT via Bearer → /me hydration → config).

## Components

| Piece | Where | Role |
|-------|-------|------|
| `codex-openmax init` | `src/cli.ts` | Non-interactive: consume connection material (api_key + identity_id) → exchange JWT → hydrate self → write `config.json` → preflight `codex` binary |
| `codex-openmax start` | `src/cli.ts` | Productized `scripts/live-roundtrip.ts`: construct the real `CwsAgentBridge` from `config.json`, run `main()`, keep alive; `--daemon` mode later |

**The onboarding prompt is rendered by the OpenMax workspace product, not this repo** (owner
call, 2026-07-20). This repo owns only the CLI mechanical layer; the platform owns generating
the paste-ready prompt. What the platform must embed in that prompt = exactly `init`'s
`--stdin-json` contract below (`bff_url`, `ws_url`, `org_id`, `api_key`, `identity_id`, optional
`local_http_port`), plus the security requirement that the api_key is a long-lived credential:
warn the user not to forward the prompt, and instruct the agent never to echo the key back.

## `init` contract (non-interactive, idempotent)

Reads one JSON blob on stdin (`--stdin-json`, what the prompt uses). Required:
`bff_url`, `ws_url`, `org_id`, `api_key`, `identity_id`. Optional: `local_http_port`.

Steps:
1. Validate all required fields present (before any network call).
2. Exchange the org JWT: `POST /auth/agent/token {org_id}` with `Authorization: Bearer <api_key>`
   (the shape the SDK's TokenManager sends and cws-core reads — verified live).
3. Hydrate the org `self` block (member_id / display_name) from `GET /api/v1/me` with the JWT.
4. Write `config.json` at a guaranteed `0600` (temp-file + explicit chmod + atomic rename).
   Never echo the api_key: the success line carries only org id + display name.
5. Preflight: `codex --version`; warn (not fail) if missing — `start` hard-fails.
6. Exit 0 with a one-line machine-readable summary (`{"ok":true,"org":"…","self":"…","codex":…}`).

## `start` contract

1. Load + validate `config.json` (fail fast with actionable message).
2. Build TokenManager/HttpClient/CwsAgentBridge exactly as `scripts/live-roundtrip.ts`
   does today (that script then becomes a thin wrapper or is retired).
3. `main(bridge)` → adapter server on configured port; log "online" line the prompt tells
   Codex to report back.
4. Signal handling: SIGINT/SIGTERM → graceful stop (bridge.stop + server close).

## Security posture

- The embedded `api_key` is a **long-lived credential** — the platform-rendered prompt must
  warn the user not to forward/screenshot it, and instruct the agent never to echo it (report
  success by org/display-name only). `init`'s success line and all error messages are already
  key-free (errors carry endpoint labels, never raw URLs/values).
- `config.json` is written `0600` and gitignored (already is), guaranteed even when
  overwriting an existing file or when a loose temp file pre-exists (temp + chmod + atomic
  rename — see `writeConfigFile`).

## Non-goals (this PR)

- No platform-side rendering (that's the workspace flow, tracked with luna/gavin).
- No daemonization/pm2 packaging (`start` runs foreground; supervisor integration later).
- No ws/daemon transport (P2 item ② — codex 0.144.5's `app-server --listen ws://`).

## Distribution (added after owner review, 2026-07-20)

The prompt's step 1 is `npm install -g @openmaxai/codex-openmax` — which requires the
package to actually be on npm. Decisions (owner-agreed):

- **Published name: `@openmaxai/codex-openmax`** (org scope — brand-consistent with
  `@openmaxai/openmax-agent-sdk`, and the bare name is squattable). Both names were
  verified unclaimed on 2026-07-20. The bin remains `codex-openmax`.
- **Release mechanics: copied from the SDK repo** (`.github/workflows/release.yml`):
  `v*` tag → GitHub Actions → npm publish with provenance, gated on the protected
  `release` environment (human approval) and a tag-must-be-on-main ancestry check.
  One adaptation: a build step (this repo ships compiled `dist/`).
- **Package payload** (`files`): `dist/`, `templates/`, `docs/`, README. `prepack`
  runs the build so a stray manual `npm pack` can't ship stale artifacts.
- **Versioning**: prerelease `0.1.0-alpha.N` while the platform-side prompt rendering
  is unshipped, mirroring the SDK's convention (and its dist-tag lesson: prereleases
  move `latest` while no stable exists).
- **Needs org side**: npm publish credentials for `@openmaxai` (reuse the SDK's
  NPM_TOKEN / release-environment setup — owner/gavin to wire the repo secret).
- Interim fallback (not the official path): `npm install -g github:openmaxai/codex-openmax`
  would need a `prepare` script; deliberately NOT added — one blessed install path.
