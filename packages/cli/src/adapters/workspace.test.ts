import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunServices } from "@effect/platform-bun";
import { Workspace, WorkspacePath } from "@prodigy/core";
import { layer as workspaceLayer } from "./workspace.ts";

const path = (value: string) => Schema.decodeUnknownSync(WorkspacePath)(value);

layer(BunServices.layer)("workspace adapter", (it) => {
  it.effect("reads, writes, replaces, searches, and rejects traversal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "prodigy-workspace-" });
        const context = yield* Layer.build(workspaceLayer(root));
        const workspace = yield* Workspace.pipe(Effect.provide(context));

        yield* workspace.write(path("src/file.txt"), "alpha\nbeta");
        expect(yield* workspace.read(path("src/file.txt"))).toBe("alpha\nbeta");
        yield* workspace.replaceText(path("src/file.txt"), "beta", "gamma");
        expect(yield* workspace.read(path("src/file.txt"))).toBe("alpha\ngamma");
        expect((yield* workspace.grep({ pattern: "gamma", path: path("src") }))[0]?.line).toBe("gamma");
        expect(yield* workspace.glob({ pattern: "**/*.txt", path: path("src") })).toEqual(["src/file.txt"]);

        expect(() => Schema.decodeUnknownSync(WorkspacePath)("../outside.txt")).toThrow();
      })
    )
  );
});
