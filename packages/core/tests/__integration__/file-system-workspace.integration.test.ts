import { describe, expect, it, layer } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { BunFileSystem, BunServices } from "@effect/platform-bun";
import {
  CommandExecutor,
  CommandExecuteError,
  Workspace,
  WorkspacePath,
  fileSystemWorkspaceLayer,
  type CommandRequest,
  type CommandResult
} from "@prodigy/core";
import { WorkspaceSearchError } from "../../src/capabilities/workspace.ts";
import { findGlob, ripgrepGrep } from "../../src/capabilities/file-system-workspace.ts";

const path = (value: string) => Schema.decodeUnknownSync(WorkspacePath)(value);

describe("ripgrepGrep", () => {
  /** A recording executor that answers every execute with the given result. */
  const fakeExecutor = (result: CommandResult) => {
    const requests: Array<ReadonlyArray<string>> = [];
    const executor = CommandExecutor.of({
      execute: (request) =>
        Effect.sync(() => {
          requests.push(request.argv);
          return result;
        })
    });
    return { executor, requests };
  };

  it.effect("parses rg output into branded matches with line numbers", () =>
    Effect.gen(function* () {
      const { executor, requests } = fakeExecutor({
        exitCode: 0,
        stdout: "src/alpha.ts:2:const gamma = 1\nsrc/beta.txt:10:gamma again\n",
        stderr: ""
      });

      const matches = yield* ripgrepGrep(executor, { pattern: "gamma", path: path("src") });

      expect(matches).toEqual([
        { path: path("src/alpha.ts"), lineNumber: 2, line: "const gamma = 1" },
        { path: path("src/beta.txt"), lineNumber: 10, line: "gamma again" }
      ]);
      expect(requests[0]).toEqual([
        "rg",
        "--hidden",
        "--no-heading",
        "--line-number",
        "--with-filename",
        "-e",
        "gamma",
        "--",
        "src"
      ]);
    })
  );

  it.effect("keeps content containing colon-digit-colon sequences intact", () =>
    Effect.gen(function* () {
      const { executor } = fakeExecutor({
        exitCode: 0,
        stdout: "src/a.ts:3:ratio is 1:2:3 here\n",
        stderr: ""
      });

      const matches = yield* ripgrepGrep(executor, { pattern: "ratio", path: path(".") });

      expect(matches[0]?.lineNumber).toBe(3);
      expect(matches[0]?.line).toBe("ratio is 1:2:3 here");
    })
  );

  it.effect("returns no matches on rg's exit code 1 without failing", () =>
    Effect.gen(function* () {
      const { executor } = fakeExecutor({ exitCode: 1, stdout: "", stderr: "" });

      const matches = yield* ripgrepGrep(executor, { pattern: "nothing", path: path(".") });

      expect(matches).toEqual([]);
    })
  );

  it.effect("fails with WorkspaceSearchError when rg reports a real failure", () =>
    Effect.gen(function* () {
      const { executor } = fakeExecutor({ exitCode: 2, stdout: "", stderr: "unrecognized flag" });

      const failure = yield* ripgrepGrep(executor, { pattern: "x", path: path(".") }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(WorkspaceSearchError);
      expect(failure.reason).toBe("SearchFailure");
    })
  );

  it.effect("skips lines whose paths are not valid workspace-relative paths", () =>
    Effect.gen(function* () {
      const { executor } = fakeExecutor({
        exitCode: 0,
        stdout: "/absolute/outside.ts:1:nope\nsrc/ok.ts:4:kept\n",
        stderr: ""
      });

      const matches = yield* ripgrepGrep(executor, { pattern: "x", path: path(".") });

      expect(matches).toEqual([{ path: path("src/ok.ts"), lineNumber: 4, line: "kept" }]);
    })
  );
});

/**
 * Fixture layout under a fresh temp root:
 *   a.ts  .hidden.ts  notes.md  dir.ts/ (directory)
 *   src/b.ts  src/deep/c.ts
 */
const globInFixture = (pattern: string, from: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "prodigy-find-glob-" });
      const write = (name: string) => fs.writeFileString(`${root}/${name}`, "");
      yield* write("a.ts");
      yield* write(".hidden.ts");
      yield* write("notes.md");
      yield* fs.makeDirectory(`${root}/dir.ts`);
      yield* fs.makeDirectory(`${root}/src`);
      yield* write("src/b.ts");
      yield* fs.makeDirectory(`${root}/src/deep`);
      yield* write("src/deep/c.ts");
      const matches = yield* findGlob(fs, root, { pattern, path: path(from) });
      return matches.map(String);
    })
  );

layer(BunFileSystem.layer)("findGlob", (it) => {
  it.effect("matches basenames recursively like `find -name`, files only, hidden included", () =>
    Effect.gen(function* () {
      expect(yield* globInFixture("*.ts", ".")).toEqual([".hidden.ts", "a.ts", "src/b.ts", "src/deep/c.ts"]);
    })
  );

  it.effect("never matches directories even when names fit the pattern", () =>
    Effect.gen(function* () {
      expect(yield* globInFixture("dir.*", ".")).toEqual([]);
    })
  );

  it.effect("restricts the search to the requested subtree", () =>
    Effect.gen(function* () {
      expect(yield* globInFixture("*.ts", "src")).toEqual(["src/b.ts", "src/deep/c.ts"]);
    })
  );

  it.effect("supports ? and character classes including negation", () =>
    Effect.gen(function* () {
      // One-character basenames at any depth; `.hidden.ts` needs two.
      expect(yield* globInFixture("?.ts", ".")).toEqual(["a.ts", "src/b.ts", "src/deep/c.ts"]);
      // `[ab]` restricts the leading character.
      expect(yield* globInFixture("[ab].ts", ".")).toEqual(["a.ts", "src/b.ts"]);
      // `[!.]` excludes the hidden file that plain `*.ts` includes.
      expect(yield* globInFixture("[!.]*.ts", ".")).toEqual(["a.ts", "src/b.ts", "src/deep/c.ts"]);
    })
  );

  it.effect("matches separator patterns against base-relative paths", () =>
    Effect.gen(function* () {
      expect(yield* globInFixture("src/**/*.ts", ".")).toEqual(["src/b.ts", "src/deep/c.ts"]);
    })
  );

  it.effect("fails with WorkspaceSearchError when the search path is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const failure = yield* findGlob(fs, ".", { pattern: "*.ts", path: path("no/such/dir") }).pipe(Effect.flip);
      expect(failure.reason).toBe("SearchFailure");
    })
  );
});

/**
 * A test-local `CommandExecutor` rooted at the given directory, mirroring the
 * runtime-bound executor adapters so grep can run real ripgrep under the
 * workspace root.
 */
const makeCommandExecutorLayer = (root: string) =>
  Layer.effect(
    CommandExecutor,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const pathService = yield* Path.Path;
      const workspaceRoot = pathService.resolve(root);

      const execute = Effect.fn("TestCommandExecutor.execute")(function* (
        request: CommandRequest
      ): Effect.fn.Return<CommandResult, CommandExecuteError> {
        const executable = request.argv[0];
        if (executable === undefined) {
          return yield* new CommandExecuteError({ reason: "Spawn", cause: new Error("Command argv is empty") });
        }
        const command = ChildProcess.make(executable, request.argv.slice(1), {
          cwd: pathService.resolve(workspaceRoot, request.cwd ?? ".")
        });
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner
              .spawn(command)
              .pipe(Effect.mapError((cause) => new CommandExecuteError({ reason: "Spawn", cause })));
            const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
              Stream.mkString(Stream.decodeText(stream));
            const result = yield* Effect.all(
              { stdout: collect(handle.stdout), stderr: collect(handle.stderr), exitCode: handle.exitCode },
              { concurrency: "unbounded" }
            );
            return { exitCode: Number(result.exitCode), stdout: result.stdout, stderr: result.stderr };
          })
        ).pipe(
          Effect.mapError((cause) =>
            cause._tag === "CommandExecuteError" ? cause : new CommandExecuteError({ reason: "Transport", cause })
          )
        );
      });

      return CommandExecutor.of({ execute });
    })
  );

layer(BunServices.layer)("fileSystemWorkspace", (it) => {
  it.effect("reads, writes, replaces, searches, and rejects traversal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "prodigy-workspace-" });
        const context = yield* Layer.build(
          fileSystemWorkspaceLayer(root).pipe(Layer.provide(makeCommandExecutorLayer(root)))
        );
        const workspace = yield* Workspace.pipe(Effect.provide(context));

        yield* workspace.write(path("src/file.txt"), "alpha\nbeta");
        expect(yield* workspace.read(path("src/file.txt"))).toBe("alpha\nbeta");
        yield* workspace.replaceText(path("src/file.txt"), "beta", "gamma");
        expect(yield* workspace.read(path("src/file.txt"))).toBe("alpha\ngamma");
        const matches = yield* workspace.grep({ pattern: "gamma", path: path("src") });
        expect(matches[0]?.lineNumber).toBe(2);
        expect(matches[0]?.line).toBe("gamma");
        // find-parity glob: a separator-free pattern matches basenames at
        // every depth.
        yield* workspace.write(path("src/nested/deep.txt"), "x");
        expect(yield* workspace.glob({ pattern: "**/*.txt", path: path("src") })).toEqual([
          "src/file.txt",
          "src/nested/deep.txt"
        ]);
        expect(yield* workspace.glob({ pattern: "*.txt", path: path(".") })).toEqual([
          "src/file.txt",
          "src/nested/deep.txt"
        ]);

        expect(() => Schema.decodeUnknownSync(WorkspacePath)("../outside.txt")).toThrow();
      })
    )
  );
});
