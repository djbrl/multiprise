# Project Discovery

Multiprise does not require a custom configuration file. Select a parent project folder and it discovers runnable services from manifests already present in the repository.

## JavaScript Services

Multiprise recursively finds `package.json` files while skipping generated and dependency directories such as `node_modules`, `dist`, `build`, `.git`, and `target`.

It scores available scripts instead of selecting the first familiar name:

| Tier | Scripts | Behavior |
| --- | --- | --- |
| Preferred | `dev`, `start:dev` | Development servers and watch mode |
| Fallback | `develop`, `watch`, `serve` | Other development entry points |
| Production | `start` | Used when no stronger development command exists |
| Last resort | `preview` | Intended for already-built output |

Commands containing `node dist/`, `node build/`, `next start`, `NODE_ENV=production`, or preview commands receive a production penalty. This prevents a broken compiled `start` script from outranking a working `start:dev` command.

Commands follow the detected package manager:

| Package manager | Example command |
| --- | --- |
| npm | `npm run dev` or `npm start` |
| pnpm | `pnpm dev` |
| Yarn | `yarn dev` |
| Bun | `bun run dev` |

`package.json#packageManager` is authoritative. Multiprise only inspects lockfiles when the field is absent, then falls back to npm.

## Command Ownership

Automatically detected commands keep following `package.json` during rescans. Editing a command in the Services panel marks it as user-owned, so Multiprise will not overwrite it. Choose **Auto** to restore manifest detection.

## Other Manifests

A directory containing `Cargo.toml` is launched with `cargo run`.

Multiprise recognizes `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, and `compose.yaml`. Compose appears as a separate optional service and uses `docker compose up -d --build`. Docker services are not included in project-level Launch.

## Parent Projects

The folder selected in the picker is always the tracked project root. Services discovered below it remain grouped under that parent. If runnable child services exist, a root `package.json` is skipped only when it orchestrates them — it declares `workspaces` (or has `pnpm-workspace.yaml`), its script uses a runner such as `concurrently`, `turbo`, `nx`, `npm-run-all`, `--prefix`, or `--workspace`, or it `cd`s into / names a child service folder. A root that is an app in its own right (for example `vite` at the root with a `docs/` site, or an Express server with a `client/` folder) stays a service. The selected folder itself is always scanned, even when it is named `build` or `dist`.

## Service Roles

Roles control dependency order, port ranges, and UI grouping:

- backend: `backend`, `server`, or `api`;
- frontend: `frontend`, `client`, `web`, or `ui`;
- service: anything else.

Project Launch starts support services first, waits for backends to become ready, and then starts frontends. A failed stage does not stop healthy services.

## Automatic Preparation

When enabled in Settings, Multiprise:

1. checks for dependencies at the detected install root: the folder holding the lockfile or `packageManager` declaration, else a workspace root that declares `workspaces`, else the service folder itself;
2. installs them once when `node_modules` is missing;
3. detects missing compiled targets referenced by the selected command;
4. runs the existing build script when available;
5. starts the selected command only after preparation succeeds.

Preparation output appears in the normal service logs.

## Port Adapters And Readiness

Multiprise injects `PORT`, `SERVICE_PORT`, `BACKEND_PORT`, `FRONTEND_PORT`, and `API_PORT`. Frontends also receive `VITE_API_PORT` and `VITE_API_URL` when a backend port is known.

Environment variables are supplemented by framework adapters. Vite receives explicit `--port` and `--host 127.0.0.1` arguments; Nuxt and supported Cargo frameworks receive their conventional variables.

A PID means only that a service is **starting**. Multiprise marks it **ready** after the assigned port accepts connections. Early exits and readiness timeouts become persistent **failed** states with final logs and recovery guidance.

## Scan Settings

Settings control scan depth, ignored folders, automatic versus manual ports, automatic preparation, and a startup timeout from 10 to 30 seconds.
