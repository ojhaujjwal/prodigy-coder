---
title: Set Up Package Scaffolding and Move Existing CLI
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by: []
---

# Set Up Package Scaffolding and Move Existing CLI

## What to build

Turn the repository into a private Bun-managed workspace with `@prodigy/core` and `@prodigy/cli` package boundaries, then move the current Prodigy application into `@prodigy/cli` as a compatibility scaffold. Developers should be able to run and test the existing CLI from its package while the core package is ready for later SDK implementation.

## Acceptance criteria

- [ ] The repository is a private Bun workspace coordinator with buildable `@prodigy/core` and `@prodigy/cli` package shells, package-local TypeScript and test configuration, consistent workspace lockfile metadata, and explicit root export boundaries.
- [ ] `@prodigy/core` has a curated, runtime-neutral public entrypoint scaffold and does not import Bun, Node built-ins, CLI code, or trigger process startup during import.
- [ ] The existing CLI source, configuration, providers, sessions, tools, approvals, formatters, skills, Bun startup, and tests are owned by `@prodigy/cli`; no production runtime implementation remains in the repository root.
- [ ] Existing documented CLI behavior remains available, including help, session administration, configuration display, output formatting, and the current provider/tool composition.
- [ ] Root validation commands continue to run the package checks successfully with `bun run ci`, and the CLI package tests run with `bun run test --run`.
- [ ] The CLI remains a compatibility scaffold only: rebuilding it against core, implementing the SDK, and deciding the Ralph harness package boundary are explicitly deferred.

## Blocked by

None — can start immediately.
