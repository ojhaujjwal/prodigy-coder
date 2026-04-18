import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "@effect/vitest"

describe("index", () => {
  it.effect("should pass a basic test", () =>
    Effect.gen(function* () {
      const result = yield* Effect.succeed(true)
      assert.isTrue(result)
    }))
})
