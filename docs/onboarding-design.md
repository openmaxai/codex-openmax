# P2-① — Generated onboarding prompt + `init`/`start` CLI

Decision (owner, 2026-07-17): the **primary user path** for connecting a Codex agent to
OpenMax is a **config-embedded generated prompt** — the workspace renders a prompt with all
connection material inlined; the user pastes the whole block into their Codex; Codex (the
agent itself) installs this package, writes its config, starts the service and reports
"online". Zero interactive input. The CLI (`init`/`start`) is the **mechanical layer** the
prompt drives; humans can also call it directly.

Validated by the 2026-07-17 live onboarding: a fully-inlined config block (org_id,
invitation id, token, URLs) was pasted to this agent and the stack came up with zero
follow-up questions.

## Components

| Piece | Where | Role |
|-------|-------|------|
| Prompt template | `templates/onboarding-prompt.md` | Rendered by the platform (workspace "Add Codex agent" flow, luna/gavin's side); placeholders `{{…}}` |
| `codex-openmax init` | `src/cli.ts` | Non-interactive: consume connection material → (redeem invitation → api key) → write `config.json` → validate `codex` binary present |
| `codex-openmax start` | `src/cli.ts` | Productized `scripts/live-roundtrip.ts`: construct the real `CwsAgentBridge` from `config.json`, run `main()`, keep alive; `--daemon` mode later |

## `init` contract (non-interactive, idempotent)

Input precedence: flags → `--stdin-json` (single JSON blob, what the prompt uses) →
environment. Required material: `bff_url`, `ws_url`, `org_id`, and EITHER
(`invitation_id` + `invitation_token`) OR a ready `api_key` (+ `identity_id`).

Steps:
1. If invitation material given: redeem → obtain `identity_id` + `api_key`.
   *Implementation note: verify the redemption endpoint against the platform/SDK docs at
   implementation time (the 07-17 manual run used the invitation flow successfully; pin
   the exact endpoint + payload from the SDK/onboarding docs, do NOT guess).*
2. Hydrate org block (`self` member_id / display_name, `owner`) from the platform
   (`/api/v1/…` with the fresh JWT) — same material `config.json` carries today.
3. Write `config.json` (0600). Never echo `api_key`/token back to stdout — print a
   fingerprint (`…last4`) only.
4. Preflight: `codex --version` ≥ minimum; warn (not fail) if missing — `start` hard-fails.
5. Exit 0 with a one-line machine-readable summary (`{"ok":true,"org":"…","self":"…"}`).

## `start` contract

1. Load + validate `config.json` (fail fast with actionable message).
2. Build TokenManager/HttpClient/CwsAgentBridge exactly as `scripts/live-roundtrip.ts`
   does today (that script then becomes a thin wrapper or is retired).
3. `main(bridge)` → adapter server on configured port; log "online" line the prompt tells
   Codex to report back.
4. Signal handling: SIGINT/SIGTERM → graceful stop (bridge.stop + server close).

## Security posture (from the 07-17 decision, verbatim requirements)

- The rendered prompt **contains a one-time invitation credential** — it IS an invite
  link. Template carries a visible warning: *do not forward/publish; the token is
  single-use and expiring.*
- The prompt instructs Codex to **never echo the token** in its replies (report success
  by org/display-name only).
- `config.json` is written 0600 and gitignored (already is).

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
