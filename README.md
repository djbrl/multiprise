# Multiprise

Multiprise is a macOS desktop control center for developers working across multiple local projects. Track each project once, then launch services, assign collision-free ports, inspect processes, follow color-coded logs, and open running apps in tabbed browser views from one place.

## Features

- Track parent project folders through `multiprise.json`.
- Launch npm, Bun, Rust/Cargo, and manually controlled Docker services.
- Allocate unused frontend and backend ports automatically.
- Start complete projects or control services individually.
- Inspect active ports, process ownership, PIDs, and external instances.
- Search and filter color-coded service logs.
- Browse running services in sandboxed tabs with navigation and docked DevTools.
- Open projects in VS Code, with Finder as a fallback.
- Light and dark themes.

## Development

Requirements: Node.js 20 or newer and macOS for Electron packaging.

```bash
npm install
npm run dev
```

The development launcher selects available backend and renderer ports automatically. Manual overrides remain available:

```bash
npm run dev -- --backend-port 4000 --frontend-port 5174
```

## Build

```bash
npm run build:api
npm run build:web
```

Create the macOS `.app`, `.dmg`, and `.zip` artifacts:

```bash
npm run package:mac
```

Artifacts are written to `release/`.

## Project Configuration

Tracked projects declare their services in a `multiprise.json` file at the project root. See [`MULTIPRISE_JSON.md`](./MULTIPRISE_JSON.md) for the complete format and supported environment tokens.

Existing `vibemanager.json` files remain readable for backward compatibility, but new projects should use `multiprise.json`.
