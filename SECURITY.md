# Security

Multiprise runs commands from your projects, listens on loopback addresses, and keeps secrets in the macOS Keychain, so security reports are taken seriously.

## Reporting a vulnerability

Please report it privately with **Report a vulnerability** on the repository's [Security tab](https://github.com/Djbrl/multiprise/security), not in a public issue. Include what you found, how to reproduce it, and the version (`multiprise --version`, or the release you downloaded).

You will get a reply within a week. Once a fix is released, the report can be made public, with credit if you want it.

## Scope

In scope: the app, its local API and hostname proxy, the `multiprise` CLI and MCP server, and the in-app browser's isolation from the app.

Out of scope: what a project's own scripts do when you launch them. Multiprise runs the commands in a project's manifests as you, so review an unfamiliar repository's scripts before launching it, as you would in a terminal.

How the app protects itself is described under [Security and Privacy](./README.md#security-and-privacy) in the README.
