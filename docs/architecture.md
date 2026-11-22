# AgentLRay Architecture

> This document describes the actual, current implementation (baseline
> `c7fdb8f`). It complements the feature/theme docs in this directory:
> [usage](usage.md), [execution evidence](diagnostics.md),
> [offline inspect](offline-inspect.md) and [single-session forensics](session-forensics.md).
> Accepted design tradeoffs live in [design/](design/README.md).
> A Chinese translation lives in [architecture.zh-CN.md](architecture.zh-CN.md).

AgentLRay is a local web dashboard for inspecting the execution evidence your
coding agents already record. It reads the native session logs of OpenClaw,
Codex, Claude Code, Hermes, OMP, DeepSeek Harness and Gemini CLI, normalizes
them into one message model, and renders a unified browser. Everything runs on
your machine against your own log files; the core inspection paths make no
model calls and upload nothing. Beyond the local process, it can connect to a
remote AgentLRay instance over an `ssh` tunnel or a dsh encrypted channel
(multi-host).

## 1. Design goals

- **Local execution evidence first.** The product is about what *actually ran*
  and which results support a conclusion — automatic facts before human labels.
  Diagnostics deliberately *do not* decide whether a task succeeded.
- **Read-only over a normalized model.** Every platform resolves to one
  `{ session, messages }` payload; all generic surfaces (routes, search, watch,
  insights, prompts, tool audit, export, OTLP, CLI) are written once against
  that model.
- **Platform registry as single source of truth.** Adding a platform is one
  adapter directory plus one declaration; nothing else changes. Platforms come
  from three sources (package / project / user) and custom ones plug in at
  runtime without touching the source.
- **Diagnostics rules authored once.** `frontend/src/views/sessions/diagnostics.ts`
  is the single rule source; `scripts/build-diagnostics.mjs` bundles it into
  `lib/generated/diagnostics.cjs` so the offline CLI and the React UI apply
  exactly the same judgement.
- **One frontend.** `frontend/` is the only feature surface (React 19 SPA);
  there is no second frozen legacy UI.
- **A consistent multi-host face.** Remote hosts are proxied transparently
  through the same routes and frontend; host management and inbound peers are
  local resources and are never re-forwarded to a remote.

## 2. High-level layering

```
                 ┌────────────────────────────────────────────┐
                 │  React 19 SPA (frontend/)   ── only UI      │
                 │  zustand store + react-query + SSE cache   │
                 └───────────────┬────────────────────────────┘
                                 │ HTTP (fetch, X-Host-Id) + SSE (?host=)
                 ┌───────────────▼────────────────────────────┐
                 │  Express backend (server.js + lib/routes/*) │
                 │  multi-host proxy · CSRF · JSON 256KB · no-store │
                 └───┬───────────┬──────────────┬─────────────┘
                     │           │              │
         ┌───────────▼──┐ ┌──────▼────────┐ ┌───▼───────────────┐
         │ lib/* business│ │ lib/platforms │ │ lib/hosts.js      │
         │ status ·     │ │ registry +    │ │ transport.js      │
         │ settings ·   │ │ adapters,     │ │ (ssh) + lib/dsh/  │
         │ llm · resume │ │ 3-source      │ │ (encrypted channel│
         │ search·inspect│ │ catalog +     │ │  / loopback)      │
         │ export·otlp  │ │ shared/ layer │ │ inbound.js        │
         └──────┬───────┘ └──────┬────────┘ └───────┬───────────┘
                └────────┬───────┘                  │
                 ┌───────▼──────────────────────────┐│
                 │ disk: platform session logs      ││
                 │ (JSONL/SQLite/zstd JSONL) +      │◄┘ remote AgentLRay
                 │ ~/.agentlray/* config            │
                 └───────────────────────────────────┘
```

## 3. Repository layout

| Path | Role |
|---|---|
| `server.js` | Express bootstrap: static serving, multi-host proxy, CSRF, no-store, route mounting, status/dirs config injection, dsh host service, listen. |
| `bin/` | CLI entry points: `agentlray.js` (dispatch), `sessions.js` (list/show/resume/new), `inspect.js` (inspect/evidence), `platform.js` (list/validate). |
| `lib/config.js` | HOME resolution, `resolveDir`/path sanitizers, `sessionMetaCache` (mtime-keyed metadata cache), file helpers. |
| `lib/platforms/` | The registry and adapters: `index.js` (three-source merge + surface projection), `loader.js` (package/project/user loader), `shared-alias.js` (`@agentlray/shared` bare-name alias), `builtin/<id>/` (package adapters), `shared/` (cross-platform shared barrel). |
| `lib/platforms/shared/` | Platform-independent shared layer: `helpers` (`makeMessage`/`withMetadataCache`), `tail-state`, `contracts` (capability/resume/create/exec-spawn), `status`, `inspect`, `search`, `insights`, `tool-audit`, `watch`, `zstd`, `config`, `text-utils`. Resolved via the bare name `@agentlray/shared/*`. |
| `platforms/` | Project-source adapters: `dsh/`, `gemini/`, `hermes/` (project-level platforms migrated out of the package), `manifest.json` (may declare `replaces`). |
| `lib/` | Platform-independent business: `status.js`, `status-config.js`, `session-list.js`, `settings.js` + section modules, `platform-config.js`, `dirs-config.js`, `llm.js`/`llm-json.js`, `resume.js`, `new.js`, `cli-bins.js`, `ui-settings.js`, `search.js`, `inspect.js`/`inspect-detail.js`, `export.js`, `otlp.js`, `insights.js`, `tool-audit.js`, `prompts.js`, `secret.js`, `csrf.js`. |
| `lib/hosts.js` · `lib/hosts-file.js` · `lib/transport.js` | Multi-host: `hosts.json` CRUD + runtime state machine + tunnel lifecycle; ssh transport (`ssh -L` port forwarding); the `hosts.json` whole-file atomic shared layer (0600). |
| `lib/inbound.js` | Inbound peer registry (the connected side's "who is connecting to me"). |
| `lib/dsh/` | dsh transport: `host.js` (resident host-side service), `client.js` (client-side encrypted channel + loopback port forwarding), `loopback*.js`, `auth.js`/`identity.js`, `settings.js`, `vendor/` (borrowed layer). |
| `lib/routes/` | Route modules: parameter validation + response shaping only; business logic lives in `lib/`. Includes `proxy.js` (the multi-host gateway, the first `/api` handler). |
| `lib/generated/diagnostics.cjs` | Bundled diagnostic rules (generated; do not hand-edit). |
| `frontend/` | React 19 + Vite + TypeScript SPA (the only feature surface). |
| `scripts/` | `build-diagnostics.mjs` (diagnostics bundle) + `build-demo-fixtures.mjs`/`build-dsh-fixtures.mjs` + demo generators. |
| `test/` | Node's built-in test runner, isolated against `test/fixtures/home`. |

## 4. Platform registry and the normalized model

`lib/platforms/index.js` **synchronously** merges three sources into a catalog at
`require` time and derives `PLATFORMS` — the single source of platform truth.
Every generic surface resolves a platform through this table.

**Three sources** (`lib/platforms/loader.js`):

| Source | Location | origin |
|---|---|---|
| package | `lib/platforms/builtin/{openclaw,codex,claude-code,omp}/` | `package` |
| project | `$AGENTLRAY_PROJECT_PLATFORMS_DIR` or `<repo>/platforms` (`dsh`/`gemini`/`hermes`) | `project` |
| user | `$AGENTLRAY_PLATFORMS_DIR` or `~/.agentlray/platforms` | `user` |

Synchronous loading is a hard requirement: downstream derivation points
(`lib/export.js`, `lib/otlp.js`, `lib/session-list.js`, routes, CLI) read
`PLATFORMS` at `require` time, so any async load would hide custom platforms.
Same-id rules: project/user override package only when `replaced` is declared;
an undeclared same-id collision is **broken** (never overrides).
`AGENTLRAY_NO_PLUGINS=1` skips project+user and keeps only package. The registry
also tracks `disabled`/`replaced` (the `settings.platforms` section, read
synchronously by `lib/platform-config.js`).

**Registry entry shape:**

| Field | Meaning |
|---|---|
| `id` | Registry key, used in URLs (`/api/<id>/sessions`) and CLI `--platform`. |
| `label` | Human-readable name (boot log, UI). |
| `defaultDir()` | Platform's session root (directory metadata lives in each platform's `dirs.js`, resolved via `@agentlray/shared/config`; `dirs-config` can override). |
| `list(dir)` | Session summaries, newest first (`null` means per-agent listing, e.g. openclaw). |
| `find(dir, id, opts?)` | Session file path \| `null` (`null` entry: not file-based, e.g. Hermes). |
| `parse(file)` | `{ session, messages }` (normalized). |
| `getSession(dir, id, opts?)` | `{ session, messages } \| null`. |
| `collectFiles(dir, opts?)` | `[{ path, file, sessionId, agent? }]` for bulk scans (search/prompts/tool-audit). |
| `watchParse(rec, line?)` | `{ messages?, session? } \| null` for the SSE tail. |
| `needsAgent` | True when `find`/`getSession` require `opts.agent` (openclaw). |

The **normalized message shape** is a single 11-field literal defined in
`lib/platforms/shared/helpers.js` (`makeMessage`):

```
id, timestamp, role, content[], usage, model, provider,
toolCallId, toolName, details, isError
```

Adapters override only the fields their raw record actually carries. Sessions
that need listing metadata (title, first/last message, counts) are produced by
each adapter's `list*` function; `withMetadataCache` in `shared/helpers.js`
wraps raw metadata parsers with an mtime-keyed in-memory cache
(`sessionMetaCache` in `lib/config.js`) so unchanged files are not re-parsed on
every list.

**Capability bits and surface projection.** `shared/contracts.js` derives
`capabilityBits` (list/find/parse/getSession/collectFiles/watchParse/needsAgent)
from function presence and adjudicates `hasResumeContract` /
`hasCreateContract` / `execSpawnCommands`. `index.js`'s `PLATFORM_SURFACES`
declares a capability predicate once per platform surface
(`export`/`otlp`/`tool-audit`); `surfacePlatforms(name)` answers for all of them,
and consumers take the subset instead of re-deriving filters.

### 4.1 File vs non-file platforms

- **File-based:** OpenClaw, Codex, Claude Code, OMP, DeepSeek Harness, Gemini.
  They implement `find`/`parse`/`collectFiles`/`watchParse`.
- **SQLite-backed:** Hermes. No files to find/collect/tail; `find`/`parse`/
  `collectFiles`/`watchParse` are `null`, and `getSession`/`list` read the
  `~/.hermes/state.db`. The watch route has a dedicated WAL-watch branch.
- **OpenClaw** is per-agent: `needsAgent: true`, `list: null` (listing is
  per-agent), and the generic routes special-case it to enumerate all agents.

### 4.2 Format specifics handled by adapters

- **dsh** (project platform `platforms/dsh/`) logs may be a concatenation of
  independent Zstandard frames (`.jsonl.zstd`). The adapter scans frame
  boundaries and decompresses each frame, tolerating a torn trailing frame after
  a crash. Versioned durable logs: a session dir keeps a legacy
  `session.jsonl[.zstd]` (format 0) next to `session.v3/.v4.jsonl.zstd`; the
  adapter reads the highest version present. Requires Node ≥ 22.15 for built-in
  zstd.
- **Gemini** (project platform `platforms/gemini/`) `$rewindTo`/`$set`
  checkpoints are folded so rewound history never renders twice
  (`foldGeminiRecords`); metadata lines and folds carry no new messages to the
  watcher.
- **Claude Code** reads `~/.claude/projects/<project-slug>/*.jsonl` plus
  `subagents/agent-*.jsonl`; a `.meta.json` beside a subagent carries
  `agentType`/`description`.

### 4.3 Custom platform adapters

`lib/platforms/loader.js` synchronously loads project- and user-source `*.js`
(in alphabetical order) at module-load time and merges validated adapters into
the catalog. Validation (shared by the CLI `platform validate`): the module must
export an object with `id` (`^[a-z0-9][a-z0-9-]*$`), `label` (string), and the
required functions `defaultDir`, `getSession` (`list`/`parse` may be `null`). A
single failing file is isolated by try/catch and marked **broken**, never
breaking startup.

A thin adapter may reuse a built-in implementation through the
`AGENTLRAY_PKG_ROOT` package root (e.g. `co-mind` reuses `builtin/claude-code`,
the same "thin adapter + package-root resolution" shape as the project-level
dsh/gemini/hermes). The `@agentlray/shared` bare-name alias is registered globally
by `shared-alias.js`, so both the server and `platform validate` resolve it.

`listPlatformInfo()` is the single source for both `GET /api/platforms` and the
CLI `platform list`: it walks the catalog (including disabled) and computes
`mounted`/`configuredMounted`/`restartRequired`,
`origin`/`builtin`/`overrides`/`replacementPending` and capability bits per
entry; broken entries are appended at the end.

## 5. Session status model

`lib/status.js` implements a unified four-state model derived from **record
evidence only** — it never queries live processes (a deliberate difference from
the csm reference; see [design/session-status-design.zh-CN.md](design/session-status-design.zh-CN.md)).

**Four states (in group order):**

| Status | Meaning |
|---|---|
| `awaiting-input` | The agent is waiting for the user (the only state that does not move without the user). |
| `working` | Evidence of active work + freshness (record-derived, not process). |
| `waiting` | Not explicitly closed, still within the forensic closing window. |
| `stopped` | Explicit end marker, or past the forensic closing window. |

**Evidence tail** (platform-neutral, from
`lib/platforms/shared/tail-state.js` `finishTail`): `lastAssistantAt`,
`lastPromptAt`, `endTurnAt`, `endedAt`, `pendingToolAt`, `pendingNewestAt`,
`oldestPendingToolName`. Critical semantics: `endedAt` comes only from a
*session-level* close marker; `endTurnAt` only from a *turn-level* end — feeding
a turn end into `endedAt` would misclassify every normally finished active
session as stopped.

**`deriveStatus(tail, meta, nowMs, opts)` decision chain** (in `lib/status.js`):

1. Explicit close → `stopped` (a session-level end marker wins over any later
   evidence).
2. No message evidence → fall back to `mtime` freshness: recent → `waiting`,
   else `stopped` (covers a just-started/empty file).
3. A **pending** tool call (the only `awaiting-input` producer, checked before
   any aging): an *immediate-await* tool (`AskUserQuestion`) → `awaiting-input`
   right away; newest pending within `activeWorkCeilMs` → `working`; a
   user-await tool (`ask`) past the work ceiling → `awaiting-input` (not bound
   by the closing ceiling — the user may reply much later); oldest pending
   within `historyCeilMs` → `awaiting-input`; else `stopped` (a crash/interrupt
   with no end marker is not pinned forever).
4. Turn end with no newer prompt → `waiting` within `historyCeilMs`, else
   `stopped`.
5–6. Otherwise the turn is still advancing: within `activeWorkCeilMs` →
   `working`.
7. Active but quiet past the work ceiling → `waiting`.
8. Past the closing window → `stopped`.

Three time windows (defaults 2 min / 30 min / 12 h) are runtime-injectable via
`setStatusConfig()` (fed from `~/.agentlray/settings.json`'s `status` section by
`lib/status-config.js`). `sortSessionsByStatusGroups` groups by state priority
then sorts each group by the platform's default key.

`GET /api/status-labels` exposes `{ order, labels }` as the single source of the
status vocabulary, so badges/group headers never drift.

## 6. Settings: a single file + hosts.json

Server-side **settings** aggregate in a single `~/.agentlray/settings.json` with
five sections: `ui`, `cliBins`, `status`, `kanban`, `llm` (plus `platforms` with
`disabled`/`replaced`). `lib/settings.js` owns the whole-file read, atomic write
(tmp + rename), and the idempotent one-time migration of the five legacy
standalone files — run from both the server and the CLI entry. Each section has a
dedicated module (`ui-settings.js`, `cli-bins.js`, `status-config.js`,
`kanban-config.js`, `lib/llm.js`, `platform-config.js`) that whitelists and
validates its keys.

A single `GET/PUT /api/settings` (`lib/routes/settings.js`) is the only web entry
point. GET returns everything (`llm` key is never echoed — only `hasApiKey`); PUT
saves only the sections supplied. `cliBins` returns `bin`/`configured`/`default`
reflecting the actually-effective command; `status`/`kanban` return
`value`/`configured`/`default`. `GET /api/ui-selection` returns the per-host
selection state.

**Multi-host and dsh config** live in a separate `~/.agentlray/hosts.json`
(0600): `{ hosts: [], dsh?: { role, serverUrl, deviceName, allowedPorts }, updatedAt }`.
Read/write goes through the `lib/hosts-file.js` shared layer (used by `hosts.js`
and `dsh/settings.js`) to avoid a circular dependency. Sensitive values (SSH
private-key content, dsh password) are encrypted by `lib/secret.js` (AES-256-GCM,
key `~/.agentlray/secret` 0600) into `xxxEnc` ciphertext; login state is carried
by a token, and account passwords are not persisted.

## 7. LLM abstraction

`lib/llm.js` `runLlm()` is the single backend for every LLM-backed feature
(prompt rewrites, cluster suggestions). Backend priority:

1. An explicit OpenAI-compatible endpoint from the `llm` section
   (`baseUrl` + `model` required, `apiKey` optional for local servers).
2. A `claude` CLI on PATH (the original behavior).

With neither, `runLlm` throws `err.code = 'NO_LLM_BACKEND'` whose message
carries setup guidance; routes surface it instead of a grey button.

**Dual transport for the OpenAI path** (the fix for slow MaaS gateways):
`proxyRequiredFor(url)` decides whether a host must use the environment proxy
(a conservative subset of Node env-proxy semantics; boundaries lean toward
proxy). External endpoints go through `runOpenAiViaFetch` (Node's env-proxy via
the default fetch dispatcher); direct/intranet/local endpoints go through
`runOpenAiDirect` (node `http(s)` with its own wall-clock timeout) so undici's
hidden 5-minute `headersTimeout` can no longer kill a genuinely slow generative
response into a bare "fetch failed". The per-request analysis timeout defaults
to 15 min, clamped to `[2s, 1h]`, configurable via `llm.analysisTimeoutMs`.
Error codes: `NO_LLM_BACKEND` / `LLM_TIMEOUT` / `LLM_NETWORK`.
`lib/llm-json.js` parses/repairs the LLM's JSON (fences, brackets, quotes).

## 8. Session resume and create

`lib/resume.js` is the single source for the resume command string — both the
CLI `sessions resume` and the web "copy resume command" button produce the exact
command the terminal would spawn. `lib/new.js` is its symmetric counterpart for
the create command.

**Native resume contracts** (`shared/contracts.js` `hasResumeContract`):

| Platform | Args |
|---|---|
| codex | `resume <id> --yolo` |
| claude-code | `--dangerously-skip-permissions --resume <id>` |
| omp | `--auto-approve --resume=<id>` |
| gemini | `-r <id> --approval-mode=yolo` |
| hermes | `--resume <id> --yolo` |

It is true for these five built-ins (dsh and openclaw declare no `resume`; dsh is an
interactive TUI and supports neither resume nor create), or for a custom adapter declaring a complete
`resume: { bin, args(id, opts) }`; create works the same way
(`hasCreateContract` / `create`). `buildResumeCommand` resolves the executable via
`resolveCliBin()` (env var `AGENTLRAY_<PLATFORM_ID>_BIN` →
`~/.agentlray/settings.json` `cliBins` section → default command name), and quotes
tokens per-shell (PowerShell `Set-Location` + `&` on win32; `cd 'cwd' &&` on
POSIX). OMP resume additionally detects a live holder process (`/proc` scan) and
terminates it (SIGTERM → SIGKILL fallback) before re-spawning, degrading to a
direct resume when it cannot detect/terminate it.

## 9. Session listing: CLI and API share one data layer

`lib/session-list.js` is the shared data layer used by both `bin/sessions.js
list` and the aggregate `GET /api/sessions`. `parsePlatformSelection` resolves a
single id, comma-separated ids, or `all`. `filterAndPage` applies `status` /
`match` (id/title/firstUserMessage/lastMessage) / `since`/`until`
(lastActivity, falling back to timestamp) filters plus `offset`/`limit`
pagination. `listPlatformSessions` handles one platform (openclaw by agent);
`listOpenclawSessionsFlat` enumerates all agents (`readAgents` → per-agent →
skip missing dirs) and flattens them, tagging each session with its source
`agent` — this powers the openclaw default "all agents" listing in both the web
board and the CLI. `listSessionsBySelection` returns the unified
`{ all, platformIds, total, offset, limit, platforms:[{platform, agent, ...}] }`
shape.

## 10. HTTP API

`server.js` mounts route modules; **the multi-host gateway `lib/routes/proxy.js`
must be the first `/api` handler**, before any body parser (remote forwarding
needs the raw body stream). It routes by `X-Host-Id` (or `?host=`, for SSE):
default/`local` → `next()` into the local routes; remote → forward to the tunnel
`baseUrl`, preserving the original `Host`/`Origin` for the remote's CSRF check.
Business logic lives in `lib/`. The `/api` guard (`lib/auth.js`) runs **before**
the gateway: **local** requests (target `local`, or the local resources
`/api/{hosts,inbound,dsh,mode}`) require the local token, remote targets pass
through (link authentication); see §16. A CSRF guard (`lib/csrf.js`) rejects
cross-site state-changing requests before the body is parsed. All responses set
`Cache-Control: no-store`. A 256 KB JSON body limit applies.

| Method & path | Purpose |
|---|---|
| `GET /api/version` | `{ bootId, version }` — frontend staleness + cross-host version hint. |
| `GET /api/status-labels` | Unified status vocabulary `{ order, labels }`. |
| `GET /api/sessions` | Aggregate multi-platform list (see §9). |
| `GET /api/agents` · `GET /api/agents/:name/sessions[/:id]` | OpenClaw agent/session listing. |
| `GET /api/spawn-map` · `GET /api/spawn-tree[/:sessionId]` | Agent spawn relationship map / tree. |
| `GET /api/:platform/sessions` · `/…/:sessionId` | Registry-driven generic list / detail. |
| `GET /api/:platform/sessions/:id/resume-command` · `POST …/new` | Resume command string / new session (§8). |
| `GET /api/:platform/sessions/:id/children[/:name]` | Sub-agents (omp / claude-code etc.). |
| `GET /api/settings` · `PUT /api/settings` · `GET /api/ui-selection` | Unified settings / per-host selection (§6). |
| `GET /api/settings/cli-bins` | Read-only compat endpoint (`bin`/`configured`/`default`). |
| `GET /api/platforms` · `PUT|DELETE /api/platforms/:id/mount` · `PUT|DELETE /api/platforms/:id/replace` | Platform list / enable-disable / replace declaration (§4). |
| `GET /api/insights` · `GET /api/tools/audit` | Aggregate analytics / cross-platform tool health. |
| `GET /api/prompts` · `/analyze` · `POST /api/prompts/rewrite` · `/hidden…` | Prompt extraction/clustering/rewrite/hide. |
| `GET /api/search` | Full-text multi-keyword AND search across all platforms. |
| `GET /api/:platform/sessions/:id/export` · `GET /api/otlp/:platform/:sessionId` | Markdown/HTML export / OTLP trace. |
| `GET /api/watch` | SSE real-time tail + status push. |
| `GET/POST/PUT/DELETE /api/hosts…` · `POST /api/hosts/:id/connect|disconnect` · `POST /api/hosts/:id/test` | Multi-host CRUD / connect / probe (local resource). |
| `GET /api/inbound` · `POST /api/inbound/hello` | Inbound peer overview / heartbeat (local resource). |
| `GET/PUT /api/dsh/config` · `GET /api/dsh/status|devices` · `GET /api/dsh/auth/providers` · `POST /api/dsh/auth/qr/start|qr/poll|logout` · `POST /api/dsh/test` | dsh transport config / login (QR + account password) / probe (local resource). |

`/api/hosts`, `/api/inbound`, `/api/dsh` are **local gateway resources**: the
gateway returns 403 for them and never re-forwards to the currently viewed
remote. A full annotated endpoint table (including parameters and per-platform
dir overrides) lives in [usage.md](usage.md#api).

### 10.1 Multi-host and remote connections

- **Host model** (`lib/hosts.js`): `local` is built in (direct connection to this
  process's port; not persisted, no tunnel); the rest persist in `hosts.json`
  with a runtime state machine
  `connecting`/`connected`/`reconnecting`/`failed`/`disconnected` (`status` keeps
  the legacy aliases so older consumers keep working). Failures carry a stable
  `errorCode` (`HOST_OFFLINE`, `DSH_AUTH_REQUIRED`, `KEY_CHANGED`,
  `VERSION_INCOMPATIBLE`, `TUNNEL_TIMEOUT`, `TUNNEL_REFUSED`, `UNREACHABLE`,
  `INVALID_TARGET`, `AUTH_REQUIRED`) plus `retryable`. The tunnel lifecycle is
  bound to the currently selected host: switching away closes it, deleting closes
  and removes it, and process exit kills all ssh children (no orphans).
- **Health probe** (`AGENTLRAY_HOST_PROBE_MS`, default 15 s; single-attempt
  timeout 3 s): `GET <baseUrl>/api/version`. Two consecutive failures mark the
  link lost → `reconnecting`. The timer is `unref`'d and cleared on close.
- **Reconnect backoff** (`AGENTLRAY_HOST_BACKOFF_MS`): 1→2→4→8→15→30→60 s with
  ±20 % jitter, retrying indefinitely; a manual `openHost` cancels the pending
  backoff and resets it, while non-retryable errors go straight to `failed`
  without looping.
- **ssh transport** (`lib/transport.js`): spawn the system `ssh -L` for local
  port forwarding, keeping the remote AgentLRay bound to `127.0.0.1` (the
  security boundary is the system ssh layer; zero stored credentials — keys/
  fingerprints go through `~/.ssh/config`, `ssh-agent`, `known_hosts`). The
  executable name is overridable via `AGENTLRAY_SSH_BIN`.
- **dsh transport** (`lib/dsh/`): `host.js` is the resident *connected-side*
  service (relay server + loopback forwarding; independent of the selected host,
  not occupying a connection slot); `client.js` is the *connecting side*
  (ds-harness-remote encrypted channel + loopback port forwarding to this
  process). Roles are `host`/`client`/`both`. Login supports QR and account
  password (`auth.js`); the token is carried by a `ServerCredentialStore`.
- **Inbound peers** (`lib/inbound.js`): the connected side records "who is
  connecting to me"; the connecting side reports/heartbeats via
  `POST /api/inbound/hello` (TTL 30 s). dsh connections merge into the same
  registry with `via='dsh'`.

## 11. Build pipeline

`npm run build:ui` runs two steps:

1. `scripts/build-diagnostics.mjs` — bundles
   `frontend/src/views/sessions/diagnostics.ts` with esbuild (bundle + minify +
   CJS) into `lib/generated/diagnostics.cjs`, appending
   `module.exports.rulesSha256` (a hash of the TS source). `--check` detects
   drift. `lib/inspect.js` `require`s this artifact, so CLI and UI apply the
   same diagnostic rules (§12).
2. `cd frontend && npm run build` — `tsc -b && vite build` → `frontend/dist`.

At runtime, `server.js` serves the built React UI at `/` only when
`frontend/dist/index.html` exists; without a build, unknown paths return a 503
telling you to run `npm run build:ui`. **There is no second legacy UI** — React
is the only feature surface. `npm run build:demo` builds with `VITE_DEMO=1`, so
`src/demo/` serves synthetic fixtures without real requests (for the GitHub
Pages demo).

## 12. Diagnostics and evidence

`frontend/src/views/sessions/diagnostics.ts` is the **single rule source**. It
exports four analyzers:

- `diagnoseSession` → failure events (`events`): aggregates unresolved failures
  by `userTurn + tool + complete args`, groups repeated operations first,
  splits groups on an exact-match later success, and reports recovery.
- `summarizeSessionHealth` → health counts (`summary`): call/result states,
  orphan/unassigned/ambiguous calls, `gaps` (call-result gaps:
  running/unknown/no-result), failure/pending/recovered/repeated/candidate
  counts.
- `analyzeCodexProcesses` → `processes`: connects `exec_command` process IDs to
  later `write_stdin` results with launch/poll/exit evidence and ambiguity codes
  (`ambiguous-launch`/`reused-process-id`/`overlapping-polls`/…).
- `analyzeVerificationChronology` → `chronology`: distinguishes checks before an
  edit, overlapping it, and later outcomes; latest-order ambiguity is kept
  unknown.

The offline CLI (`lib/inspect.js` + `bin/inspect.js`) reads exactly one stable
JSONL file (≤ 64 MiB, platforms omp/codex/claude-code), normalizes it, applies
the same four analyzers via the generated bundle, and produces a versioned
report (`schemaVersion: 1`) with `complete`, `engine{rulesSha256, adapterSha256}`,
`source{platform, bytes, sha256}`, `coverage`, `summary`, `events`, `gaps`,
`processes`, `chronology`, `limits`. References are `{ line, messageIndex }`
(one-based physical JSONL line). The layered CLI adds `inspect --summary --json`
(sampled references, `REFERENCE_LIMIT=5`) and an explicit `evidence` command
that returns raw source bytes with hash/line validation and UTF-8 byte paging
(`MAX_EVIDENCE_BYTES=16384`). Exit codes: 0 = report produced (not task
success), 1 = input/coverage/runtime error, 2 = `--fail-on pending-failures`
found unmatched pending failures. See [offline-inspect.md](offline-inspect.md).

The local review queue is **front-end only** (`diagnostic-reviews.ts`), stored
in `localStorage` under `axr-diagnostic-review-v1:*`, with an evidence
fingerprint so changed evidence invalidates stale reviews; a transfer panel
exports/imports them (exact-match only, no overwrite).

## 13. Frontend architecture

**Entry & state.** `frontend/index.html → src/main.tsx` mounts a React 19 SPA
(`ReactDOM.createRoot` + `StrictMode` + `QueryClientProvider` + sonner
`<Toaster>`). There is **no react-router**: view/detail routing uses URL query
parameters plus a single global zustand store (`src/store.ts`, `useAppStore`).
Server data flows through `@tanstack/react-query` (query-key contracts + SSE
cache merge + 5 s polling). `src/api/client.ts` is the typed fetcher layer
(`fetchJson`/`requestJson` throw `Error(body.error)` on non-2xx; `withParams`
filters empty params; in DEMO mode calls route through `demoJson` fixtures) and
injects `X-Host-Id` uniformly (the store calls `setActiveHostId` on host switch).

**Routing persistence.** Session detail context (`?session=&sid=&agent=`) and
the right-pane view tab (`?view=`) are written to/restored from the URL via
`replaceState`; filters/grouping persist **per host**
(`agent-lray-settings:<hostId>`, with a one-time fallback from the old single
key). The remembered host lives in `agent-lray-remembered-host`.

**Views** (four tabs in `App.tsx`): `sessions`, `insights`, `prompts`, `kanban`.

- **sessions** — the most complex. `SessionsView` renders the summary +
  messages/trace; `TraceView` (`views/trace/`) renders a Langfuse-style waterfall
  from `buildTraceTurns` (`pure.ts`), and a purple bar loads a spawned
  sub-agent's transcript (`childAgents.ts`). `useSessionSse` (EventSource
  `/api/watch`; new messages append to the same query cache and pushed status
  merges into the `['sessions',…]` list cache), `usePlatformProbe` (empty-state).
  `SessionList` is the sidebar: grouping (`platform`/`project`/`none`) +
  four-state sub-group headers, virtual scrolling (> 200 rows) with
  `@tanstack/react-virtual`, arrow-key navigation. `queries.ts` defines the query
  keys/options; `CmdkDialog` reuses the same cache via `queryClient.fetchQuery`.
  Status labels come from `/api/status-labels` (`statusMeta.ts`).
- **insights** — `GlobalInsights` (server `/api/insights`, tool stats/error
  clusters/trend + `ToolsAuditSection`) vs `SessionInsights` (client-side
  `computeSessionInsights` from the already-loaded session detail cache).
- **prompts** — extraction grouped by cwd, search, hide-trivial, batch hide,
  JSON export, `分析优化` (cluster + attribution + LLM suggestions via
  `getPromptAnalysis`) and single-prompt `优化` rewrite.
- **kanban** — reuses `useSessionsList` (same cache/5 s poll/SSE merge) and
  `buildKanbanColumns` (`kanbanLib.ts`) bucketing by the four states;
  `maxPerStatus` (default 20) truncation from `/api/settings`'s `kanban`;
  responsive stacking below 768 px.

**Multi-host UI.** `components/Sidebar.tsx` selects the host;
`HostsDialog`/`HostFormDialog`/`HostConnectingView` manage ssh/dsh hosts
(`src/lib/host-status.ts` maps status); `DshConfigDialog` (`components/dsh/`)
configures the local role and login. On host switch, the tunnel is established
via `/api/hosts/:id/connect`, with a first-frame "connect before load" gate so no
request is sent to an unconnected host.

**Shared libs.** `src/lib/pure.ts` — no-DOM pure functions (formatters, trace
builder, turn ledger); `src/lib/markdown.ts` — escape-then-transform markdown;
`src/lib/utils.ts` provides `cn()` (clsx + tailwind-merge).

**Theme & UI.** `useTheme` syncs `store.theme` (`light`/`dark`) to `<html>`'s
`.dark` class; the palette lives in `index.css` CSS variables (`:root` light /
`.dark` dark, mapped to Tailwind colors). Initial theme follows the system once,
then is fixed by manual toggle and persisted. The UI component library is
shadcn/ui-style on Radix + Tailwind under `src/components/ui/`
(button/badge/card/dialog/select/tabs/command/…).

## 14. Real-time watch (SSE)

`lib/routes/watch.js` + `lib/platforms/shared/watch.js` implement
`GET /api/watch` (EventSource; the host can only be selected via `?host=`).
`readNewLines` tails a file from a byte offset (plain JSONL advances only past
the last complete line; dsh zstd decompresses every complete new frame and
leaves a torn frame for the next read). `parseWatchLines` normalizes raw lines
through the platform's `watchParse`. `accumulateWatchTail`/`watchTail` feed the
tail-evidence state machine so the route can derive status for each push
without re-parsing the whole log. The OMP watcher additionally handles
session-level `session_exit` records (→ `noteEnded` + `resolveAllPending`, so
an `ask` interaction is closed). Hermes has a dedicated SQLite WAL-watch branch
(timestamp-incremental query).

Every push carries `id: <byteOffset>`. A reconnect passes `?after=<offset>` (or
`Last-Event-ID`) and the route resumes from that offset, so messages written
while the stream was down are delivered and existing ones are not re-sent;
`after=0` is treated like no offset (full baseline). When the file rotated or
truncated below the offset, the route falls back to a full read.

## 15. Export and OTLP

- **Export** (`lib/export.js`): renders a normalized session as shareable
  Markdown or self-contained HTML (inline CSS, no external requests). Tool calls
  render as collapsed `<details>`. A best-effort `redactSecrets` pass strips
  obvious secrets (Bearer tokens, `sk-` keys, `Authorization`/`x-api-key`
  headers, `gh_`/`xox_`/`AKIA`). `fenceFor` protects against embedded
  backtick-fence breakout.
- **OTLP** (`lib/otlp.js`): serializes a session's trace as OTLP/JSON — one
  trace per session, one `invoke_agent` root span per user turn with child
  `chat {model}` and `execute_tool {toolName}` spans, mirroring the frontend's
  `buildTraceTurns`. Deterministic sha256-derived ids. `PLATFORM_SURFACES.otlp`
  excludes openclaw (find needs agent) and hermes (no files).

## 16. Security and trust model

- **Localhost by default.** It binds to `127.0.0.1` by default (`HOST=0.0.0.0`
  opts into LAN).
- **Local token auth** (`lib/auth.js`) — decided purely by the request target:
  - Local requests (target `local`, or the local resources
    `/api/{hosts,inbound,dsh,mode}`) must carry the token: `GET /?token=<t>`
    validates it, sets a long-lived (`Max-Age=31536000`) `HttpOnly;
    SameSite=Strict` cookie and 302s to `<next|/>#token=<t>` (`next` accepts
    same-origin absolute paths only);
    `/api/*` accepts that cookie or `X-AgentLRay-Token` (sha256 +
    `timingSafeEqual`). Unknown host ids are treated as local (fail-closed).
  - Token source: `AGENTLRAY_UI_TOKEN` wins (the Android shell generates it and
    persists it in app-private storage); otherwise it is generated into
    `~/.agentlray/ui-token` (0600, reused across restarts).
    `AGENTLRAY_NO_AUTH=1` disables the guard (build scripts, test baseline).
    `GET /api/version` stays public (readiness probe).
  - Front-end cache (`frontend/src/api/ui-token.ts`): the 302 fragment
    (`#token=`) never reaches the server or its logs; the SPA validates it
    against `/api/mode` (a 401 keeps the existing cache, so a cross-origin
    `#token=` cannot shadow a working token), stores it in
    `localStorage['agentlray.uiToken']`, strips it with `replaceState`, and sends
    `X-AgentLRay-Token` on every same-origin request. SSE authenticates by cookie
    only: a 401 on the reconnect probe with a cached token present re-exchanges
    it via `/?token=<cached>&next=<path>` (`next` accepts same-origin paths
    only) instead of dropping the cache. The Android WebView calls
    `CookieManager.flush()` after navigation and on stop, and re-navigates to
    exchange when the token matches but the cookie is gone.
  - Remote targets are **not** checked against the local token: the link
    authenticates itself (ssh keys / dsh device identity) and the proxy strips
    local cookies and token headers before forwarding.
  - Inbound peers (dsh/ssh tunnels hitting `/api/*`) need **no configuration**;
    the trust anchor lives in the transport layer:
    - **Inbound socket** (`lib/inbound-socket.js`): the server also listens on
      `~/.agentlray/inbound.sock` (socket 0600, directory 0700) with the same
      app; any process that can connect is the same user, and such requests are
      marked `req.agentlrayInboundSocket` and allowed. Other users/apps (distinct
      Android UIDs) are stopped by kernel file permissions. The path is
      advertised via public `/api/version` (`inboundSocket`) and dsh
      `harness.transport.describe` (`inboundSocket`).
    - The connector tunnels to it: ssh first reads `/api/version` over a TCP
      tunnel, then switches to `ssh -L <port>:<remote socket path>` (OpenSSH
      streamlocal forwarding); dsh points its loopback target at the path. With
      no path available it falls back to TCP loopback (receiver then needs auth
      disabled or a token).
    - **dsh in-process marker** (`X-AgentLRay-Tunnel`,
      `lib/tunnel-headers.js`): injected by the loopback host before forwarding;
      never persisted, never leaves the process, so other local processes cannot
      forge it.
  - Why no HTTP-level connector proof (secret upload, challenge): with
    `ssh -L` to a TCP port the request source is 127.0.0.1, so any local process
    could replay the same bootstrap and the token would be worthless; only the
    transport (UNIX socket file permissions) can tell them apart.
- **CSRF:** the auth cookie is `SameSite=Strict`, and the guard rejects
  cross-site unsafe requests by checking `Origin`/`Sec-Fetch-Site`/`Referer`
  against the request's `Host` (origin-relative, so LAN deployments on any
  hostname keep working). The gateway preserves the original `Host`/`Origin`, so
  both ends validate consistently.
- **Path sanitization:** `resolveDir` accepts only absolute, `..`-free
  overrides; `sanitizeAgentName`/`sanitizeSessionId` whitelist characters.
- **Credential encryption:** SSH private-key content and dsh passwords are
  encrypted by `lib/secret.js` (AES-256-GCM; key `~/.agentlray/secret` 0600) into
  `xxxEnc`; `hosts.json`/`secret` are 0600. GET endpoints never return plaintext
  keys/passwords.
- **Custom platforms are code you trust.** An adapter executes with your full
  user permissions; only place trusted files (`AGENTLRAY_NO_PLUGINS=1` as the
  escape hatch). This is the accepted tradeoff recorded in
  [design/adr-0001-custom-platform-adapter.zh-CN.md](design/adr-0001-custom-platform-adapter.zh-CN.md).
- **Exports/evidence are shared artifacts.** `redactSecrets` is best-effort;
  the `evidence` command explicitly returns raw source content. Neither is a
  sanitizer, authorization or proof of authenticity.
- **Remote connections are an explicit egress.** There is no remote by default;
  ssh/dsh channels are established only after you configure a host and connect.
  The logs themselves are never uploaded to a model.

## 17. Testing

Tests use Node's built-in runner (`npm test` = `node --require
./test/setup-env.cjs --test test/*.test.js`, no extra dependencies; currently 57
`*.test.js` files). `test/setup-env.cjs` injects an empty user-platform directory
and registers the `@agentlray/shared` alias, but does **not** change
`HOME`/`AGENTLRAY_HOME` — each test builds its own isolated home (a throwaway copy
of `test/fixtures/home`), so real logs are never touched. Coverage spans the
registry/loader, every platform adapter, status, settings/secret, multi-host
(hosts/transport/proxy/inbound/dsh), diagnostic rules and the generated bundle,
the CLI, and Windows compatibility.

The repository's `.github/workflows/pages.yml` only builds the GitHub Pages demo
on push to master (`build-demo-fixtures` + `VITE_DEMO=1`); it does **not** run
tests. Tests run locally/CI via `npm test`. Diagnostic rules are cross-checked
between the TS source and the generated CJS bundle so CLI and UI agree.

## 18. Key architecture decisions (summary)

| Decision | Rationale |
|---|---|
| Three-source platform registry single source | One adapter + declaration adds/overrides a platform; every generic surface resolves through it. |
| Runtime custom adapters | Extend without forking the source; trusted-code tradeoff (ADR-0001). |
| Synchronous custom-platform load | Derivation points read `PLATFORMS` at `require` time. |
| Unified 4-state status from record evidence | No process queries; consistent across list + watch + CLI. |
| Single `settings.json` + one `/api/settings` | One migration, one web entry; per-section whitelists. |
| `hosts.json` holds hosts/dsh separately | Sensitive credentials and connection targets isolated in a permission-controlled file; settings vs host surfaces decoupled. |
| Single `lib/resume.js` / `lib/new.js` | CLI and web produce identical commands. |
| `diagnostics.ts` bundled to CJS | CLI and UI apply identical rules. |
| Front-mounted multi-host gateway | Remote forwarding needs the raw body; data plane is fully forwarded, local resources 403. |
| CSRF via Origin/Host comparison | Works without cookies/auth; survives LAN hostnames. |
