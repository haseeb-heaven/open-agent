## Unreleased

## v4.2.0 (2026-08-02) — Keyless Exa web search (opencode-style)

- feat(websearch): Exa now runs through its hosted MCP endpoint
  (`mcp.exa.ai/mcp`) and works with **no API key** — matching opencode's keyless
  Exa web search. Setting `EXA_API_KEY` still upgrades rate limits (passed as
  `?exaApiKey=`), and the interactive `/websearch` wizard marks it as "no key
  needed" instead of a misleading missing-key state
- feat(websearch): default no-key routing is now Exa → DuckDuckGo, and the
  recommended backend for open-source/OpenAI/Anthropic models is Exa (was
  Brave). Braver/Tavily/Serper still win when their keys are set
- feat(websearch): the HTTP fallback chain order is now Exa → Brave → Tavily →
  Serper → DuckDuckGo; DuckDuckGo remains the ultimate zero-key fallback
- test: unit coverage for keyless/keyed MCP calls, SSE `data:`-line parsing,
  direct-JSON responses, and routing changes; live Exa MCP smoke test now runs
  without a key

## v4.1.5 (2026-08-01) — Setup sign-in fixes and OPENAGENT.md branding

- fix(auth): selecting the free/local model at setup no longer fails with "No
  provider route found for model 'local-model'" — the `local` provider sentinel
  now routes to Ollama, so the fallback default model resolves
- fix(auth): "Sign in with Google" at setup no longer fails when a
  multi-provider model (e.g. `openrouter-free`) is saved — multi-provider
  routing is now gated to `MULTI_PROVIDER` auth, and Google/Gemini auth
  dispatches multi-provider models lazily per request instead of eagerly
  building a generator whose provider key isn't set yet
- fix(cli): setup, tips, /memory, /init, folder-trust, and directory-command
  copy now says OPENAGENT.md instead of GEMINI.md, and extensions default their
  context file to OPENAGENT.md
- test: add regression coverage for local sentinel routing and Google-auth model
  routing

## v4.1.4 (2026-08-01) — Clean release bundle versioning

- fix(release): rebuild the npm CLI bundle from a clean output directory so
  stale content-hashed chunks cannot report an older CLI version

## v4.1.3 (2026-08-01) — Fast provider failover and agent response latency

- perf(providers): fast mode now bounds OpenAI-compatible requests to 3 seconds
  and races one free-model fallback candidate instead of waiting through a
  serial fallback chain on stalled endpoints
- perf(providers): add opt-in `OPENAGENT_CLI_FAST_MODE=1`, capping compatible
  model completions at 1024 tokens and limiting fast-mode retries
- perf(core): explicit Gemini model selections bypass the auto-model classifier;
  model changes during an active sequence still re-route normally
- perf(core): fast mode skips the optional next-speaker follow-up request
- perf(core): cache the resolved model registry and derived free catalog during
  provider setup to avoid repeated TOML parsing and catalog allocations
- test(live): run model matrices with bounded concurrency and report wall-clock,
  p50/p95 latency, target misses, and per-model results
- test: add provider timeout, fast-mode, and full model registry coverage

- fix(cli): Slack marketplace extension install no longer fails with
  "Configuration file not found" — OpenAgent now recognizes Claude's
  `.claude-plugin/plugin.json` manifest format (in addition to
  `open-agent-extension.json` / `.mcp.json`) and adapts it into an
  `ExtensionConfig`, reading the sibling `.mcp.json` for MCP server declarations
- fix(cli): Auto-mode (`--auto`) and YOLO mode now skip the workspace-trust
  consent prompt for extensions, so installing a trusted marketplace extension
  is non-interactive
- fix(cli): `approvalMode` can be updated live at runtime via `setApprovalMode`,
  with the TUI reacting through `CoreEvent.ApprovalModeChanged`
- fix(core): free-model streaming no longer silently stalls when a provider
  returns an empty 200 completion or an empty SSE stream — the error is now
  classified as a routing failure and the next fallback model is tried

## v4.1.2 (2026-07-22) — Session resume & free-fallback fixes

- fix(core): resuming a session (`--resume`) no longer breaks strict
  OpenAI-compat providers (Cerebras) with "Tool call with id ... was not found
  in the messages" — resumed history now re-derives functionCall parts from the
  persisted `toolCalls` records and synthesizes declarations for responses to
  unregistered/hallucinated tools
- fix(core): tool-call id prefix stripping is now decided once per id and
  applied to both the call and its response, so pairs whose names diverge
  (nameless hallucinated call vs arg-shape-recovered response) stay paired
- fix(core): nameless hallucinated tool calls now get the `generic_tool`
  fallback name written back into history, fixing Gemini's
  "function_response.name: Name cannot be empty" rejection
- fix(providers): when every free-fallback model fails, the error now lists each
  model with an actionable reason (rate limited, out of credits, request too
  large, invalid key, server down) instead of only the last candidate's error —
  which was always lmstudio's meaningless "connection refused" and masked the
  real failures
- fix(catalog): removed models OpenRouter now 404s — `tencent/hy3:free` (free
  promo ended 2026-07-21), `qwen/qwen3-coder:free`,
  `meta-llama/llama-3.3-70b-instruct:free`

## v4.1.1 (2026-07-21) — Post-release fixes

Bugfix release layered on v4.1.0's free-model picker and extensions marketplace
features. Note on numbering: `origin/main` already has an unrelated v4.1.0
(provider crash / homedir-mock fixes) that never merged into `develop` — this
avoids perpetuating that collision rather than reusing `4.1.0` on `develop` for
a second, different release.

- fix(tui): `/free-models` key-entry dialog now rejects structurally-invalid
  input (leftover slash-command keystrokes, strings under 16 chars) before
  writing to `.env`, instead of silently persisting garbage as an API key
- fix(providers): `resolveRegistryPath` now walks upward from `cwd` for
  `configs/models.toml` before falling back to a bundle-relative search, so
  running from a repo subdirectory no longer risks pinning a stale
  `bundle/configs/models.toml` copy for the process lifetime
- fix(test): resolve a hanging/flaky kitty-protocol test suite in
  `gemini.test.tsx` — mock out `interactiveCli.js`'s heavy Ink render for tests
  that only assert on pre-render terminal setup, and extend timeouts for tests
  that legitimately pay the cold-import transform cost
- fix(test): clear the `cleanup.ts` force-exit timer on test teardown
  (`resetCleanupForTesting`) so it can no longer fire after a test's mocked
  `process.exit` has been restored, which was surfacing as unhandled
  `process.exit unexpectedly called` exceptions in unrelated test runs
- fix(scripts): live-test harness (`run-live-tests.mjs`) retries once on timeout
  before grading a scenario FAIL, and flags scenarios whose prompt references a
  `LIVE_TEST_MEDIA_DIR` subfolder that doesn't exist, so an environment gap no
  longer reads as a silent false "OK"

## v4.1.0 (2026-07-21) — Free-model picker & extension marketplace

- feat(tui): `/free-models` is now an interactive picker dialog (was a static
  text listing) — browse the free/local catalog, select an entry, enter and save
  a provider API key inline when one is required, and switch models without
  leaving the session; `/free` remains as an alias
- feat(extensions): `/extensions market` opens a real marketplace browser
  (`MarketExtensionsView` + `marketplaceAdapters`) — pick a registry source
  (e.g. the Claude Code or Codex marketplaces), browse it live, and install/link
  an extension with `installRef`/`installSubdir` wired through; bare
  `/extensions` now reopens the last-selected market instead of always falling
  back to the installed list
- fix(providers): add the missing `provider = "openai"` field to several
  `configs/models.toml` entries (`gpt-4.1-mini`, `gpt-4o`, `gpt-4o-mini`,
  `gpt-5-mini`, `gpt-5.4*`, `gpt-5.6*`, `o3`, `o3-mini`, `o4-mini`) so registry
  routing resolves them correctly instead of throwing "No provider route found"
- chore(config): default `.openagent/settings.json` now ships tool sandboxing
  enabled (`security.toolSandboxing`, `tools.sandboxAllowedPaths`,
  `tools.sandboxNetworkAccess`)
- test: add component coverage for `FreeModelDialog` and `MarketExtensionsView`

- fix(tui): rename the interactive model picker command to `/models` (with
  `/model` retained as a compatibility alias); unavailable paid-provider models
  now offer their provider-specific `.env` key setup directly in the dialog
- fix(providers): preserve unique registry-key routing and endpoint overrides
  when aliases share a LiteLLM model id; free sessions now rotate through the
  fallback catalog after rate-limit or free-router failures
- test(providers): add fallback-chain coverage and validate OpenRouter's
  `openai/gpt-oss-20b:free` with both complete and streaming live requests
- docs: update the branch-specific clone command; document `/models`,
  `--resume`, and `--yolo`

## v4.0.0 (2026-07-15) — OpenAgent

**Project renamed to OpenAgent** — an open-source agent that performs your tasks
using open-source free models, local models, and bring-your-own-key frontier
models. The Python interpreter codebase is replaced by a TypeScript agent
platform (forked from an Apache-2.0 terminal agent codebase, fully de-branded
and rebuilt around multi-provider routing).

- feat(rename): application is now **OpenAgent**; new `openagent` binary (the
  legacy `gemini` alias still works)
- feat(providers): local-first routing — Ollama at `localhost:11434` is the
  default provider (models auto-detected via `/api/tags`, no API key); LM Studio
  at `localhost:1234` via its OpenAI-compatible API
- feat(providers): BYOK cloud providers via LiteLLM-style `provider/model` ids —
  OpenAI, Anthropic, Gemini, Groq, DeepSeek, NVIDIA, Together AI, HuggingFace,
  OpenRouter, Cerebras, Z.ai (one env key each)
- feat(config): single-file `configs/models.toml` registry carried over from
  v3.6.0 — `[models.*]`, `[[free_catalog]]`, `[[default_priority]]`; add
  models/providers by editing one file, no code changes
- feat(free): free-model fallback chain with rate-limit/routing-failure
  classification and retry-after parsing; local models are the final fallback of
  every chain
- feat(cli): `--provider`, `--free`, `--pick`, `--byok` flags; `-m/--model`
  accepts registry keys, free-catalog ids, and `provider/model` ids
- feat(repl): `/model` model picker grouped by provider with (`/pick` kept as a
  compatibility alias) vision/streaming/key-availability markers; `/byok` writes
  keys to `.env` and reports newly unlocked models
- feat(auth): no account, no sign-in flow, no vendor credentials shipped — a new
  multi-provider auth type bypasses vendor authentication entirely
- test: unit tests for provider detection (Ollama/LM Studio), registry, picker
  grouping, BYOK writing, the full free fallback chain, per-provider wiring, and
  a registry-wide suite covering every model entry; live local + cloud
  integration tests (skipped in CI / without keys)
- docs: README, Models.MD, and this changelog rewritten for OpenAgent

## v3.6.0 (2026-07-14)

- fix(key-manager): `AllKeysExhaustedError` now carries structured
  `provider`/`retry_after_eta` attributes instead of a plain message, so callers
  can classify and react instead of string-matching (`libs/key_manager.py`)
- refactor(errors): extract shared billing/auth-vs-rate-limit classification
  (`libs/core/error_classification.py`) so product code and tests never drift on
  what counts as "exhausted"
- fix(repl): the classic `--cli` REPL catches `AllKeysExhaustedError` and
  reports it cleanly instead of crashing with a raw traceback
- feat(model-router): attempt one free-model fallback before surfacing key
  exhaustion to the user (parity with the existing agentic/yolo fallback
  behavior)
- fix(ui): persistent banner/status line forces crop-overflow and cross-checks
  terminal width so it never wraps or truncates on narrow terminals
  (`libs/agent/gemini_ui.py`, `libs/core/session.py`)
- test(live-scenarios): committed representative fixtures and added 10 new
  create/analyze/summarize/convert/edit `ScenarioCase`s covering `zip`, `mp3`,
  `java`, `sqlite`, `docx`, `svg`, `webm` — stdlib-only, no
  `javac`/`python-docx`/video codec dependency in CI
- test(model-router): lock in multi-key rotation behavior on retry as a
  regression guard
- test(e2e): fill remaining all-modes smoke gaps (yolo, gemini-style, and other
  previously-uncovered modes)
- fix(live-scenarios): coalesce blank LLM content responses and wire `--search`
  into the classic one-shot flow (found and fixed during the live scenario
  re-run)
- fix(resilience): bound `litellm.completion()` calls with a 90s request timeout
  to stop indefinite hangs
- fix(web-search): correct DDGS import order, resolve a chart prompt-injection
  contradiction, and scope live-flake soft-skip handling correctly
- fix(windows): force `legacy_windows=False` on every `rich.Console()`
  construction site — rich's auto-detected legacy-console path raised
  `OSError: Bad file descriptor` when stdout was redirected to a file/pipe
- fix(tests): `tests/interactive/helpers.py`'s shared mock interpreter now
  explicitly returns `None` from `extract_file_name`; left unconfigured, the
  `MagicMock` default `__index__` (`1`) caused `main_loop.py`'s file-attachment
  branch to silently open/close real stdout (fd 1), corrupting it for the
  remainder of the test run (`OSError: Bad file descriptor`, CPython exit
  code 120) — root-caused and fixed across all 19 test files sharing the helper
- feat(providers): add Cerebras (cloud.cerebras.ai, ultra-fast LPU inference) as
  a fully wired model provider — `cerebras-gpt-oss-120b`,
  `cerebras-gemma-4-31b`, `cerebras-zai-glm-4.7` in `configs/models.toml`
  (litellm `cerebras/<model>` dispatch, `CEREBRAS_API_KEY`),
  `[[default_priority]]` row, and `[[free_catalog]]` entries (Cerebras public
  endpoints are free, rate-limited); key routing added to
  `ModelRouter.initialize_client`/`_resolve_api_key_name`,
  `libs/llm_dispatcher.py::_detect_provider`, and
  `libs/key_manager.py::PROVIDER_ENV_MAP`; `.env.example`/README updated; new
  `TestCerebrasProviderConfig` suite in `tests/test_all_model_configs.py`
- feat(tui): Persist no-args wizard answers to `~/.code-interpreter/config.json`
  (`libs/core/wizard_config.py`); bare `python interpreter.py` skips the wizard
  and reuses saved settings once one exists; new `--config` flag forces the
  wizard to (re)run and re-save. Explicit CLI flags still take precedence over
  both the saved config and the wizard. Never persists API keys/secrets or
  one-shot `--task`/`-f` text.
- fix(tui): "Configure advanced options?" → **no** now genuinely skips _every_
  subsequent advanced prompt (session, YOLO, `--yes`, science,
  interactive-charts, image, attach, MCP), instead of still asking for the
  session name right after.
- fix(tui): Cancelling a wizard selector (Ctrl+C / Esc) no longer produces an
  unhandled `KeyboardInterrupt` traceback; `interpreter.py:main()` catches it
  around `prepare_args()` and exits cleanly with a short `Cancelled.` message.
- test(ci): raised combined `libs` coverage to 81% (≥80% gate); fixed a
  CI-breaking bug where a live-scenario test required
  `INTERPRETER_TEST_DATA_DIR` that `ci.yml` never sets

## v3.5.0 (2026-07-12)

- feat(agentic/ux): `--agentic` default live view now shows only "Thought"
  panels, back-to-back — suppresses per-step "Action"/"Observation" panels and
  retry/rate-limit/fallback log chatter; final result and workflow
  Status/Steps/Tokens/Cost summary still print, and `logs/agent_react.jsonl`
  trajectory logging is unaffected. New `--verbose`/`-V` flag (and in-REPL
  `/verbose` toggle) restores the full detailed view (`libs/agent/step_ui.py`,
  `libs/agent/react_controller.py`, `libs/agent/llm.py`)
- refactor(config): replace the `configs/` folder's ~70 per-model JSON files
  (plus `configs/free/catalog.json` and `configs/schema.json`) with a single
  human-editable `configs/models.toml` registry (`[models."<key>"]` tables,
  `[[default_priority]]`, `[[free_catalog]]`)
- feat(config): `libs/core/model_registry.py` — cached `tomllib`/`tomli`-backed
  loader
  (`ModelRegistry.load/get_model/has_model/list_model_names/default_model_name/free_catalog_entries`);
  adds `tomli; python_version < "3.11"` to `requirements.txt`
- refactor(models): `libs/free_llms.py`, `libs/utility_manager.py`,
  `libs/core/model_router.py`, `libs/core/session.py`,
  `libs/interpreter_lib.py`, `libs/core/main_loop.py` now resolve models via
  `ModelRegistry` instead of `configs/<name>.json` paths; `/model`, `--free`,
  `--list-free`, `--gemini-style`, `-m <model>` behavior is unchanged end-to-end
- chore(scripts): `scripts/smoke_all_models.py`,
  `scripts/config_builder.sh`/`.bat` updated to read/append
  `configs/models.toml` instead of per-model JSON files
- docs: README/AGENTS.md updated to document the `configs/models.toml` registry
  and how to add custom models/providers without touching Python code

## v3.4.0 (2026-07-12)

- fix(agentic/yolo): AutoLoop treats malformed tool XML (`<write_file` /
  `</function>`) as repairable failure and retries (cap 8) instead of exiting;
  skip OpenRouter free early when tools unsupported; require real tool_calls for
  chart/file tasks
- fix(agentic/yolo): AutoLoop OR `RateLimitError` (`free-models-per-day` /
  `Provider returned error`) jumps to Groq/Gemini immediately without burning
  sibling OpenRouter `:free` slots; pass config basename into AutoLoop
- feat(ux): Gemini-style step UX for ReAct/agentic + YOLO AutoLoop —
  Thinking/Executing/Searching spinners and Thought→Action→Observation panels
  (`libs/agent/step_ui.py`)
- feat(agentic): Missing-binary recovery (ffmpeg, etc.) — detect PATH failures,
  optional web search, ask before winget/choco/apt/brew install (yolo+yes
  auto-approves; yolo alone still asks)
- fix(agentic/yolo): AutoLoop free-catalog fallback on `free-models-per-day` /
  OpenRouter 429 / Stealth 502 (skip remaining OR free → Groq/Gemini/HF);
  `/model` and settings-like slash commands open TUI pickers; resolve
  `configs/<name>.json` basenames (e.g. `gemini-2.5-flash`)
- fix(live-session): parse OpenRouter retry-after (cap 60s); skip daily
  free-quota models; YOLO tool_use_failed repair; REPL paste/slash guards;
  `.json` not vision; sandbox HOME/MPLCONFIGDIR/Plotly; user-intent absolute
  writes; neutralize tkinter.mainloop; short litellm errors
- test(fixtures): committed `tests/fixtures/` inputs/expected as live-scenario
  source of truth (`INTERPRETER_TEST_DATA_DIR` workdir copy)
- test(live): easy/medium/complex scenario suite + master
  `scratch/live_scenario_report.md|.html` (FAIL=0 soft-skip)
- fix(agentic): Free-LLM resilience — drop dead OpenRouter `:free` catalog IDs;
  treat 429/RateLimitError as routing failure with capped sleep/retry then
  catalog fallback; keep controller+specialist models in sync after fallback;
  `/model` lists presets; suppress rate-limit traceback dumps
- test(unit): raise `libs/*` + `interpreter.py` coverage to ≥80% (worktree unit
  suite); make data/output/context/local unit modules discoverable under
  `unittest discover -s tests`
- test(integration): expand mocked CLI/pipeline/tools/session coverage (25/25
  worktree integration suite)
- test(live): provider × mode × language matrix + agentic media suite with
  soft-skip (FAIL=0)
- test(interactive): slash commands, REPL loop, session round-trip, live exec,
  streaming, -f prompt coverage (#226)
- feat(security): subprocess/Docker sandbox backends, `--timeout`/`--safety`
  levels, audit log, secret scan, path ignore (#225)
- test(ci): Matrix CI (3 OS × 3 Python), critical-module coverage ≥60%, Codecov
  badge, shared pytest fixtures (#224)
- feat(science): NumPy/SciPy prompting, notebook export, plot themes, ML
  helpers, PDF reports, auto-install (#223)
- feat(data): analysis engine with smart ingest, Auto-EDA, chart gallery,
  multi-format export, SQL, clean (#222)
- feat(local): file attach context (`--attach` / `/file`) + Ollama/`--local`
  first-class support (#221)
- feat(ux): identity repositioning + first-run onboarding as free/local code
  interpreter (#220)
- feat(session): Persistent `--session` / `--list-sessions` / `--delete-session`
  / `/session` across runs (#218)
- feat(output): Structured `--output-format json|markdown|plain` with non-TTY
  auto-JSON (#219)
- feat(codegen): `--mode generate` snippet + `--mode project` scaffold without
  execution (#212)
- feat(tools): Native FS/shell ToolRegistry tools + `--yolo` autonomous tool
  loop + MCP stdio client (`--mcp-server`) (#215)
- feat(ux): Token streaming (`--stream` / `--no-stream`) + multimodal `--image`
  / `/image` input (#216)
- feat(tools): Web search tool `--search` / `/search` (DuckDuckGo / Tavily /
  Serper) (#217)
- docs: OSS comparison table (Open-Interpreter, Aider, OpenCode, Gemini CLI,
  Cline)
- docs: README sections for data analysis, science mode, Ollama/local attach,
  sandbox levels, sessions, output formats
- test: Expanded unit/integration/interactive coverage; live soft-skip for
  quota/rate-limit providers

## v3.3.0 (2026-07-11)

- feat(agentic): Gemini-CLI-style `--gemini-style` ReAct REPL with free/cheap
  LLM catalog (`--free`, `--list-free`, `/free`)
- feat(resilience): Multi-key rotation, token-bucket rate limiter, circuit
  breaker, error classifier, jitter backoff (`libs/key_manager.py`,
  `libs/rate_limiter.py`)
- feat(observability): `logs/metrics.jsonl` plus `/key-status`, `/reload-keys`,
  `/metrics` CLI commands
- feat(ci): Non-interactive `--yes` / `INTERPRETER_YES` one-shot file mode for
  scripted e2e
- feat(agents): Multi-agent pipeline (`--agent`) and ReAct `--agentic`
  coder/executor/reviewer/debugger loop
- docs: Fresh CLI screenshots for help, free catalog, code/chat modes,
  gemini-style, and agentic runs
- test: Resilience smoke suite, mode e2e harness, live soft-skip for
  quota/rate-limit providers

## v3.2.3 (2026-07-11)

- fix(security): Resolved command injection vulnerability in file opening
  (`os.startfile`) on Windows.
- fix(security): Mitigated Path Traversal vulnerability in
  `UtilityManager.get_full_file_path` with strict boundary checks.
- fix(stability): Added timeouts to all external `requests.get` calls in
  PackageManager and UtilityManager to prevent hangs.
- feat(performance): Optimized `ExecutionSafetyManager` by pre-compiling all
  regex patterns.
- feat(ux): Improved Terminal UI fallback prompts with explicit choice brackets
  for non-TTY environments.
- fix: Resolved Ollama/local model API Key extraction and output parsing,
  updated legacy model configurations.
- chore(models): Updated legacy model configs to 2026 stable aliases (e.g.
  `gpt-4.1`, `claude-sonnet-4-6`).
- test: Expanded unit test coverage to **263 tests**, validating security fixes,
  UX enhancements, and API-key robustness.

## v3.2.2 (2026-04-07)

- feat(security): Introduced **secure code sandboxing (enabled by default)**
  with `/sandbox` and `/unsafe` toggles; replaced `--unsafe` with `--sandbox` /
  `--no-sandbox`
- feat(security): Strengthened execution safety with subprocess isolation,
  watchdog fixes, and process-group termination on timeout
- fix(safety): Eliminated multiple safe-mode false positives and blocked new
  unsafe patterns (write bypasses, absolute-path escapes, destructive commands)
- feat(reliability): Increased SAFE mode timeout to **300s** for long-running
  tasks; improved Python detection via `ast.parse`
- chore(release): Refined build/release pipeline (`build_release.sh`) with
  robust error handling and cleaner scripts
- Update interpreter: fix \_execute_generated_output language usage, restore
  sandbox toggle alias, add subprocess security delegation, and increase SAFE
  mode MAX_TIMEOUT to 300s for more robust long‑running code execution
- fix for watchdog timers issues with sandbox
- fix: clean up spacing/newlines in execute_code() if/else blocks
- fix: temp file exec, /unsafe toggle, build_release.sh update
- Implemented /sandbox command
- chore: update build_release.sh with gh release fix and cleaner structure
- fix: use temp file for code exec; add /unsafe toggle; update build_release.sh
- feat: enhance build_release.sh with robust error handling
- feat: rename --unsafe to --sandbox/--no-sandbox; sandbox ON by default
- feat: update build_release.sh with robust helpers, add /unsafe toggle, fix
  unsafe execution timeout
- fix: resolve E999 SyntaxError in \_WRITE_PATTERNS — replace malformed ['\""]
  with ['\"] in single-quoted raw strings
- fix: add missing claude-sonnet-4-6.json config required by
  TestNewConfigFilesFromPR
- fix: two test failures — os.remove \b boundary + .write( on read-handle
- fix(safety): resolve 3 false-positive bugs in safe-mode pattern matching
- fix(code_interpreter): use safety_manager.unsafe_mode instead of
  UNSAFE_EXECUTION attr
- fix(security): resolve all P1/P2 audit issues from PR #26
- fix(interpreter): use \_kill_process_group on timeout + ast.parse for Python
  detection
- fix(safety): add system-level destructive commands to safe-mode block list
- fix: block bare .write() calls on file handles in safe mode
- fix: allow read-only absolute path access in safe mode
- fix(security): P0 absolute-path read escape + artifact export symlink escape
- fix(safety): expand write-mode detection — close binary/pathlib/JS bypasses
  (Bug #2)
- fix(#3 #5): add export_artifacts + unquoted POSIX absolute-path block
- fix(P0): process-group SIGKILL on timeout + Python routing in execute_script

## v3.2.1 (2026-04-07)

- Add mode indicator, strict safe-mode blocking, unsafe confirmations, warnings,
  and improved safety controls for enterprise-grade execution behavior and user
  awareness
- Update the Sandbox and Code Execution
- Refactor execution architecture with python-first model, restore bash
  compatibility for tests, fix decoding bug, enforce output limits, update
  versioning, and correct gitignore entries for logs and newline compliance.
- Overhaul execution architecture with python-first model, sandboxing, and
  improved safety controls
- stop tracking history.json
- Removed /shell command and added Code Execution safety
- fix(safety): block unquoted absolute-path del command (e.g. del D:\Temp\*.txt)
- test: add safety checks for quoted wildcard del commands and mocked LLM repair
  loop for dangerous commands
- fix: block quoted wildcard del commands and add Windows absolute-path delete
  patterns
- feat: enhance safety manager to block absolute-path deletions in various
  contexts
- feat: enhance llm_dispatcher to support local endpoints
- refactor: update configuration files to use JSON format
- feat: fixed package manager issues with retry circuit logic
- Update configuration files to use triple backtick separators for code
  generation
- Merge pull request #24 from haseeb-heaven/feature/sandbox-safety-v3
- chore: update changelog, improve README links, and remove deprecated config
  files
- Merge branch 'feature/sandbox-safety-v3' of
  https://github.com/haseeb-heaven/code-interpreter into
  feature/sandbox-safety-v3
- fix: update model configurations and improve error handling in code execution
- feat: update litellm version and add model normalization utility
- Optimize README: move models to Models.MD, shorten sections
- release: prepare v3.1.0 assets and docs
- feat: Add OpenRouter API support with multiple model configurations
- feat: Introduce execution safety features and self-repair mechanism
- Add configuration files and terminal UI for model selection
- Update LLM catalog to newer models and fix model routing bugs

# Changelog

All notable changes to this project are documented in this file.

## v3.2.0 - April 6, 2026

- Added visual mode indicator in session banner ([SAFE MODE] or [UNSAFE MODE
  ⚠️])
- Implemented strict safety blocking: dangerous operations are hard-blocked in
  SAFE MODE
- Added confirmation prompts for dangerous operations in UNSAFE MODE
- Enhanced user awareness of destructive operations with warning messages
- Improved enterprise-level safety and user control

## v3.1.1 - April 6, 2026

- Refactored execution architecture to Python-first model (replacing
  shell-subprocess as default)
- Enforced 10 KB hard output limit with truncation sentinel
- Minor fixes for timeout handling, output limits, and version alignment.

## v3.1.0 - April 5, 2026

- Added OpenRouter support with multiple paid and free model aliases.
- Added OpenRouter free defaults and switched `OPENROUTER_API_KEY`
  auto-selection to `openrouter/free`.
- Added safer bounded self-repair retries with a max of 3 repair attempts.
- Improved simple intent detection so tasks like printing files in a directory
  generate minimal executable code instead of extra tables or charts.
- Expanded TUI documentation and added fresh screenshots for mode selection,
  model selection, and output flow.
- Added release packaging assets and release notes for the `3.1.0` release.

## v3.0.0 - April 5, 2026

- Added a default execution safety sandbox, dangerous command/code circuit
  breaker, bounded ReACT-style repair retries after failures, clearer execution
  feedback, and polished CLI/TUI runtime output.

## v2.4.1 - April 5, 2026

- Removed deprecated PALM model path, added NVIDIA + Z AI + Browser Use
  providers, added `.env.example`, cleaned project artifacts, and introduced
  `--cli` / `--tui` startup flows with safer interactive error handling.

## v2.4.0 - April 5, 2026

- 2026 model refresh: stable-first OpenAI/Gemini/Anthropic/Groq/DeepSeek catalog
  updates, legacy alias remaps, CLI smoke validator, and expanded unit tests.

## Earlier releases

- v2.3.0 - Added Deepseek V3 and R1 models support now. Added OpenAI o1 Models
  support.
- v2.2.x - Save/Execute commands and scripts, logging fixes, package manager
  fixes, and command improvements.
- v2.1.x - Claude-3 models, Groq Gemma, prompt file mode, OS detection
  improvements, GPT-4o, and file opening improvements.
- v2.0.x - Groq support plus Claude-2 additions.
- v1.x - Core interpreter, file analysis, Gemini Vision, interpreter commands,
  chat mode, and local model support.
