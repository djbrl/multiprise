# Project Discovery

Multiprise does not require a Multiprise-specific configuration file. Select the parent project folder and it discovers runnable services from the manifests already present in the repository.

## Supported Manifests

### package.json

Multiprise recursively finds `package.json` files while skipping generated and dependency directories such as `node_modules`, `dist`, `build`, `.git`, and `target`.

It selects the first script that actually exists in this order:

1. `dev`
2. `start`
3. `start:dev`
4. `serve`
5. `develop`
6. `watch`
7. `preview`

Commands follow the detected package manager:

| Package manager | Example command |
| --- | --- |
| npm | `npm run dev` or `npm start` |
| pnpm | `pnpm dev` |
| Yarn | `yarn dev` |
| Bun | `bun run dev` |

The package manager is inferred from lockfiles in the service directory or its selected project root. npm is the fallback.

When Multiprise starts from Finder or the Dock on macOS, it imports `PATH` from the user's interactive login shell before launching services. This makes runtimes installed through Homebrew, fnm, nvm, Cargo, Bun, and similar shell-managed tools available to the packaged app. If a detected runtime is still unavailable, launch stops immediately with a clear runtime-not-found message.

### Cargo.toml

A directory containing `Cargo.toml` is launched with:

```bash
cargo run
```

### Docker Compose

Multiprise recognizes:

- `docker-compose.yml`
- `docker-compose.yaml`
- `compose.yml`
- `compose.yaml`

Compose is shown as a separate optional service and launched with:

```bash
docker compose up -d --build
```

Docker services are not included in the project-level Launch action. They remain manually controlled.

## Parent Projects

The folder selected in the picker is always the tracked project root. Services discovered below it remain grouped under that parent.

If runnable child services exist, a runnable root `package.json` is treated as an orchestration wrapper and is not added as another service. This prevents a root command such as `npm run dev` from launching the same child backend and frontend a second time.

## Service Roles

Roles control port ranges and UI grouping. Multiprise infers them from common directory names and command contents:

- backend: `backend`, `server`, or `api`;
- frontend: `frontend`, `client`, `web`, or `ui`;
- service: anything else.

Known frontend and backend tool names inside scripts provide a fallback when the directory name is generic.

## Injected Environment Variables

Multiprise chooses or validates ports and injects conventional variables into child processes:

- `PORT`
- `SERVICE_PORT`
- `BACKEND_PORT`
- `FRONTEND_PORT`
- `API_PORT`
- `VITE_PORT`
- `VITE_API_PORT`
- `VITE_API_URL`

A frontend launched together with a backend receives `VITE_API_URL` as `http://localhost:<backend-port>`.

## Scan Settings

Settings control:

- maximum recursive scan depth;
- ignored directory names;
- automatic or manual port assignment.

A selected project must contain at least one runnable package script, `Cargo.toml`, or Compose file within the configured scan depth.
