import { describe, it, expect } from "@effect/vitest"
import { Effect } from "effect"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"
import { shellHandler } from "./shell.ts"

const testLayer = bunServicesLayer

const mockContext = {
  preliminary: () => Effect.void,
}

describe("shell tool", () => {
  it.effect("executes echo hello and returns output", () =>
    Effect.gen(function* () {
      const result = yield* shellHandler({ command: "echo hello" }, mockContext)
      expect(result).toBe("hello\n")
    }).pipe(Effect.provide(testLayer)))

  it.effect("command fails with non-zero exit, returns error message", () =>
    Effect.gen(function* () {
      const result = yield* shellHandler({ command: "exit 1" }, mockContext)
      expect(result.includes("Command failed")).toBe(true)
      expect(result.includes("exit code 1")).toBe(true)
    }).pipe(Effect.provide(testLayer)))

  it.effect("captures both stdout and stderr", () =>
    Effect.gen(function* () {
      const result = yield* shellHandler({ command: "echo stdout; echo stderr >&2" }, mockContext)
      expect(result.includes("stdout")).toBe(true)
      expect(result.includes("stderr")).toBe(true)
    }).pipe(Effect.provide(testLayer)))
})
