# Multiprise Config (multiprise.json)

Place a `multiprise.json` file in the **repo root** (the parent folder of `backend/` and `frontend/`).
Multiprise reads this file to determine how to start services and which environment variables to inject.

## Required Structure

```json
{
  "services": [
    {
      "name": "backend",
      "cwd": "backend",
      "start": "npm run dev",
      "env": {
        "PORT": "{{BACKEND_PORT}}"
      }
    },
    {
      "name": "frontend",
      "cwd": "frontend",
      "start": "npm run dev",
      "env": {
        "VITE_API_URL": "http://localhost:{{BACKEND_PORT}}"
      }
    }
  ]
}
```

## Field Reference

- `services` (required)
  - List of service definitions.
- `name` (optional)
  - Human-friendly name for your service.
- `cwd` (recommended)
  - Working directory **relative to repo root**.
  - This is how Multiprise matches a tracked project to a service entry.
- `start` (required)
  - Command to run for the service (e.g. `npm run dev`, `pnpm dev`, `cargo run`).
- `env` (optional)
  - Environment variables to inject when running `start`.
  - Supports template tokens (see below).

## Supported Template Tokens

You can use these tokens inside `env` values, and Multiprise will replace them at start time:

- `{{PORT}}` or `{{SERVICE_PORT}}` — the port chosen for the service being started.
- `{{BACKEND_PORT}}` — the chosen backend port.
- `{{FRONTEND_PORT}}` — the chosen frontend port.

If a token cannot be resolved at start time, Multiprise will error with a clear message.

## Single-Service Repos

If your repo has only one service, you can omit `cwd`:

```json
{
  "services": [
    {
      "name": "app",
      "start": "cargo run",
      "env": {
        "PORT": "{{PORT}}"
      }
    }
  ]
}
```

## Notes

- `multiprise.json` must be valid JSON.
- Multiprise expects the file at the **repo root**.
- The `start` command is always taken from `multiprise.json` (not from the UI).
- You can still set ports in the UI; those values will be injected into the template tokens.
