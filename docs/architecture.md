# AgentLRay Architecture

> This document describes the actual, current implementation (derived from the
> repository at `9755ec0`). It complements the feature/theme docs in this
> directory: [usage](usage.md), [execution evidence](diagnostics.md),
> [offline inspect](offline-inspect.md) and [single-session forensics](session-forensics.md).
> A Chinese translation lives in [architecture.zh-CN.md](architecture.zh-CN.md).

AgentLRay is a local web dashboard for inspecting the execution evidence your
coding agents already record. It reads the native session logs of OpenClaw,
Codex, Claude Code, Hermes, OMP, DeepSeek Harness and Gemini CLI, normalizes
them into one message model, and renders a unified browser. Everything runs on
your machine against your own log files; the core inspection paths make no
model calls and upload nothing.

## 1. Design goals

- **Local execution evidence first.** The product is about what *actually ran*
  and which results support a conclusion — automatic facts before human labels.
  Diagnostics deliberately *do not* decide whether a task succeeded.
- **Read-only over a normalized model.** Every platform resolves to one
  `{ session, messages }` payload; all generic surfaces (routes, search, watch,
  insights, prompts, tool audit, export, OTLP, CLI) are written once against
  that model.
- **Platform registry as single source of truth.** Adding a platform is one
  adapter file plus one registration; nothing else changes. Custom platforms
  plug in at runtime without touching the source.
- **Frontend logic authored once, shared everywhere.** `pure.ts` and
  `markdown.ts` are the single source for formatters/trace builder/markdown;
  they are baked into the frozen legacy UI and reused by the Node test runner.
- **Diagnostics rules authored once.** `diagnostics.ts` is the single rule
  source; it is bundled into `lib/generated/diagnostics.cjs` so the offline CLI
  and the React UI apply exactly the same judgement.

## 2. High-level layering

```
                 ┌────────────────────────────────────────────┐
                 │  React 19 SPA (frontend/)   ── default UI  │
                 │  zustand store + react-query + SSE cache   │
                 └───────────────┬────────────────────────────┘
                                 │ HTTP (fetch) + SSE (EventSource)
                 ┌───────────────▼────────────────────────────┐
                 │  Express backend (server.js + lib/routes/*) │
                 │  CSRF guard · JSON · no-store              │
                 └───────┬──────────────────────┬─────────────┘
                         │                      │
              ┌──────────▼──────────┐   ┌───────▼──────────────┐
              │  lib/* business     │   │  lib/platforms/*     │
              │  status · settings  │   │  registry + adapters │
              │  llm · resume ·     │   │  codex/claude/omp/   │
              │  search · inspect   │   │  dsh/gemini/hermes/  │
              │  export · otlp ·    │   │  openclaw · loader   │
              │  backup · insights  │   │  tail-state · shared │
              └──────────┬──────────┘   └──────────┬──────────┘
                         │                         │
              ┌──────────▼─────────────────────────▼──────────┐
              │  Platform session logs on disk (JSONL/SQLite/ │
              │  zstd JSONL) + ~/.agentlray/* config & archive│
              └───────────────────────────────────────────────┘
```

## 3. Repository layout

| Path | Role |
|---|---|
| `server.js` | Express bootstrap: static serving, CSRF, no-store, route mounting, settings migration + status injection, listen. |
| `bin/` | CLI entry points: `agentlray.js` (dispatch), `sessions.js` (list/show/resume), `inspect.js` (inspect/evidence), `platform.js` (list/validate). |
| `lib/config.js` | HOME resolution, platform default directories, session-id/agent sanitizers, the shared metadata cache map, file helpers. |
| `lib/platforms/` | The platform registry and one adapter per platform; `shared.js` (skeleton helpers), `tail-state.js` (tail evidence state machine), `loader.js` (custom adapter loader). |
| `lib/` | Platform-independent business: `status.js`, `session-list.js`, `settings.js` + section modules, `llm.js`/`llm-json.js`, `resume.js`, `cli-bins.js`, `ui-settings.js`, `search.js`, `inspect.js`/`inspect-detail.js`, `export.js`, `otlp.js`, `backup.js`, `insights.js`, `tool-audit.js`, `prompts.js`, `library.js`, `watch.js`, `csrf.js`. |
| `lib/routes/` | Route modules: parameter validation + response shaping only; business logic lives in `lib/`. |
| `lib/generated/diagnostics.cjs` | Bundled diagnostic rules (generated; do not hand-edit). |
| `frontend/` | React 19 + Vite + TypeScript SPA (the only feature surface). |
| `public/` | The frozen legacy vanilla UI, served at `/legacy`; security fixes only. |
| `scripts/` | Build/`demo` pipelines (see §11). |
| `test/` | Node's built-in test runner, isolated against `test/fixtures/home`. |

## 4. Platform registry and the normalized model

`lib/platforms/index.js` holds the `PLATFORMS` table — the single source of
platform truth. Every generic surface resolves a platform through this table.

**Registry entry shape:**

| Field | Meaning |
|---|---|
| `id` | Registry key, used in URLs (`/api/<id>/sessions`) and CLI `--platform`. |
| `label` | Human-readable name (boot log, UI). |
| `defaultDir()` | Platform's session root (env-overridable via `lib/config`). |
| `list(dir)` | Session summaries, newest first. |
| `find(dir, id, opts?)` | Session file path \| `null` (`null` entry: not file-based, e.g. Hermes). |
| `parse(file)` | `{ session, messages }` (normalized). |
| `getSession(dir, id, opts?)` | `{ session, messages } \| null`. |
| `collectFiles(dir, opts?)` | `[{ path, file, sessionId, agent? }]` for bulk scans (search/prompts/tool-audit). |
| `watchParse(rec, line?)` | `{ messages?, session? } \| null` for the SSE tail. |
| `needsAgent` | True when `find`/`getSession` require `opts.agent` (openclaw). |

The **normalized message shape** is a single 11-field literal defined in
`lib/platforms/shared.js` (`makeMessage`):

```
id, timestamp, role, content[], usage, model, provider,
toolCallId, toolName, details, isError
```

Adapters override only the fields their raw record actually carries. Sessions
that need listing metadata (title, first/last message, counts) are produced by
each adapter's `list*` function; `withMetadataCache` in `shared.js` wraps raw
metadata parsers with an mtime-keyed in-memory cache (`sessionMetaCache` in
`lib/config.js`) so unchanged files are not re-parsed on every list.

### 4.1 File vs non-file platforms

- **File-based:** OpenClaw, Codex, Claude Code, OMP, DeepSeek Harness, Gemini.
  They implement `find`/`parse`/`collectFiles`/`watchParse`.
- **SQLite-backed:** Hermes. No files to find/collect/tail; `find`/`parse`/
  `collectFiles`/`watchParse` are `null`, and `getSession`/`list` read the
  `~/.hermes/state.db`. The watch route has a dedicated WAL-watch branch.
- **OpenClaw** is per-agent: `needsAgent: true`, `list: null` (listing is
  per-agent), and the generic routes special-case it to enumerate all agents.

### 4.2 Format specifics handled by adapters

- **dsh** logs may be a concatenation of independent Zstandard frames
  (`.jsonl.zstd`). `lib/platforms/dsh.js` scans frame boundaries and
  decompresses each frame, tolerating a torn trailing frame after a crash.
  Versioned durable logs: a session dir keeps a legacy `session.jsonl[.zstd]`
  (format 0) next to `session.v3/.v4.jsonl.zstd`; the adapter reads the highest
  version present. Requires Node ≥ 22.15 for built-in zstd.
- **Gemini** `$rewindTo`/`$set` checkpoints are folded so rewound history never
  renders twice (`foldGeminiRecords`); metadata lines and folds carry no new
  messages to the watcher.
- **Claude Code** reads `~/.claude/projects/<project-slug>/*.jsonl` plus
  `subagents/agent-*.jsonl`; a `.meta.json` beside a subagent carries
  `agentType`/`description`.

### 4.3 Custom platform adapters

`lib/platforms/loader.js` synchronously reads `~/.agentlray/platforms/*.js` (in
alphabetical order) at module-load time and merges validated adapters into the
registry. The synchronous design is a hard requirement: downstream derivation
points (`lib/export.js`, `lib/otlp.js`, `lib/session-list.js`, routes, CLI)
read `PLATFORMS` at `require` time, so any async load would hide custom
platforms from them.

Validation (shared by the CLI `platform validate`): the module must export an
object with `id` (`^[a-z0-9][a-z0-9-]*$`), `label` (string), and the required
functions `defaultDir`, `parse`, `getSession` (`list` may be `null`, like
OpenClaw). An id colliding with a built-in or earlier custom adapter marks the
file **broken** (never overrides). A single failing file is isolated by
try/catch and never breaks startup. `AGENTLRAY_NO_PLUGINS=1` skips loading
entirely. Capability bits are derived from function presence
(`lib/platforms/index.js` `capabilityBits`).

`listPlatformInfo()` is the single source for both `GET /api/platforms` and the
CLI `platform list`: built-ins (registry insertion order) → custom (alphabetical
file load order) → broken (alphabetical), each with `capabilities` and
`resume` flags.

## 5. Session status model

`lib/status.js` implements a unified four-state model derived from **record
evidence only** — it never queries live processes (a deliberate difference from
the csm reference; see `docs/.local/session-status-design.zh-CN.md`).

**Four states (in group order):**

| Status | Meaning |
|---|---|
| `awaiting-input` | The agent is waiting for the user (the only state that does not move without the user). |
| `working` | Evidence of active work + freshness (record-derived, not process). |
| `waiting` | Not explicitly closed, still within the forensic closing window. |
| `stopped` | Explicit end marker, or past the forensic closing window. |

**Evidence tail** (platform-neutral, from `lib/platforms/tail-state.js`
`finishTail`): `lastAssistantAt`, `lastPromptAt`, `endTurnAt`, `endedAt`,
`pendingToolAt`, `pendingNewestAt`, `oldestPendingToolName`. Critical semantics:
`endedAt` comes only from a *session-level* close marker; `endTurnAt` only from
a *turn-level* end — feeding a turn end into `endedAt` would misclassify every
normally finished active session as stopped.

**`deriveStatus(tail, meta, nowMs, opts)` decision chain** (in
`lib/status.js`):

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
status vocabulary for both React and legacy frontends, so badges/group headers
never drift.

## 6. Settings, unified single file

All server-side settings aggregate in a single `~/.agentlray/settings.json`
with five sections: `ui`, `cliBins`, `status`, `kanban`, `llm`. `lib/settings.js`
owns the whole-file read, atomic write (tmp + rename), and the idempotent
one-time migration of the five legacy standalone files
(`ui-settings.json`/`cli-bins.json`/`status-config.json`/`kanban-config.json`/
`llm.json`) — run from both the server and the CLI entry so pure-CLI upgrades
also pick up old config. Each section has a dedicated module
(`ui-settings.js`, `cli-bins.js`, `status-config.js`, `kanban-config.js`,
`lib/llm.js`) that whitelists and validates its keys.

A single `GET/PUT /api/settings` (`lib/routes/settings.js`) is the only web
entry point. GET returns everything (`llm` key is never echoed — only
`hasApiKey`); PUT saves only the sections supplied. `cliBins` returns
`bin`/`configured`/`default` reflecting the actually-effective command;
`status`/`kanban` return `value`/`configured`/`default`.

## 7. LLM abstraction

`lib/llm.js` `runLlm()` is the single backend for every LLM-backed feature
(prompt rewrites, template-cluster suggestions, library name suggestions).
Backend priority:

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

## 8. Session resume

`lib/resume.js` is the single source for the resume command string — both the
CLI `sessions resume` and the web "copy resume command" button produce the
exact command the terminal would spawn.

**Native resume contracts** (`RESUME_BINS`):

| Platform | Args |
|---|---|
| codex | `resume <id> --yolo` |
| claude-code | `--dangerously-skip-permissions --resume <id>` |
| omp | `--auto-approve --resume=<id>` |
| dsh | `--profile pi-tui --preset standard --resume <id>` (interactive TUI; `--session-id` does not recognize web-created sessions) |
| gemini | `-r <id> --approval-mode=yolo` |
| hermes | `--resume <id> --yolo` |

`hasResumeContract(platform)` is true for these six, or for a custom adapter
declaring a complete `resume: { bin, args(id, opts) }`. `buildResumeCommand`
resolves the executable via `resolveCliBin()` (env var
`AGENTLRAY_<PLATFORM_ID>_BIN` → `~/.agentlray/settings.json` `cliBins` section →
default command name), and quotes tokens per-shell (PowerShell `Set-Location`
+ `&` on win32; `cd 'cwd' &&` on POSIX). OMP resume additionally detects a live
holder process (`/proc` scan) and terminates it (SIGTERM → SIGKILL fallback)
before re-spawning.

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

`server.js` mounts route modules; business logic lives in `lib/`. A CSRF guard
(`lib/csrf.js`) rejects cross-site state-changing requests before the body is
parsed (browsers always attach `Origin`/`Sec-Fetch-Site`; the boundary is
same-origin or a non-browser client with no `Origin`). All responses set
`Cache-Control: no-store`. A 256 KB JSON body limit applies.

| Method & path | Purpose |
|---|---|
| `GET /api/version` | `{ bootId }` — frontend staleness detection (polled; prompts reload on change). |
| `GET /api/status-labels` | Unified status vocabulary `{ order, labels }`. |
| `GET /api/sessions` | Aggregate multi-platform list (see §9). |
| `GET /api/agents` · `GET /api/agents/:name/sessions[/:id]` | OpenClaw agent/session listing (legacy-compatible). |
| `GET /api/spawn-map` · `GET /api/spawn-tree[/:sessionId]` | Agent spawn relationship map / tree. |
| `GET /api/:platform/sessions` · `/…/:sessionId` | Registry-driven generic list / detail. |
| `GET /api/:platform/sessions/:id/resume-command` | Resume command string (single source §8). |
| `GET /api/omp/sessions/:id/children[/:name]` | OMP sub-agents. |
| `GET /api/claude-code/sessions/:id/children[/:name]` | Claude Code sub-agents. |
| `GET /api/settings` · `PUT /api/settings` | Unified settings (§6). |
| `GET /api/settings/cli-bins` | Read-only compat endpoint for the frozen legacy UI. |
| `GET /api/platforms` | Platform list incl. custom + broken (§4.3). |
| `GET /api/insights` | Aggregate analytics (tools, error clusters, trends). |
| `GET /api/tools/audit` | Cross-platform tool health. |
| `GET /api/prompts` · `/analyze` · `POST /api/prompts/rewrite` · `/hidden…` | Prompt extraction/clustering/rewrite/hide. |
| `GET /api/library` … `POST /api/library/:name/install` etc. | Prompt library + install as slash commands. |
| `GET /api/search` | Full-text multi-keyword AND search across all platforms. |
| `GET /api/:platform/sessions/:id/export` | Markdown/HTML export (`format=md\|html`). |
| `GET /api/:platform/sessions/:id/otlp` | OTLP/JSON trace export. |
| `GET /api/watch` | SSE real-time tail + status push. |
| `POST /api/backup` · `GET /api/backup/status` | Incremental backup. |
| `GET /api/agents/…` | see above. |

A full annotated endpoint table (including parameters and per-platform dir
overrides) lives in [usage.md](usage.md#api).

## 11. Build pipeline and dual frontend

`npm run build:ui` runs three steps:

1. `scripts/build-diagnostics.mjs` — bundles
   `frontend/src/views/sessions/diagnostics.ts` with esbuild (bundle + minify +
   CJS) into `lib/generated/diagnostics.cjs`, appending
   `module.exports.rulesSha256` (a hash of the TS source). `--check` detects
   drift. `lib/inspect.js` `require`s this artifact, so CLI and UI apply the
   same diagnostic rules (§12).
2. `scripts/build-legacy-pure.mjs` — bundles `frontend/src/lib/legacy-pure.ts`
   (which re-exports `pure.ts` + `markdown.ts`) with esbuild into
   `public/js/pure.js` as an IIFE (`__axrPure`): browser globals on
   `window.*`, Node `module.exports`. This is how the frozen legacy UI shares
   the React frontend's single-source formatters/markdown/trace builder.
3. `cd frontend && npm run build` — `tsc -b && vite build` → `frontend/dist`.

At runtime, `server.js` serves the built React UI at `/` when
`frontend/dist/index.html` exists, and the legacy vanilla UI at `/legacy`
(a frozen snapshot: security fixes only). Without a build the legacy UI is the
fallback at `/`. React is the only feature surface.

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
filters empty params; in DEMO mode calls route through `demoJson` fixtures).

**Routing persistence.** Session detail context (`?session=&sid=&agent=`) and
the right-pane view tab (`?view=`) are written to/restored from the URL via
`replaceState` (`syncSessionUrl`/`parseDetailFromUrl`/`parseViewFromUrl`);
filters/grouping persist in `localStorage`. Both React and legacy UI share the
same `localStorage` key `agent-xray-settings`.

**Views** (five tabs in `App.tsx`): `sessions`, `insights`, `prompts`,
`library`, `kanban`.

- **sessions** — the most complex. `SessionsView` renders the summary +
  messages/trace; `useSessionDetail`/`useActiveSessionDetail`
  (`childAgents.ts` switches to a child transcript when `viewingChildAgent`),
  `useSessionSse` (EventSource `/api/watch`; new messages append to the same
  query cache and pushed status merges into the `['sessions',…]` list cache),
  `usePlatformProbe` (empty-state). `SessionList` is the sidebar: grouping
  (`platform`/`project`/`none`) + four-state sub-group headers, virtual scrolling
  (> 200 rows) with `@tanstack/react-virtual`, arrow-key navigation.
  `queries.ts` defines the query keys/options; `CmdkDialog` reuses the same
  cache via `queryClient.fetchQuery`. Status labels come from
  `/api/status-labels` (`statusMeta.ts`).
- **trace** — `TraceView` renders a Langfuse-style waterfall from
  `buildTraceTurns` (`pure.ts`); a purple bar loads a spawned sub-agent's
  transcript (`childAgents.ts`).
- **insights** — `GlobalInsights` (server `/api/insights`, tool stats/error
  clusters/trend + `ToolsAuditSection`) vs `SessionInsights` (client-side
  `computeSessionInsights` from the already-loaded session detail cache).
- **prompts** — extraction grouped by cwd, search, hide-trivial, batch hide,
  JSON export, `分析优化` (cluster + attribution + LLM suggestions via
  `getPromptAnalysis`) and single-prompt `优化` rewrite.
- **library** — curated prompts with per-target (claude/codex/omp) install
  toggles, edit/history, Fabric import, LLM name suggestion.
- **kanban** — reuses `useSessionsList` (same cache/5 s poll/SSE merge) and
  `buildKanbanColumns` (`kanbanLib.ts`) bucketing by the four states;
  `maxPerStatus` (default 20) truncation from `/api/settings`'s `kanban`;
  responsive stacking below 768 px.

**Shared libs.** `src/lib/pure.ts` — no-DOM pure functions (formatters, trace
builder, turn ledger); `src/lib/markdown.ts` — escape-then-transform markdown;
`src/lib/legacy-pure.ts` — the aggregation entry baked to `public/js/pure.js`
(§11). `src/lib/utils.ts` provides `cn()` (clsx + tailwind-merge).

**Theme & UI.** `useTheme` syncs `store.theme` (`light`/`dark`) to `<html>`'s
`.dark` class; the palette lives in `index.css` CSS variables (`:root` light /
`.dark` dark, mapped to Tailwind colors). Initial theme follows the system once,
then is fixed by manual toggle and persisted to `agent-xray-settings`. The UI
component library is shadcn/ui-style on Radix + Tailwind under
`src/components/ui/` (button/badge/card/dialog/select/tabs/command/…).

## 14. Real-time watch (SSE)

`lib/watch.js` + `lib/routes/watch.js` implement `GET /api/watch` (EventSource).
`readNewLines` tails a file from a byte offset (plain JSONL advances only past
the last complete line; dsh zstd decompresses every complete new frame and
leaves a torn frame for the next read). `parseWatchLines` normalizes raw lines
through the platform's `watchParse`. `accumulateWatchTail`/`watchTail` feed the
tail-evidence state machine so the route can derive status for each push
without re-parsing the whole log. The OMP watcher additionally handles
session-level `session_exit` records (→ `noteEnded` + `resolveAllPending`, so
an `ask` interaction is closed). Hermes has a dedicated SQLite WAL-watch branch
(timestamp-incremental query).

## 15. Backup, export, OTLP

- **Backup** (`lib/backup.js`): incremental — copies each platform's session
  logs into `~/.agentlray/archive/<platform>/<relative-path>`; a file is skipped
  when the archived copy exists with the same size and an mtime no older than
  the source. Covers codex/claude-code/omp/dsh/gemini; excludes Hermes (live
  SQLite) and openclaw. Runs on demand and automatically shortly after startup,
  then daily; failures are logged, never fatal.
- **Export** (`lib/export.js`): renders a normalized session as shareable
  Markdown or self-contained HTML (inline CSS, no external requests). Tool calls
  render as collapsed `<details>`. A best-effort `redactSecrets` pass strips
  obvious secrets (Bearer tokens, `sk-` keys, `Authorization`/`x-api-key`
  headers, `gh_`/`xox_`/`AKIA`). `fenceFor` protects against embedded
  backtick-fence breakout.
- **OTLP** (`lib/otlp.js`): serializes a session's trace as OTLP/JSON — one
  trace per session, one `invoke_agent` root span per user turn with child
  `chat {model}` and `execute_tool {toolName}` spans, mirroring the frontend's
  `buildTraceTurns`. Deterministic sha256-derived ids. Excludes openclaw
  (needs agent) and hermes (no files).

## 16. Security and trust model

- **No auth, localhost by default.** The dashboard exposes full session history
  with zero auth; it binds to `127.0.0.1` by default (`HOST=0.0.0.0` opts into
  LAN).
- **CSRF:** no cookies → no CSRF token would help. The guard rejects
  cross-site unsafe requests by checking `Origin`/`Sec-Fetch-Site`/`Referer`
  against the request's `Host` (origin-relative, so LAN deployments on any
  hostname keep working).
- **Path sanitization:** `resolveDir` accepts only absolute, `..`-free
  overrides; `sanitizeAgentName`/`sanitizeSessionId` whitelist characters.
- **Custom platforms are code you trust.** An adapter executes with your full
  user permissions; only place trusted files (`AGENTLRAY_NO_PLUGINS=1` as the
  escape hatch). This is the accepted tradeoff recorded in
  `docs/.local/adr-0001-custom-platform-adapter.zh-CN.md`.
- **Exports/evidence are shared artifacts.** `redactSecrets` is best-effort;
  the `evidence` command explicitly returns raw source content. Neither is a
  sanitizer, authorization or proof of authenticity.

## 17. Testing

Tests use Node's built-in runner (`node --test test/*.test.js`, no extra
dependencies). They start their own server on a random port with `HOME` and every
platform directory pointed at a throwaway copy of `test/fixtures/home`, so real
logs are never touched. CI runs on Node 22: `npm ci` (prepare builds UI +
regenerates `pure.js`/`diagnostics.cjs`), a drift check
(`git diff --exit-code public/js/pure.js lib/generated/diagnostics.cjs`),
`npx biome check .`, then `npm test`. Diagnostic rules are cross-checked between
the TS source and the generated CJS bundle so CLI and UI agree.

## 18. Key architecture decisions (summary)

| Decision | Rationale |
|---|---|
| Platform registry single source | One adapter + registration adds a platform; every generic surface resolves through it. |
| Runtime custom adapters | Extend without forking the source; trusted-code tradeoff (ADR-0001). |
| Synchronous custom-platform load | Derivation points read `PLATFORMS` at `require` time. |
| Unified 4-state status from record evidence | No process queries; consistent across list + watch + CLI. |
| Single `settings.json` + one `/api/settings` | One migration, one web entry; per-section whitelists. |
| Single `lib/resume.js` | CLI and web copy produce the identical command. |
| `pure.ts`/`markdown.ts` single source | Baked to legacy UI; reused by tests. |
| `diagnostics.ts` bundled to CJS | CLI and UI apply identical rules. |
| Dual frontend (React new, legacy frozen) | Feature velocity without breaking the frozen snapshot. |
| CSRF via Origin/Host comparison | Works without cookies/auth; survives LAN hostnames. |
