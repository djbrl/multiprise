# Roadmap

Ordered by priority within each section. Check items off as they land.

## Now

- [x] **Sticky ports** — reuse a service's previous port when it is still free, so its URL survives relaunches.
- [x] **Event stream instead of polling** — push status changes and log lines to the renderer; run `lsof` only when port data is on screen, with a short cache.
- [x] **Durable logs** — larger per-service buffer, collapse repeated lines into a `×N` counter instead of dropping them, write each run to disk so logs survive a crash or an app restart.
- [x] **Menu bar icon** — running-service count, start/stop and open-URL actions, services keep running when the window is closed.
- [x] **Notifications** — when a service crashes, or becomes ready after a slow start.

## Next

- [x] **CLI** — `multiprise up`, `multiprise logs <service> -f`, `multiprise url <service>` over the existing local API.
- [x] **MCP server** — `list_services`, `start`, `stop`, `tail_logs`, `get_url`, so coding agents reuse running services instead of spawning their own.
- [ ] **Stable `*.localhost` hostnames** — a local reverse proxy mapping `api.project.localhost` to whatever port the service holds.
- [ ] **Service health after startup** — periodic liveness checks so a hung server stops showing as ready.
- [ ] **Crash detection with bounded auto-restart** — backoff, capped attempts.
- [ ] **Explicit service links** — declare dependencies and reference them in env (`API_URL={{services.api.url}}`); use the graph for start order. Replaces the single backend/frontend role guess.
- [ ] **Per-service environment** — persisted env editor, warn when `.env.example` exists without `.env`, secrets in the macOS Keychain.
- [ ] **Real Docker state** — read `docker compose ps --format json` instead of a persisted flag; stream `docker compose logs -f`.
- [ ] **Signing, notarization and auto-update** — `electron-updater` against the `latest-mac.yml` electron-builder already produces.

## UI/UX

- [ ] **Command palette (⌘K)** — jump to a project, start/stop, open URL, search logs; keyboard shortcuts for common actions.
- [ ] **Log viewer** — merged project view with colored service prefixes, stdout/stderr filter, search highlighting, pause/follow, clickable URLs and `file:line` links that open in the editor.
- [ ] **Actionable failures** — turn each classified failure's recovery hint into a button (install dependencies, kill PID, pick another port, open `.env`).
- [ ] **Drag-and-drop onboarding** — drop a folder on the window, confirm detected services and commands before saving.

## Features

- [ ] **Stacks** — named groups of services across repositories, launched together.
- [ ] **CPU and memory per service** — sampled per process group.
- [ ] **Git branch and working-tree status** — on each project, with optional restart on branch switch.
- [ ] **Project tasks** — one-off test, migrate, seed, build and lint commands with the service's cwd and env.
- [ ] **Browser viewport presets and tab restoration.**
- [ ] **Shareable stack snapshots** — export a stack definition without secrets.

## Code health

- [ ] Split `renderer/src/App.vue` into composables (`useProjects`, `useLogs`, `useBrowserTabs`) and components.
- [ ] Split `backend/src/server.ts` into route modules.
- [ ] Share types between backend and renderer instead of redeclaring them.
- [ ] Playwright end-to-end tests driving the Electron app (add project → launch → ready → stop) in CI.
