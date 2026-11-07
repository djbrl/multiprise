# Contributing

Thanks for helping. Issues and pull requests are welcome, small ones especially.

## Before you start

- **Bugs:** open an issue with what you did, what happened, and the service's output if a launch failed (`multiprise logs <service>`). A project layout that is discovered wrongly is easiest to fix with the folder tree and its `package.json` scripts, `Cargo.toml` or Compose file.
- **Features:** open an issue first for anything larger than a fix, so we can agree on the shape before you spend time on it. [`upcoming-features.md`](./upcoming-features.md) lists what is planned.
- **Security issues:** don't open an issue; see [SECURITY.md](./SECURITY.md).

## Working on it

You need macOS and Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev          # the orchestrator, the renderer and Electron, with free dev ports
```

Run the CLI from source with `npm run cli -- <command>`. The app run from source keeps its projects in `backend/data/`, separate from an installed Multiprise.

## Checks

Pull requests run these in CI; run them before pushing:

```bash
npm run typecheck    # tsc for the backend, vue-tsc for the renderer
npm run test:backend # node:test suites in backend/test
npm run test:e2e     # Playwright driving the Electron app with a throwaway profile
```

A change in behaviour comes with a test: the backend suites use small fixture projects and stand-ins (a fake `docker`, local servers), and only ever stop processes they started.

## Style

- Match the code around you: TypeScript, Vue 3 `<script setup>`, Tailwind classes with the theme's CSS variables (`renderer/src/theme.ts`), no new dependency without a reason.
- Comments say why, not what.
- Interface text is plain and short, and says what happens rather than what something is called.
- The README describes how the app behaves; update it with any change a user would notice.

By contributing you agree that your work is released under the [MIT License](./LICENSE).
