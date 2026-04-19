import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"
import { readHandler } from "./read.ts"

const testLayer = bunServicesLayer

const mockContext = {
  preliminary: () => Effect.void,
}

describe("read tool", () => {
  it.effect("reads existing file and returns contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString("/tmp/test-read.txt", "Hello, world!")
      const result = yield* readHandler({ filePath: "/tmp/test-read.txt" }, mockContext)
      assert.equal(result, "Hello, world!")
    }).pipe(Effect.provide(testLayer)))

  it.effect("returns error message for non-existent file", () =>
    Effect.gen(function* () {
      const result = yield* readHandler({ filePath: "/tmp/non-existent-file-12345.txt" }, mockContext).pipe(
        Effect.catch((e) => Effect.succeed(`Error: ${e}`))
      )
      assert.isTrue(result.includes("Error"))
    }).pipe(Effect.provide(testLayer)))
})
