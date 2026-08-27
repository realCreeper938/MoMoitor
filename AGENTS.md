# AGENTS.md

This file is the primary instruction set for AI agents working on the MoMoitor repository. Read it fully before starting any task, and follow it strictly.

## 1. Project Overview

MoMoitor is a Windows system monitor desktop app designed for secondary monitors. It is built with **Python + PyWebview**: a native-JS, framework-free frontend inside a WebView2 window and a Python backend that bridges to the frontend via the pywebview JS API.

Key facts:

- Data sources for hardware metrics: LibreHardwareMonitor (LHM) and HWiNFO shared memory, accessed through a backend abstraction in `momoitor/backends/`.
- Shows CPU/GPU/RAM/network/disk/process metrics, clock/calendar (with lunar calendar, almanac, holidays), weather (QWeather API), music/media control + lyrics, game FPS via RTSS, brightness/volume control, memory cleaning, port/network traffic viewers.
- Two run modes: desktop WebView window (default) and optional server mode (bottle HTTP server for browser/phone access).
- Settings are stored in a schema-versioned `settings.json` (see `momoitor/config.py`, `SCHEMA_VERSION = 2`).

Key architecture layout:

| Path | Responsibility |
|---|---|
| `momoitor/main.py` | Desktop entry point; creates webview window or HTTP server |
| `momoitor/server.py` | Server mode (bottle static + API) |
| `momoitor/config.py` | Settings: paths, `DEFAULT_SETTINGS`, `SCHEMA_VERSION`, legacy migration, `APP_VERSION` (single source of version) |
| `momoitor/common.py` | Cross-module shared utilities (`run_hidden`, `http_get`) |
| `momoitor/api/` | pywebview JS bridge: `Api = ApiCore + HardwareMixin + WeatherMixin + MediaMixin`; factories `create_monitor() / create_window() / create_api()` |
| `momoitor/backends/` | Hardware sources: `base.py` (abstract), `lhm.py`, `hwinfo.py` |
| `momoitor/services/` | Feature services (hardware, system, weather, music, lyrics, fps, traffic, calendar, brightness, volume, etc.) |
| `momoitor/web/` | Frontend: `index.html` + vanilla JS files + CSS |
| `scripts/build.py` | Build/release CLI (`check` / `build` / `run` / `release`) |
| `tests/` | pytest tests |

For deeper architectural detail, consult `docs/` (backends, config, services, js-api, utilities, entrypoint) and the `momoitor-overview` skill.

## 2. Do Not Reinvent the Wheel

- Prefer well-known, maintained libraries and the standard library over hand-rolled implementations.
- The project already depends on: `pywebview`, `pythonnet`, `psutil`, `cryptography`, `PyJWT`, `requests`, `loguru`, `Pillow`, `pycaw`, `winrt-Windows.*` (Windows-only).
- Check `requirements.txt` before reaching for a new dependency. Adding a new dependency is a decision that needs user confirmation first.
- For frontend, the project is intentionally framework-free vanilla JS. Do not introduce a frontend framework or build toolchain without explicit user approval.

## 3. Search GitHub Before Finding Solutions

- Before looking for a solution, or whenever unsure what to do, first call the `gh_grep` MCP server to search GitHub for similar code (existing open-source implementations, patterns, and proven approaches).
- Use what you find as reference or build on it instead of inventing from scratch.

## 4. Reuse Code, Do Not Duplicate It

- Before writing anything new, search for existing functions, modules, and APIs that already do the job (e.g. `momoitor.common.http_get`, `run_hidden`, service functions, frontend global helpers like `t()`, `escapeHtml`).
- Cross-module reuse: `common.py` exists precisely to host shared utilities; add shared logic there rather than copying it into multiple modules.
- If code is already available in a third-party library, use the library.
- Refactor to eliminate duplication, but only when it does not expand scope beyond the task at hand.

## 5. Review Your Own Work After Every Task

- After completing any task (implementation, fix, refactor), re-read your own changes and review them for:
  - Bugs and logic errors.
  - Security issues (input validation, secrets, injection, path traversal, unsafe subprocess/command construction).
  - Edge cases and failure handling (missing devices, missing settings, empty data, disabled features).
  - Resource leaks (threads, subprocesses, file handles, DB connections).
  - Compliance with this file.
- Do not claim a task is complete until this review is done.

## 6. Do Not Act on Your Own — Get User Decisions First

- Do not make assumptions about requirements, scope, or design choices. When in doubt, ask.
- Before starting anything with material consequences, show the user your plan and get approval. Examples:
  - Adding/removing dependencies.
  - Changing the settings schema (version, keys, defaults) or data layout/migration.
  - Large refactors or restructuring.
  - Changing public API surface (pywebview bridge methods).
  - Design decisions with multiple viable options.
- When proposing options, present a recommendation along with alternatives, and let the user decide.

## 7. No Emojis in Code

- Do not use emojis anywhere in code, comments, or documentation, unless the user explicitly asks for them.

## 8. Do Not Deviate from User Goals and Constraints

- Follow the user's stated goal and constraints exactly. Do not silently expand, shrink, or reinterpret scope.
- If a task would require deviating from an explicit constraint, stop and ask first.
- Keep changes minimal and focused on what was requested.

## 9. File Size Limit: 800 Lines Maximum

- No file may exceed 800 lines. If a change would push a file past 800 lines, split it into smaller, well-named modules instead.
- Prefer splitting proactively when a file is near the limit and new code will be added.

## 10. Sub-agents: Use Judiciously

- Use sub-agents for genuinely independent, parallelizable work that reduces overall latency and context usage.
- Do not spawn sub-agents for trivial, sequential, or tightly coupled work; doing so is wasted overhead.
- Never run sub-agents to do work that only duplicates your own in-flight work.

## 11. Modularity and Separation of Concerns

- Keep the existing module structure: API bridge (`momoitor/api/`), hardware backends (`momoitor/backends/`), feature services (`momoitor/services/`), shared utilities (`common.py`), frontend JS modules (`momoitor/web/`).
- Place new code in the module matching its responsibility; do not dump logic into unrelated files.
- Keep frontend logic split across the existing JS module files following their current responsibilities (see `momoitor-overview` skill for the load order and per-file roles).

## 12. Simplest Implementation That Satisfies the Need

- Choose the simplest implementation that meets current requirements.
- Do not add speculative abstraction, over-engineering, or unnecessary configuration layers.
- Add indirection only when it serves an actual, present need (e.g., a second backend or a second consumer already exists).
- YAGNI: do not build features, flags, or abstractions "just in case."

## 13. Prove the Approach Before Implementing

- Before implementing a feature (especially one that introduces a new mechanism, algorithm, or third-party API/strategy), you must first verify the approach is proven and reliable. Satisfy at least one of:
  - A working test or proof-of-concept that exercises the approach and passes (e.g. a quick experiment script that runs end-to-end before wiring it into the app).
  - Substantial real-world evidence that the approach is mature and widely used, backed by concrete references (documentation, official examples, established projects using the same technique).
- Do not ship a feature built on an unverified, speculative, or newly-invented approach. If you cannot prove the approach works or that it is mature, stop and present the uncertainty to the user before proceeding.

## 14. Branching and Merging Workflow

- All development and commits happen on the `dev` branch. Never commit directly to `main`.
- Keep `main`'s commit history clean: never create merge commits or push dev commits directly to `main`. Only merge to `main` when the user explicitly requests it, and always use squash merge (`git checkout main; git merge --squash dev; git commit`) so `main` keeps one clean commit per feature/change.
- After a merge, if the user requests, reset `dev` to point at the new `main`.

## 15. Conventions (Follow the Existing Style)

- Code style: match surrounding code. Python targets >= 3.10, uses `loguru` logging, module docstrings, and type-agnostic plain functions/classes consistent with the codebase.
- The codebase and docs are primarily written in Chinese; keep that consistency for docs and commit messages.
- Commit messages: Chinese, with a type prefix (feat/fix/refactor/revert/chore). See `git log` for reference.
- Verification:
  - Python: `python scripts/build.py check` (compileall) and `python -m pytest -q`.
  - JS: `node --check <file>` on any changed JS file.
- When adding settings options, you must update all of: `config.py` defaults, `settings.js` read/write, `i18n.js` bilingual keys, and the `index.html` control.
- Windows-only code is expected; use `sys.platform == "win32"` guards for anything not Windows-specific.

## 16. What Not to Do

- Do not modify `momoitor/libs/` (third-party .NET DLLs, unmodified distribution).
- Do not commit secrets or API keys.
- Do not commit changes unless the user explicitly asks you to.
- Do not reformat or restructure unrelated code as part of a task.
