import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"
import { shellHandler } from "./shell.ts"

const testLayer = bunServicesLayer

const mockContext = {
  preliminary: () => Effect.void,
}

describe("shell tool", () => {
  it("executes echo hello and returns output", () =>
    Effect.gen(function* () {
      const result = yield* shellHandler({ command: "echo hello" }, mockContext)
      assert.equal(result, "hello")
    }).pipe(Effect.provide(testLayer)))

  it("command fails with non-zero exit, returns error message", () =>
    Effect.gen(function* () {
      const result = yield* shellHandler({ command: "exit 1" }, mockContext)
      assert.isTrue(result.includes("Command failed"))
      assert.isTrue(result.includes("exit code 1"))
    }).pipe(Effect.provide(testLayer)))

  it("captures both stdout and stderr", () =>
    Effect.gen(function* () {
      const result = yield* shellHandler({ command: "echo stdout && echo stderr >&2" }, mockContext)
      assert.isTrue(result.includes("stdout"))
      assert.isTrue(result.includes("stderr"))
    }).pipe(Effect.provide(testLayer)))
})
