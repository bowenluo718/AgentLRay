# Usage and reference

[Project overview](../README.md) · [中文参考](usage.zh-CN.md) · [Offline inspect](offline-inspect.md) · [Execution evidence](diagnostics.md)

Detailed feature catalog, screenshots, installation alternatives, configuration and HTTP API. For the shortest first run, start with the project overview.

## Features

- **Offline evidence CLI** — `agentlray inspect --platform codex session.jsonl --json` reads one explicitly selected log without a server or model. Versioned, minimized reports expose source lines and shared UI-rule hashes; opt-in pending-failure gates never claim task correctness. Supports Codex, OMP and Claude Code JSONL. [Automation contract](offline-inspect.md).

- **Automatic session health** — Opens with factual failure, repetition, follow-up and last-recorded call-state summaries. Missing/running/unknown results have evidence links; no human labels or model calls required. Manual notes and transfers are opt-in and never hide automatic facts. [Scope and offline checks](diagnostics.md#automatic-session-health).
- **Codex background-process evidence** — Connect explicit `exec_command` process IDs to later `write_stdin` results, with launch/poll/exit source links. Ambiguous IDs or polling sequences stay unknown; process completion never rewrites historical tool-call states or proves a task passed. [Association limits](diagnostics.md#codex-background-process-evidence).
- **Modification/check chronology** — Distinguish checks before an edit, checks overlapping it and later outcomes. A passed earlier check or a successful output pipeline is not post-change validation; ambiguous command fragments remain unknown. [Recognition and coverage limits](diagnostics.md#modification-and-verification-chronology).

- **Per-turn ledger** — In the session summary, from two user turns on: one row per user turn with wall-clock time, tokens (input + output + cache) and cost, bars scaled to the session maximum, tool-call counts inline (error counts in the row tooltip), click to jump. Answers "why did this take 40 minutes / cost $3" without reading the transcript.
- **Multi-platform** — Unified view across OpenClaw, Codex, Claude Code, Hermes, OMP, DeepSeek Harness and Gemini CLI sessions (dsh's multi-frame zstd session logs are decompressed transparently; Gemini CLI's `/rewind` checkpoints are folded so rewound history never renders twice)
- **Session browser** — Browse agents, filter/search sessions, view message history
- **Tool call inspection** — Expandable tool calls with arguments and results
- **Trace view** — Per-turn waterfall of where the time went: model inference (blue) vs tool execution (green, red on error); click any bar for its span detail in the sidebar, and a purple bar to load the spawned sub-agent's transcript
- **Prompt extraction** — See every real human prompt per session (tool results, slash commands and injected noise filtered out), grouped by working directory, with search / JSON export / copy
- **Prompt optimization** — Cluster prompts into templates, attribute session outcomes (turns, tool calls, error rate) per template, and get LLM-powered rewrite suggestions — through any OpenAI-compatible endpoint (Settings → LLM 接口) or, if none is configured, the local `claude` CLI
- **Prompt library** — Curate the prompts worth keeping into `~/.agentlray/library`, tag / edit / search them, then install any of them as a native slash command for Claude Code, Codex or OMP with one click — `$ARGUMENTS` is passed through, so `/name some args` works in the target CLI
- **Global search** — One search box across all seven platforms at once, multi-keyword AND matching, colored platform badges per hit — including prompts recovered from sessions that Claude Code's cleanup already deleted
- **Session insights** — Aggregate analytics dashboard with tool stats, error clustering and daily trends
- **Evidence-backed failure events (React UI)** — Groups unresolved failures by the same tool, complete arguments and call's user turn, with repeated operations first, first/last evidence jumps and every original result retained. Successful results split groups; missing arguments stay separate. Execution success requires an explicit zero exit code or OMP-native completion evidence. These are review groups, not root-cause diagnoses or proof of task failure. Local rules, no LLM. [Try the synthetic walkthrough and read the boundaries](diagnostics.md).
- **Follow-up evidence candidates** — See later calls differing only in `i`, or same-turn modifications of the same explicitly identified file. Each has a result status, matching rationale and evidence jump; candidates never automatically resolve the failure. [Matching boundaries](diagnostics.md#follow-up-evidence-candidates).
- **Local review queue** — Record follow-up, expected-failure or alternative-verification notes in your browser. Evidence changes invalidate the old review; manual labels never rewrite automatic outcomes. No account or review backend. [Review workflow and storage limits](diagnostics.md#local-review-workflow).
- **Review portability** — Preview and download current-session review notes, then import only exact evidence matches into empty local slots. Existing notes are never overwritten; stale/unmatched records are skipped. JSON files are unencrypted and contain your written notes, not automatically copied logs. [Transfer limits](diagnostics.md#transfer-reviews-between-browsers).
- **Narrow-screen session workflow** — Below 768px, switch between the session list and full-width content without losing the current review draft; platform tabs scroll horizontally, and evidence jumps keep navigation visible. Desktop retains the two-column layout. [Scope and tested viewports](diagnostics.md#narrow-screen-session-workflow).
- **Spawn tracking** — Detect and navigate parent/child agent relationships
- **OMP sub-agents** — Sub-agents spawned by an OMP session show up as chips in the summary; click one to read the child agent's full transcript
- **Message timeline** — Visual graph showing conversation flow with role indicators
- **Resume command** — One click copies the exact command to resume a session in its own CLI (`codex resume`, `claude --resume`, `omp --resume=`, `dsh --profile pi-tui --preset standard --resume`, `gemini -r`, `hermes --resume`)
- **Collapsible summary** — Fold the session summary away when you want the full height for messages
- **Auto-refresh** — Live-updating session list and messages
- **Kanban board** — A four-state task board view (`awaiting-input` / `working` / `waiting` / `stopped`) built from the same list cache and live status as the sidebar; columns truncate at `maxPerStatus` (default 20, configurable under Settings → 任务看板), stack vertically on narrow screens. Click a card to open that session in the Sessions view.
- **Light / dark theme** — Toggle between light and dark in the top bar (follows the system once on first launch, then fixed by your manual choice, persisted in `agent-xray-settings`).
- **Settings panel** — Configure platform directories from the UI, persisted in localStorage
- **Session backup** — Incremental archive of your Codex, Claude Code, OMP, DeepSeek Harness and Gemini CLI session logs into `~/.agentlray/archive` (Hermes and OpenClaw are not archived), one click in settings (also runs automatically, daily); unchanged files are skipped
- **Keyboard navigation** — Arrow keys to move between sessions

---

## Screenshots

### Session Browser

Browse agents and sessions in the sidebar. Each session card shows message counts by role (👤 User, 🤖 Assistant, 🔧 Tool) and spawn indicators. The main panel displays session metadata, token usage, and top tools at a glance.

![Main View](../screenshots/main-view.png)

### Tool Call Inspection

Expand any tool call to see its arguments and result. Collapsed groups show tool type counts for quick scanning.

![Tool Calls](../screenshots/tool-calls.png)

### Spawn Tracking

Sessions that spawn sub-agents are marked with a 🔗 badge. Click to navigate the parent/child relationship chain.

![Spawn Tracking](../screenshots/spawn-tracking.png)

### Multi-Platform Support

Switch between OpenClaw, Codex, Claude Code, Hermes, OMP, DeepSeek Harness and Gemini CLI with one click. Each platform's sessions are parsed from their native log format.

![Codex View](../screenshots/codex-view.png)

### Settings

Configure platform directories from the UI. Changes are saved to localStorage — no server restart needed.

![Settings](../screenshots/settings-panel.png)

---

## Install

**Option 1 — npx from npm**

```bash
npx @bowenluo718/agent-lray            # default http://localhost:3800
npx @bowenluo718/agent-lray --port 3900 --host 127.0.0.1
```

A global install (`npm i -g @bowenluo718/agent-lray`) exposes the same launcher as `agentlray`.

**Option 2 — npx straight from GitHub** (works today, no clone)

```bash
npx github:alloevil/AgentLRay
```

The first run builds the web UI locally (takes a minute); later runs reuse the cached install.

**Option 3 — from source**

```bash
git clone https://github.com/alloevil/AgentLRay.git
cd AgentLRay
npm install               # also builds the web UI on first install
npm start
```

Open http://localhost:3800

---

## Usage

### Basic Workflow

1. **Select a platform** — Click `OpenClaw`, `Codex`, `Claude Code`, `Hermes`, `OMP`, `DeepSeek Harness`, or `Gemini CLI` in the top bar
2. **Pick an agent** — For OpenClaw, the list defaults to **all agents merged** (grouped per agent); use the dropdown to narrow to a single agent (e.g. `xiaot`, `mimo`)
3. **Browse sessions** — Sessions are sorted by date, newest first. Each card shows:
   - Timestamp and status (`active` / `archived`)
   - Message counts: 👤 User, 🤖 Assistant, 🔧 Tool calls
   - 🔗 Spawn badge if the session spawned sub-agents
4. **View messages** — Click a session to load its full conversation
5. **Inspect tool calls** — Click any `🔧 tool_name` button to expand arguments/results
6. **Navigate spawns** — Click the 🔗 link to jump to the spawned child session

### Task Board and New Tasks

The **Task Board** tab (任务看板) groups every session into four status columns — awaiting input / working / waiting / stopped — with a text filter above them. Its header carries a **New Task** button that opens a dialog which spawns the platform CLI to start a brand-new session.

**The dialog has three fields:**

| Field | Meaning |
|-------|---------|
| **Platform** | Dropdown listing **only the platforms that support creating sessions** — codex, claude-code, omp, gemini, hermes. dsh and openclaw are never listed (dsh is an interactive TUI that cannot take a prompt headlessly; openclaw has no native create command). Custom platforms appear only when their adapter declares a `create` contract. |
| **cwd** | Working directory for the new session, typed by hand. Leave it empty to use the platform's default directory. |
| **Prompt** | The prompt to hand to the new session. Optional — leave it empty to start an interactive session. |

**Defaults follow the current selection:** with a session selected, the platform and that session's project path are pre-filled; with no session selected, the platform filter's platform is used and cwd stays empty.

**What happens on submit:** the backend spawns the platform CLI (`POST /api/:platform/sessions/new`) and answers immediately with the exact command it ran; a toast reports "Triggered `<platform>` new session" plus the command string for manual copy, and the board list refreshes. The command string has a **single source of truth on the backend** (`lib/new.js`, shared with terminal `sessions new`), so what the page shows is character-for-character what runs.

**Fire-and-forget trade-off:** the spawned process's output is discarded, the process is not tracked, and the web UI offers **no way to query or terminate it** — watch the outcome in the terminal or in the platform's own CLI. This is deliberate: the page triggers the run, the platform owns the session.

### Prompt View

Click the **Prompts** tab (next to Sessions / Insights) to see every real human prompt across all sessions, grouped by the session's working directory. Noise like tool results, slash-command echoes, system reminders and task notifications is filtered out.

- **Preview & expand** — Each session row shows a one-line preview of its first prompt; click to expand the full markdown-rendered prompt list
- **Search** — Filter prompts / directories / sessions live
- **Export JSON** — Download all extracted prompts for offline processing
- **分析优化 (Analyze)** — Cluster prompts into templates, attribute session outcomes (avg turns, tool calls, error rate) per template, and get rewrite suggestions from the configured LLM backend (Settings → LLM 接口) or, when no endpoint is set, the [`claude` CLI](https://claude.com/claude-code) on the server's PATH. With neither, clustering and attribution still work, and the analysis route reports the missing backend as `llmError`. A per-request LLM timeout (default 15 min, adjustable under Settings → LLM 接口) bounds each call. Requests use node http(s) directly for NO_PROXY (intranet/local) endpoints and the Node proxy for external ones; slow gateways are no longer killed by undici's 5-minute headers timeout into a bare "fetch failed" — our own timeout closes the call with a readable message, and network errors carry their underlying cause (connection refused / TLS / DNS)
- **优化 (Optimize)** — Hover any single prompt and click 优化 for an inline LLM-powered rewrite (configure the backend in Settings → LLM 接口, or have the `claude` CLI on PATH)

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move between sessions |
| `Enter` | Select highlighted session |

### Filtering & Search

- **Search box** — Filter sessions by ID or content
- **Auto-refresh** — Automatically poll for new sessions and messages
- **Auto-scroll** — Scroll to the latest message when new content arrives

---

## Configuration

### Default directories

| Platform    | Default path                  |
|-------------|-------------------------------|
| OpenClaw    | `~/.openclaw/agents`          |
| Codex       | `~/.codex/sessions`           |
| Claude Code | `~/.claude/projects`          |
| Hermes      | `~/.hermes`                   |
| OMP         | `~/.omp/agent/sessions`       |
| DeepSeek Harness | `~/.dsh/sessions` (honors `DSH_HOME`) |
| Gemini CLI  | `~/.gemini/tmp`               |

### Custom directories

**Via UI:** Click the gear icon in the sidebar to set custom paths per platform. Saved to localStorage, no restart needed.

**Via environment variables:**

```bash
OPENCLAW_DIR=/custom/path/openclaw \
CODEX_DIR=/custom/path/codex \
CLAUDE_CODE_DIR=/custom/path/claude \
HERMES_DIR=/custom/path/hermes \
OMP_DIR=/custom/path/omp \
DSH_DIR=/custom/path/dsh/sessions \
GEMINI_DIR=/custom/path/gemini/tmp \
npm start
```

**Via API:** Pass `?dir=/absolute/path` query parameter to any API endpoint.

### Platform CLI commands

`agentlray sessions resume --run` spawns each platform's native CLI to continue a session. By default it uses the bare command name (`codex`, `claude`, `omp`, `dsh`, `gemini`, `hermes`) resolved from `PATH`. Resolution priority: **environment variable > settings panel (server-side `~/.agentlray/settings.json` `cliBins` section) > default command name**.

**Via settings panel:** In the web UI open Settings (gear) and, under "Platform CLI commands", set the executable command (absolute path) for codex / claude-code / omp / dsh / gemini / hermes. Submitted with the dialog's single Save button, persisted server-side in `~/.agentlray/settings.json` (cliBins section); both terminal `resume --run` and the frontend "copy resume command" button use it immediately. Leave blank to clear a platform's config (fall back to the default command name).

**Via environment variables (highest priority):**

```bash
AGENTLRAY_CODEX_BIN=/path/to/codex \
AGENTLRAY_CLAUDE_CODE_BIN=/home/0668000603/.nvm/versions/node/v22.19.0/bin/claude \
AGENTLRAY_OMP_BIN=/path/to/omp \
AGENTLRAY_DSH_BIN=/path/to/dsh \
AGENTLRAY_GEMINI_BIN=/path/to/gemini \
AGENTLRAY_HERMES_BIN=/path/to/hermes \
npm start
```

Unset variables and platforms not configured in the panel fall back to the default command name.

`agentlray sessions new [message...] --platform <p> [--dir <cwd>] [--run]` generates (and optionally executes) a **new session** command — spawning the platform CLI to open a brand-new session with a prompt and a working directory. Creatable platforms and their command shapes: codex (`codex exec --full-auto '<prompt>'`), claude-code (`claude --dangerously-skip-permissions -p '<prompt>'`), omp (`omp --auto-approve '<prompt>'`), gemini (`gemini -p --approval-mode=yolo '<prompt>'`), hermes (`hermes --yolo -z '<prompt>'`). **dsh is an interactive TUI and cannot take a prompt headlessly → new is not supported** (reports "no native create command"). The prompt is the positional args after `new` joined with a space, and may be empty (empty = no prompt / interactive); the framework appends it as the last bare argument. By default it only prints the command; with `--run` it actually does a **fire-and-forget** spawn (output discarded, process untracked, no wait for exit — output lives on the platform CLI side, this tool does not track it). cwd is prefixed with `cd '<cwd>' &&` (POSIX) / `Set-Location` (PowerShell); `--dir` overrides, defaulting to the platform's default directory. Binary resolution matches resume (env var > cliBins > default command name).

> **Where the command shapes come from.** Each shape was fixed against that CLI's own `--help` where the CLI was installed: omp v18.8.4 (positional `MESSAGES` argument + `--auto-approve`), Claude Code 2.1.282 (`-p/--print` is a **boolean** switch — the prompt is a positional argument — plus `--dangerously-skip-permissions`), hermes (the prompt must go through **`-z/--oneshot`**; a bare positional argument is rejected as an unknown subcommand, and `-z` requires a value — so the no-prompt case falls back to `hermes --yolo`, i.e. the interactive form). **codex and gemini are not verified** — neither CLI was installed on the machine where this was built, so they keep the inferred shape from the design doc and may need adjusting once a real CLI is available. In particular, gemini's `-p` may expect the prompt as *its* value (the design doc wrote `gemini -p '<prompt>' --approval-mode=yolo`), whereas the framework always appends the prompt last — if that turns out to be the case, the shape has to become `gemini --approval-mode=yolo -p '<prompt>'`. Until a real gemini CLI is available this stays unverified.

### Status time configuration

Session status (awaiting-input / working / waiting / stopped) depends on three time windows, defaulting to 2 min / 30 min / 12 h. Configure them under "Status time configuration" in the settings panel (units: minutes / hours); saving writes server-side `~/.agentlray/settings.json` (status section) and takes effect for subsequent status evaluation. Terminal `agentlray sessions list` and the web dashboard share the same config.

| Setting | Default | Description |
|---------|---------|-------------|
| Recent activity freshness | 2 min | Within this freshness after a completed turn → working |
| Active work ceiling | 30 min | Long tool runs / deep thinking stay working within this bound, then degrade |
| History ceiling | 12 h | Sessions without an end marker older than this → stopped; upper bound for awaiting-input / waiting |

## Custom platforms

AgentLRay lets you plug in extra platforms without changing the source: write a JavaScript **platform adapter** and drop it into a platform directory. On startup the loader validates each file and merges valid adapters into the platform registry; every generic surface (session routes, search, prompts, tool audit, watch, export, CLI) then resolves the new platform by capability bit. Invalid or conflicting files are marked **broken** (visible in the UI and on `platform list`) and never break startup.

**Three sources**, loaded in order (later ones may override earlier ones for the same `id` when a replacement is declared — see below):

| Source | Directory | Origin |
|---|---|---|
| package (built-in) | shipped in the package | `package` |
| project | `$AGENTLRAY_PROJECT_PLATFORMS_DIR` or the repo's `platforms/` | `project` |
| user | `$AGENTLRAY_PLATFORMS_DIR` or `~/.agentlray/platforms/` | `user` |

**Enable / disable:** a file present in a platform directory (except `package`) is enabled; remove or move it to disable. There is no per-platform switch. Files load in alphabetical order. An `id` that collides with a built-in or an earlier custom adapter marks that file broken. Set `AGENTLRAY_NO_PLUGINS=1` to skip both project and user sources entirely (only package remains) as an escape hatch.

**Replacing a built-in (declare intent first):** a project or user adapter whose `id` collides with a built-in is only allowed to override it when that replacement is *declared* — either in the user `settings.json` (`platforms.replaced`) via `platform replace <id>`, or in the project directory's `platforms/manifest.json` `replaces` array (merged with `settings.replaced`; a missing/corrupt manifest is ignored). Without a declaration the same-id file is marked broken with a hint to run `platform export <id>` / `platform replace <id>`. Once declared but not (yet) provided by a file, the built-in stays active and is marked `replacementPending`.

**Required contract** (validated by the loader): `id` (`^[a-z0-9][a-z0-9-]*$`), `label` (string), `defaultDir()` → session root, `parse(file)` → `{ session, messages }`, `getSession(dir, id)` → `{ session, messages } | null`; `list(dir)` → newest-first `SessionSummary[]` (the loader tolerates `list: null` like OpenClaw, but a listing platform needs it).

**Optional capability bits** — a missing bit just silences that surface, no error:

| Field | Enables |
|---|---|
| `find(dir, id, opts?)` | watch tailing and OTLP export |
| `collectFiles(dir, opts?)` | search / prompts / tool-audit bulk scans |
| `watchParse(rec, line?)` | live SSE tail (needs `find` too; without it `/api/watch` returns 400) |
| `needsAgent` | OpenClaw-style per-agent platform (detail/list need `agent`; excluded from OTLP) |
| `resume = { bin, args(id, opts) }` | CLI `sessions resume` for this platform |
| `create = { bin, args(opts) }` | CLI `sessions new` for this platform (opts = `{ cwd, message }`; the prompt is appended last by the framework) |
| `version` | contract version (starts at 1) |

**CLI:**

```bash
agentlray platform list                                                     # built-in + project + custom + broken, same source as GET /api/platforms
agentlray platform list --json                                              # + origin/mounted/configuredMounted/restartRequired per entry
agentlray platform validate ~/.agentlray/platforms/my-copilot.js --json     # same checks as the loader, dry-run
agentlray platform mount <id> | unmount <id>                                # enable/disable a platform (writes settings.platforms.disabled, restart to take effect)
agentlray platform replace <id> | unreplace <id>                            # declare/undo replacement of a built-in (writes settings.platforms.replaced, restart to take effect)
agentlray platform export <id> [--out <dir>] [--force] [--no-replace] [--json]   # migrate package/project platform to a user thin adapter
```

`platform validate` reuses the loader's own validation, then calls the adapter's real `list(defaultDir())` and reports the session count and the first session id — passing it means the platform is actually listable. `list --json` prints `{schemaVersion:1, kind:"platforms", platforms:[…]}` (each entry carries `origin`, `mounted`, `configuredMounted`, `restartRequired`); `validate --json` on success prints `{schemaVersion:1, kind:"platform-validate", ok:true, platform:{id,label}, sessionCount, firstId, note}`.

`mount` / `unmount` write `~/.agentlray/settings.json` (`platforms.disabled`) and take effect after a restart — the last queryable platform cannot be unmounted (errors `last-platform`). `replace` / `unreplace` write `platforms.replaced`; `unreplace` warns if a same-id project/user file still exists (it would be broken on the next load).

**`platform export`** migrates a package (built-in) or project platform to a **user thin adapter** in the platform directory (default `~/.agentlray/platforms`, override with `--out <dir>` or `AGENTLRAY_PLATFORMS_DIR`): it writes `<id>.js` plus, by default, adds the id to `settings.replaced` (`--no-replace` skips that) and removes it from `settings.disabled` if present. The generated adapter is a thin wrapper that resolves the real implementation via `AGENTLRAY_PKG_ROOT` (set by the loader to the package root), so a package upgrade follows automatically. Options: `--force` overwrites an existing file; `--out <dir>` targets a directory; `--json` prints `{schemaVersion:1, kind:"platform-export", id, file, origin, replaced, restart:true, …}`. A source already `user`-origin is refused (`export-user-origin`); conflicts error `export-exists` (use `--force`). Because the adapter runs with your user permissions, the CLI prints a trust note — only deliver trusted adapter files. **Requirement:** the generated thin adapter depends on `AGENTLRAY_PKG_ROOT` injected by the loader and can only be loaded through AgentLRay; requiring it directly fails with `AGENTLRAY_PKG_ROOT is not set; load this adapter through AgentLRay.`

**Web UI:** built-in and custom platforms appear in the same platform bar (both React and legacy UI). A custom platform whose file fails to load shows a broken badge with its error and takes no part in queries.

**Resume / create stay opt-in:** a custom platform gets CLI `sessions resume` only when the adapter declares `resume = { bin, args(id, opts) }` (otherwise "no native resume command"); it gets CLI `sessions new` only when it declares `create = { bin, args(opts) }` (otherwise "no native create command"). The spawned binary resolves via env var `AGENTLRAY_<PLATFORM_ID>_BIN` > `~/.agentlray/settings.json`'s `cliBins` `<id>` key > the adapter's default `bin`.

**Trust:** an adapter executes with your full user permissions (equivalent to running a script yourself). Only place trusted files; when in doubt use `AGENTLRAY_NO_PLUGINS=1`. Define `defaultDir()` inside the adapter and read your own env if needed — the generic `?dir=` / `--dir` override still applies.

A complete runnable, annotated sample adapter (flat JSONL platform, with `find` / `collectFiles` / `watchParse` / `needsAgent` and a resume snippet) is in [docs/.local/custom-platform-example.zh-CN.md](.local/custom-platform-example.zh-CN.md).

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/status-labels` | Unified session-status vocabulary `{ order, labels }` for the four states (single source for both UIs) |
| `GET /api/agents` | List OpenClaw agents (legacy shim: registered only while openclaw is mounted; 404 once openclaw is disabled/removed — same for the two rows below) |
| `GET /api/agents/:name/sessions` | List sessions for an agent (legacy shim, same lifecycle) |
| `GET /api/agents/:name/sessions/:id` | Get session messages (legacy shim, same lifecycle) |
| `GET /api/codex/sessions` | List Codex sessions |
| `GET /api/codex/sessions/:id` | Get Codex session messages |
| `GET /api/claude-code/sessions` | List Claude Code sessions |
| `GET /api/claude-code/sessions/:id` | Get Claude Code session messages |
| `GET /api/hermes/sessions` | List Hermes sessions |
| `GET /api/hermes/sessions/:id` | Get Hermes session messages |
| `GET /api/omp/sessions` | List OMP (oh-my-pi) sessions |
| `GET /api/omp/sessions/:id` | Get OMP session messages |
| `GET /api/dsh/sessions` | List DeepSeek Harness sessions |
| `GET /api/dsh/sessions/:id` | Get DeepSeek Harness session messages |
| `GET /api/gemini/sessions` | List Gemini CLI sessions |
| `GET /api/gemini/sessions/:id` | Get Gemini CLI session messages |
| `GET /api/platforms` | List all platforms (built-in + custom + broken) with capability bits, labels and load errors |
| `POST /api/:platform/sessions/new` | Spawn the platform CLI to start a new session (`{ "message": "...", "cwd": "..." }`, both optional). Fire-and-forget: answers `{ triggered, platform, bin, args, command }` once the spawn is triggered. 404 unknown platform, 422 platform without a create contract (dsh / openclaw), 400 cwd missing or not a directory |
| `GET /api/spawn-map` | Build agent spawn relationship map (legacy shim: registered only while openclaw is mounted; 404 once openclaw is disabled/removed — `/api/spawn-tree` likewise) |
| `GET /api/insights` | Aggregate analytics (tool stats, error clusters, trends) |
| `GET /api/prompts` | Real human prompts per session, grouped by directory |
| `GET /api/prompts/analyze` | Template clustering + attribution + Claude suggestions (`?refresh=1` to recompute, `?skipLlm=1` for clustering only) |
| `POST /api/prompts/rewrite` | Rewrite a single prompt via the configured LLM backend (`{ "text": "..." }`; 503 with guidance when no backend is available) |
| `GET/PUT /api/settings` | Unified settings endpoint: all server-side settings aggregated in `~/.agentlray/settings.json` (legacy `ui-settings.json`/`cli-bins.json`/`status-config.json`/`kanban-config.json`/`llm.json` migrate in on first start). PUT saves only the sections supplied (`ui`/`cliBins`/`status`/`kanban`/`llm`), others untouched. `cliBins` returns `bin`/`configured`/`default`, empty string clears (fall back to default); `status`/`kanban` return `value`/`configured`/`default`, saving takes effect immediately; `llm` `baseUrl`/`model`/`analysisTimeoutMs`/`hasApiKey` (key never echoed back) |
| `GET /api/settings/cli-bins` | Read-only compat endpoint for the legacy frozen UI (`/legacy` resume-copy button); same `bin`/`configured`/`default` shape as `/api/settings`'s `cliBins` |
| `GET /api/search` | Full-text search across sessions (`?platform=all` searches every platform at once, multi-keyword AND) |
| `GET /api/omp/sessions/:id/children` | List sub-agents spawned by an OMP session |
| `GET /api/omp/sessions/:id/children/:name` | Get a spawned sub-agent's messages |
| `GET /api/library` | List library prompts with their per-target install state |
| `POST /api/library` | Create a prompt (`{ "name": "...", "content": "...", "description": "...", "tags": [...] }`) |
| `PUT /api/library/:name` | Update / rename a prompt (`newName`, `content`, `description`, `tags`); installed copies are refreshed |
| `DELETE /api/library/:name` | Delete a prompt and any installed slash commands |
| `POST /api/library/:name/install` | Install as a slash command (`{ "targets": ["claude", "codex", "omp"] }`) |
| `POST /api/library/:name/uninstall` | Remove the installed slash commands (same body) |
| `POST /api/library/suggest-name` | Suggest a library name for a prompt via the configured LLM backend (`{ "text": "..." }`; `null` when no backend is available) |
| `POST /api/backup` | Run an incremental backup into `~/.agentlray/archive` |
| `GET /api/backup/status` | Archive stats: file count, total bytes, last backup time |

All list/detail endpoints accept an optional `?dir=` parameter to override the default directory.

---

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** React + Vite + TypeScript under `frontend/` (default UI, served from `frontend/dist`)
- **Legacy UI:** the original vanilla HTML/CSS/JS app under `public/`, served at `/legacy` — **frozen: security fixes only**. New features land in the React app exclusively; a feature change to the React renderer requires zero edits under `public/js/`. Shared logic (formatters, trace builder, markdown/escape pipeline) is authored once in `frontend/src/lib/pure.ts` and `frontend/src/lib/markdown.ts`, and `public/js/pure.js` is generated from them (`npm run build:legacy-pure`, also part of `build:ui`).
- **Data:** Reads JSONL session files directly from disk
- **Zero external CDN** — Everything is self-contained, works offline

---

## Supported Log Formats

| Platform | Format | Path Pattern |
|----------|--------|--------------|
| OpenClaw | JSONL | `~/.openclaw/agents/{agent}/sessions/{id}.jsonl` |
| Codex | JSONL | `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{uuid}.jsonl` (session id is the trailing UUID) |
| Claude Code | JSONL | `~/.claude/projects/{project-slug}/{sessionId}.jsonl` (plus `{sessionId}/subagents/agent-*.jsonl` for spawned children) |
| Hermes | SQLite | `~/.hermes/state.db` |
| OMP | JSONL | `~/.omp/agent/sessions/*/{timestamp}_{id}.jsonl` |
| DeepSeek Harness | JSONL / zstd-compressed JSONL | `~/.dsh/sessions/{project}/{id}/session[.vN].jsonl[.zstd]` — versioned durable logs (currently `session.v4.jsonl.zstd`) |
| Gemini CLI | JSONL | `~/.gemini/tmp/{projectHash}/chats/session-*.jsonl` |

dsh's `.jsonl.zstd` logs are a concatenation of independent Zstandard frames (one per append batch); AgentLRay scans the frame boundaries and decompresses every frame, tolerating a torn trailing frame after a crash. The durable log is versioned: a session dir keeps a legacy `session.jsonl[.zstd]` (format 0) next to the frozen `session.v3.jsonl.zstd` / current `session.v4.jsonl.zstd`; AgentLRay reads the highest format version present, so the current log supersedes stale legacy copies. Reading compressed dsh logs requires Node.js ≥ 22.15 (built-in zstd); plain `session.jsonl` logs work on any supported Node.

Archived OpenClaw sessions (`.jsonl.reset.*`, `.jsonl.deleted.*`) are excluded from the web dashboard list by default (the dashboard exposes no toggle for them). The list/aggregate APIs still accept an `include_archived=true` parameter to include them for other consumers; the other adapters list active `.jsonl` files only.

---

## Development

Tests live in `test/` and use Node's built-in test runner — no extra dependencies. Run `npm ci` once, then `npm test` (`node --test test/*.test.js`). The tests start their own server on a random port with `HOME` and every platform directory pointed at a throwaway copy of `test/fixtures/home`, so your real session logs are never read or modified. CI (`.github/workflows/test.yml`) runs on Node 22 for every push and pull request to `master`, in four steps: `npm ci` (whose `prepare` script builds the web UI and regenerates `public/js/pure.js`), a drift check (`git diff --exit-code public/js/pure.js lib/generated/diagnostics.cjs`), `npx biome check .`, and `npm test`.

**Adding a platform** takes two files: write one adapter in `lib/platforms/<name>.js` (list / find / parse / normalize for that log format — `lib/platforms/shared.js` provides the metadata cache, the normalized-message factory and the session sort), then register it in the `PLATFORMS` table in `lib/platforms/index.js`. The generic session routes, search, watch (SSE tail), insights, prompts, tool audit, OTLP and Markdown/HTML export all resolve platforms through that registry — no other file needs to change. For a **custom** platform you do not touch the source at all: drop an adapter into `~/.agentlray/platforms/` (see [Custom platforms](#custom-platforms)).

---

## FAQ

**Which agents and log formats does AgentLRay support?**
Seven platforms: OpenClaw, Codex, Claude Code, Hermes, OMP (oh-my-pi), DeepSeek Harness and Gemini CLI. Six of them store JSONL; Hermes stores SQLite at `~/.hermes/state.db`. DeepSeek Harness logs may be multi-frame zstd-compressed `.jsonl.zstd`, which AgentLRay decompresses frame by frame, tolerating a torn trailing frame left by a crash. The authoritative list is the `PLATFORMS` registry in `lib/platforms/index.js` — run `node -e 'console.log(Object.keys(require("./lib/platforms/index.js").PLATFORMS))'` to print it.

**Does AgentLRay send my session data anywhere?**
Core log inspection and offline `inspect` do not call a model or upload logs. Optional prompt rewriting and suggestions use the configured endpoint, or the `claude` CLI fallback, which may contact a remote provider. Fabric import downloads patterns from GitHub. Installing packages can access registries. Development-only remote experiments require explicit invocation and a gated sanitized payload; they are not part of a normal dashboard launch. Do not use rewrite/suggestion features if you require no model egress.

**Do I have to change my agent or add instrumentation?**
No. CLI coding agents already write complete session logs to disk, and AgentLRay just reads them. There is no SDK to add to your code and no wrapper command to run your agent under. A default install needs no configuration either, because the default directories listed under [Configuration](#configuration) are used unless you override them in the settings panel or through environment variables such as `CLAUDE_CODE_DIR`.

**How do I try it without installing anything?**
Open <https://alloevil.github.io/AgentLRay/>. That GitHub Pages deployment is the real React UI, built by `.github/workflows/pages.yml`, running against `frontend/src/demo/fixtures.json` — API fixtures generated from the synthetic sample logs committed under `frontend/demo/sample-logs` by `scripts/build-demo-fixtures.mjs`. It contains no real user sessions, so treat it as a UI tour rather than as data.

**How do I add support for a log format that is not listed?**
Two files: write an adapter at `lib/platforms/<name>.js` implementing list / find / parse / normalize for that format, then register it in the `PLATFORMS` table in `lib/platforms/index.js`. Every generic route resolves platforms through that registry, so no other file needs to change. See [Development](#development).
