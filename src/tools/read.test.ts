import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"
import { readHandler } from "./read.ts"

const testLayer = bunServicesLayer

describe("read tool", () => {
  it("reads existing file and returns contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString("/tmp/test-read.txt", "Hello, world!")
      const result = yield* readHandler({ filePath: "/tmp/test-read.txt" })
      assert.equal(result, "Hello, world!")
    }).pipe(Effect.provide(testLayer)))

  it("returns error message for non-existent file", () =>
    Effect.gen(function* () {
      const result = yield* readHandler({ filePath: "/tmp/non-existent-file-12345.txt" })
      assert.isTrue(result.includes("No such file") || result.includes("ENOENT"))
    }).pipe(Effect.provide(testLayer)))
})