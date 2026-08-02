# Testing `@prodigy/core` — Integration-First

**Principle:** verify behavior end-to-end through the public API, composing real Layers. Unit tests are the exception, reserved for hard-to-cover pure logic and branches that are impractical to reach through the public stream.

This mirrors the `@prodigy/cli` testing setup; extend it rather than inventing a parallel model.

## Two suites

| Suite | Location | Purpose |
|---|---|---|
| integration | `src/__integration__/*.test.ts` | Compose real Layers (in-memory `SessionStore`, test-double `LanguageModel`, scripted toolkit, scripted `HumanInteraction`, temp directories) and drive the public API — e.g. consume `ProdigyAgent.run`'s stream. The default for any behavior. |
| unit | `src/*.test.ts` | Only pure logic or branches not reachable through the public stream: mappings, request validation, error projection/tagging. |

`packages/core/vitest.config.ts` runs them as two serial projects (`unit` excludes `src/__integration__/**`, `integration` includes only it), both non-concurrent, so `bun run test --run` reports both suites.

## Rules

- Always run tests with `bun run test --run` in the package — never `bun test`.
- Use `it.effect`, `layer(...)`, and `expect` from `@effect/vitest`. Never plain `it` for an Effect body — the effect silently never runs. See `specs/guides/testing-with-effect.md`. `@effect/vitest` must be in the package's devDependencies.
- Test doubles are Layers, not module mocks: a test-double `LanguageModel` service over scripted response parts, a scripted toolkit/handler layer, a scripted `HumanInteraction`, and the in-memory `SessionStore`. Tests compose them with `Layer.merge` and install them with `layer(...)`.
- Integration tests assert on the public surface — the stream of `AgentEvent`s, the terminal `AgentResult`, and the typed `AgentError` — never on internal helpers.
- Shared doubles and utilities live in `src/__integration__/helpers.ts` and grow per feature rather than being copy-pasted into tests.

## Test-double boundaries

- **`@prodigy/core`** depends only on the provider-neutral `LanguageModel` contract, so its integration tests install a real conforming `LanguageModel` service built with `LanguageModel.make` over scripted `Response.StreamPartEncoded` parts — a contract-boundary double, not a hand-rolled fake. It is fast, deterministic, and network-free.
- **Mock provider APIs over HTTP** (e.g. the CLI's `createMockOpenAIServer` SSE server) belong to packages that own providers (`@prodigy/cli`). They validate a specific adapter rather than core and would drag provider and HTTP-client devDependencies into `@prodigy/core`. Core never uses them; when the CLI is rebuilt on core, its existing mock server validates core through the real adapter.

## When to write a unit test instead

Write a unit test only when the behavior is a pure function or a branch impractical to exercise through the public stream, e.g.:

- provider finish value → `AgentFinishReason` mapping,
- `ModelError` reason → retryability derivation,
- `RunRequest` validation rules,
- error-family tagging and projection.

If the behavior is observable through an integration test, write the integration test.
