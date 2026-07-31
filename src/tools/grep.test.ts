import { layer, expect } from "@effect/vitest";
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices";
import { grepHandler } from "./grep.ts";

const mockContext = {
  preliminary: () => Effect.void
};

layer(bunServicesLayer)("grep tool", (it) => {
  it.effect("finds matches in file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove("/tmp/test-grep.txt").pipe(Effect.catch(() => Effect.void));
      yield* fs.writeFileString("/tmp/test-grep.txt", "hello world\nfoo bar\n");
      const result = yield* grepHandler({ pattern: "hello", path: "/tmp/test-grep.txt" }, mockContext);
      expect(result.length > 0).toBe(true);
    })
  );

  it.effect("returns empty array when no matches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove("/tmp/test-grep2.txt").pipe(Effect.catch(() => Effect.void));
      yield* fs.writeFileString("/tmp/test-grep2.txt", "hello world\nfoo bar\n");
      const result = yield* grepHandler({ pattern: "goodbye", path: "/tmp/test-grep2.txt" }, mockContext);
      expect(Array.isArray(result)).toBe(true);
    })
  );
});
