# Roadmap

Ordered by priority within each section. Check items off as they land.

## Agent-first

Most servers now get started by terminals and coding agents, which never saw the app. These make it useful to them, in this order.

- [x] **See everything running, with no setup** — every dev server on the Mac on Home and in `multiprise running`, with project, worktree and age; leftovers flagged, stopped in one click.
- [x] **Default for agents** — one-click Claude Code connection (MCP server plus a `CLAUDE.md` block), `multiprise up` works in any folder and tracks it first, failures come with their logs, secrets are masked in CLI and MCP output.
- [ ] **Worktrees as first-class** — each with its own ports, env and `branch.project.localhost` URL, its servers stopped and its entry removed when the worktree goes away, plus disk cleanup. Make "where this runs" a property of a service along the way. Server ownership (which session started what) goes here too.
- [ ] **Errors since the last restart** — one call answers "did my change break anything?"
- [ ] **Always on** — start at login, live in the menu bar, with the window as the detail view.
- [ ] **Respect project scripts** — detect `up` scripts and Procfiles, so projects with their own runner lose no services.
- [ ] **Project tasks with a local queue** — `multiprise run test` with the service's cwd and env, limiting how many heavy tasks run at once. Replaces the Project tasks item below.
- [ ] **"Fix with Claude"** — a failed service opens a Claude Code session in its folder with the error and logs filled in.
- [ ] **Remote machines** — run builds and servers on another machine over SSH, behind the same `*.localhost` URLs. Only once the Mac is actually struggling.

## Now

- [x] **Sticky ports** — reuse a service's previous port when it is still free, so its URL survives relaunches.
- [x] **Event stream instead of polling** — push status changes and log lines to the renderer; run `lsof` only when port data is on screen, with a short cache.
- [x] **Durable logs** — larger per-service buffer, collapse repeated lines into a `×N` counter instead of dropping them, write each run to disk so logs survive a crash or an app restart.
- [x] **Menu bar icon** — running-service count, start/stop and open-URL actions, services keep running when the window is closed.
- [x] **Notifications** — when a service crashes, or becomes ready after a slow start.

## Next

- [x] **CLI** — `multiprise up`, `multiprise logs <service> -f`, `multiprise url <service>` over the existing local API.
- [x] **MCP server** — `list_services`, `start`, `stop`, `tail_logs`, `get_url`, so coding agents reuse running services instead of spawning their own.
- [x] **Stable `*.localhost` hostnames** — a local reverse proxy mapping `api.project.localhost` to whatever port the service holds.
- [x] **Service health after startup** — periodic liveness checks so a hung server stops showing as ready.
- [x] **Crash detection with bounded auto-restart** — backoff, capped attempts.
- [x] **Explicit service links** — declare dependencies and reference them in env (`API_URL={{services.api.url}}`); use the graph for start order. Replaces the single backend/frontend role guess.
- [x] **Per-service environment** — persisted env editor, warn when `.env.example` exists without `.env`, secrets in the macOS Keychain.
- [x] **Real Docker state** — read `docker compose ps --format json` instead of a persisted flag; stream `docker compose logs -f`.
- [ ] **Signing, notarization and auto-update** — `electron-updater` against the `latest-mac.yml` electron-builder already produces.

## UI/UX

- [x] **Command palette (⌘K)** — jump to a project, start/stop, open URL, search logs; keyboard shortcuts for common actions.
- [x] **Log viewer** — merged project view with colored service prefixes, stdout/stderr filter, search highlighting, pause/follow, clickable URLs and `file:line` links that open in the editor.
- [x] **Actionable failures** — turn each classified failure's recovery hint into a button (install dependencies, kill PID, pick another port, open `.env`).
- [x] **Drag-and-drop onboarding** — drop a folder on the window, confirm detected services and commands before saving.

## Features

- [ ] **Stacks** — named groups of services across repositories, launched together.
- [x] **CPU and memory per service** — Activity, `multiprise usage` and the `get_usage` MCP tool.
- [ ] **Git branch and working-tree status** — on each project, with optional restart on branch switch.
- [ ] **Project tasks** — one-off test, migrate, seed, build and lint commands with the service's cwd and env.
- [ ] **Browser viewport presets and tab restoration.**
- [ ] **Shareable stack snapshots** — export a stack definition without secrets.

## Code health

- [x] Split `renderer/src/App.vue` into composables (`useProjects`, `useLogs`, `useBrowserTabs`) and components.
- [x] Split `backend/src/server.ts` into route modules.
- [x] Share types between backend and renderer instead of redeclaring them.
- [x] Playwright end-to-end tests driving the Electron app (add project → launch → ready → stop) in CI.
