import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import { makeTempDirectory, platformLayer } from "./helpers.ts";

layer(platformLayer)("core integration harness", (it) => {
  it.effect("it.effect executes an Effect body through a composed real Layer", () =>
    Effect.gen(function* () {
      const path = yield* makeTempDirectory("harness-smoke");
      const fs = yield* FileSystem.FileSystem;

      yield* fs.writeFileString(`${path}/marker.txt`, "ran");
      const content = yield* fs.readFileString(`${path}/marker.txt`);

      expect(content).toBe("ran");
    })
  );

  it.effect("makeTempDirectory removes the directory when its scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const path = yield* Effect.scoped(makeTempDirectory("harness-cleanup"));
      const exists = yield* fs.exists(path);

      expect(exists).toBe(false);
    })
  );
});
