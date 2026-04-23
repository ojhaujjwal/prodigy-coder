# Testing with Effect and Vitest

**CRITICAL:** When writing tests that return `Effect` values, you MUST use `it.effect` from `@effect/vitest`, NOT plain `it`.

Plain `it()` creates a synchronous test that captures the `Effect` value but never executes it — the test appears to pass but nothing actually runs. `it.effect` properly executes the Effect within the test runtime.

```ts
import { expect } from "@effect/vitest";

// WRONG — Effect is never executed, test falsely passes:
it("should do something", () => {
  const result = Effect.gen(function* () {
    const x = yield* someEffect;
    expect(x).toBe(42);
  })
  // This returns an Effect but it never runs!
});

// CORRECT — Effect is properly executed:
it.effect("should do something", () =>
  Effect.gen(function* () {
    const x = yield* someEffect;
    expect(x).toBe(42);
  })
);
```

**Rules:**
- Any test body that uses `Effect.gen`, `Effect.andThen`, `Effect.flatMap`, or any Effect-returning function MUST use `it.effect`
- Plain `it()` is ONLY for synchronous tests with no Effects
- To provide Layer dependencies, use `it.effect(...).pipe(Effect.provide(someLayer))`
- To provide multiple layers, use `it.effect(...).pipe(Effect.provide(Layer.merge(layerA, layerB)))`

**Verifying tests actually run:** After writing an Effect test, temporarily add a `Console.log("test ran")` inside the Effect and confirm it appears in test output. If it doesn't, you're using `it` instead of `it.effect`.
