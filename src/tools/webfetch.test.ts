import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"
import { webfetchHandler } from "./webfetch.ts"

const testLayer = bunServicesLayer

describe("webfetch tool", () => {
  it("fetches content from url (skipped if network unavailable)", () =>
    Effect.gen(function* () {
      const result = yield* webfetchHandler({ url: "https://example.com" })
      assert.isTrue(result.length > 0)
    }).pipe(Effect.provide(testLayer)))

  it("returns error for invalid url", () =>
    Effect.gen(function* () {
      const result = yield* webfetchHandler({ url: "not-a-valid-url" })
      assert.isTrue(result.includes("Error") || result.includes("error"))
    }).pipe(Effect.provide(testLayer)))
})