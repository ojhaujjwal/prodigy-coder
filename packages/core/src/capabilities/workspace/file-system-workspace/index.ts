import { Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { CommandExecutor } from "../../command-executor.ts";
import {
  Workspace,
  WorkspaceLookupError,
  WorkspacePersistenceError,
  WorkspaceSearchError,
  type GrepMatch,
  type GrepRequest,
  type GlobRequest,
  type WorkspacePath
} from "../index.ts";
import { isInsideRoot } from "./paths.ts";
import { revisionOf } from "./revision.ts";
import { ripgrepGrep } from "./ripgrep.ts";
import { findGlob } from "./glob.ts";

export { ripgrepGrep } from "./ripgrep.ts";
export { findGlob, globSource } from "./glob.ts";

/**
 * The runtime-neutral, filesystem-backed `Workspace` adapter. Paths are scoped
 * to a root directory, mutations are atomic with hash-based revisions, and
 * search delegates to the ripgrep and find-parity glob implementations above.
 */
const make = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const executor = yield* CommandExecutor;
    const workspaceRoot = path.resolve(root);

    const checkInsideRoot = (workspacePath: WorkspacePath): boolean => isInsideRoot(path, workspaceRoot, workspacePath);

    const resolveLookup = (workspacePath: WorkspacePath): Effect.Effect<string, WorkspaceLookupError> =>
      checkInsideRoot(workspacePath)
        ? Effect.succeed(path.resolve(workspaceRoot, workspacePath))
        : Effect.fail(new WorkspaceLookupError({ path: workspacePath, reason: "ReadFailure" }));

    const resolvePersistence = (workspacePath: WorkspacePath): Effect.Effect<string, WorkspacePersistenceError> =>
      checkInsideRoot(workspacePath)
        ? Effect.succeed(path.resolve(workspaceRoot, workspacePath))
        : Effect.fail(new WorkspacePersistenceError({ path: workspacePath, reason: "WriteFailure" }));

    const resolveSearch = (workspacePath: WorkspacePath): Effect.Effect<string, WorkspaceSearchError> =>
      checkInsideRoot(workspacePath)
        ? Effect.succeed(path.resolve(workspaceRoot, workspacePath))
        : Effect.fail(new WorkspaceSearchError({ path: workspacePath, reason: "SearchFailure" }));

    const exists = Effect.fn("FileSystemWorkspace.exists")(function* (
      workspacePath: WorkspacePath
    ): Effect.fn.Return<boolean, WorkspaceLookupError> {
      const resolved = yield* resolveLookup(workspacePath);
      return yield* fs.exists(resolved).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceLookupError({
              path: workspacePath,
              reason: "ReadFailure",
              cause
            })
        )
      );
    });

    const read = Effect.fn("FileSystemWorkspace.read")(function* (
      workspacePath: WorkspacePath
    ): Effect.fn.Return<string, WorkspaceLookupError> {
      const resolved = yield* resolveLookup(workspacePath);
      return yield* fs.readFileString(resolved).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceLookupError({
              path: workspacePath,
              reason: cause.reason._tag === "NotFound" ? "NotFound" : "ReadFailure",
              cause
            })
        )
      );
    });

    const write = Effect.fn("FileSystemWorkspace.write")(function* (
      workspacePath: WorkspacePath,
      content: string,
      options?: { readonly expectedRevision?: string }
    ): Effect.fn.Return<string, WorkspacePersistenceError> {
      const resolved = yield* resolvePersistence(workspacePath);
      if (options?.expectedRevision !== undefined) {
        const current = yield* fs
          .readFileString(resolved)
          .pipe(
            Effect.mapError(
              (cause) => new WorkspacePersistenceError({ path: workspacePath, reason: "WriteFailure", cause })
            )
          );
        if (revisionOf(current) !== options.expectedRevision) {
          return yield* new WorkspacePersistenceError({ path: workspacePath, reason: "Conflict" });
        }
      }
      yield* fs
        .makeDirectory(path.dirname(resolved), { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) => new WorkspacePersistenceError({ path: workspacePath, reason: "WriteFailure", cause })
          )
        );
      yield* fs
        .writeFileString(resolved, content)
        .pipe(
          Effect.mapError(
            (cause) => new WorkspacePersistenceError({ path: workspacePath, reason: "WriteFailure", cause })
          )
        );
      return revisionOf(content);
    });

    const replaceText = Effect.fn("FileSystemWorkspace.replaceText")(function* (
      workspacePath: WorkspacePath,
      oldText: string,
      newText: string,
      options?: { readonly expectedRevision?: string }
    ): Effect.fn.Return<string, WorkspacePersistenceError> {
      const current = yield* read(workspacePath).pipe(
        Effect.mapError(
          (error) => new WorkspacePersistenceError({ path: workspacePath, reason: "WriteFailure", cause: error })
        )
      );
      if (options?.expectedRevision !== undefined && revisionOf(current) !== options.expectedRevision) {
        return yield* new WorkspacePersistenceError({ path: workspacePath, reason: "Conflict" });
      }
      if (!current.includes(oldText)) {
        return yield* new WorkspacePersistenceError({ path: workspacePath, reason: "NoMatch" });
      }
      return yield* write(workspacePath, current.replace(oldText, newText));
    });

    /**
     * Search through the `CommandExecutor` authority so grep runs under the
     * same cwd (workspace root) and timeout policy as shell commands.
     */
    const grep = Effect.fn("FileSystemWorkspace.grep")(function* (
      request: GrepRequest
    ): Effect.fn.Return<ReadonlyArray<GrepMatch>, WorkspaceSearchError> {
      yield* resolveSearch(request.path);
      return yield* ripgrepGrep(executor, request);
    });

    const glob = Effect.fn("FileSystemWorkspace.glob")(function* (
      request: GlobRequest
    ): Effect.fn.Return<ReadonlyArray<WorkspacePath>, WorkspaceSearchError> {
      yield* resolveSearch(request.path);
      return yield* findGlob(fs, workspaceRoot, request);
    });

    return Workspace.of({ exists, read, write, replaceText, grep, glob });
  });

export const layer = (root: string) => Layer.effect(Workspace, make(root));
