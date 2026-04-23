## AI Agentic Coding CLI
This project uses the following tools:
- Bun for runtime
- Vitest for running tests
- Effect TypeScript Library. Run `effect-solutions show basics` for basics on how Effect works.

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `./repos/effect-smol` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Effect v4 Beta Notes

This project uses **Effect v4 beta** (`effect@4.0.0-beta.50`).
For the full v3 → v4 migration guide, see [repos/effect-smol/MIGRATION.md](repos/effect-smol/MIGRATION.md).

Key import paths:

| Feature | v3 (stable) | v4 beta (this project) |
|---|---|---|
| CLI | `@effect/cli` | `effect/Unstable/Cli` |
| HTTP | `@effect/platform` | `effect/Unstable/Http` |
| Schema | `@effect/schema` | `effect/Schema` |

Patterns from `effect-solutions show <topic>` apply, but update imports:
- `@effect/cli` → `effect/Unstable/Cli`
- `@effect/schema` → `effect/Schema`
- `import { Schema } from "effect"` → unchanged (Schema is in effect v4 core)

Use `effect-solutions show cli` for CLI patterns, but import from `effect/Unstable/Cli` not `@effect/cli`.

<!-- effect-solutions:end -->

## Testing with Effect and Vitest

See [specs/guides/testing-with-effect.md](specs/guides/testing-with-effect.md) for testing best practices.\
⚠️ NEVER use `bun test` to run tests — always use `bun run test --run`.
