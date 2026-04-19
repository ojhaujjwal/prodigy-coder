import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"
import { grepHandler } from "./grep.ts"

const testLayer = bunServicesLayer

const mockContext = {
  preliminary: () => Effect.void,
}

describe("grep tool", () => {
  it("finds matches in file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString("/tmp/test-grep.txt", "line1: hello\nline2: world\nline3: hello again")
      const result = yield* grepHandler({ pattern: "hello", path: "/tmp/test-grep.txt" }, mockContext)
      assert.isTrue(result.length >= 2)
    }).pipe(Effect.provide(testLayer)))

  it("returns empty array when no matches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString("/tmp/test-grep2.txt", "line1: hello\nline2: world")
      const result = yield* grepHandler({ pattern: "goodbye", path: "/tmp/test-grep2.txt" }, mockContext)
      assert.isArray(result)
    }).pipe(Effect.provide(testLayer)))
})
