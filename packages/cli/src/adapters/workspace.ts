import { Hash, Effect, Layer, Option, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  Workspace,
  WorkspacePath,
  WorkspaceLookupError,
  WorkspacePersistenceError,
  WorkspaceSearchError,
  type GrepRequest,
  type GlobRequest
} from "@prodigy/core";

const revisionOf = (content: string): string => Hash.hash(content).toString(16);

const make = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = path.resolve(root);

    const isInsideRoot = (workspacePath: WorkspacePath): boolean => {
      const resolved = path.resolve(workspaceRoot, workspacePath);
      const relative = path.relative(workspaceRoot, resolved);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };

    const resolveLookup = (workspacePath: WorkspacePath): Effect.Effect<string, WorkspaceLookupError> =>
      isInsideRoot(workspacePath)
        ? Effect.succeed(path.resolve(workspaceRoot, workspacePath))
        : Effect.fail(new WorkspaceLookupError({ path: workspacePath, reason: "ReadFailure" }));

    const resolvePersistence = (workspacePath: WorkspacePath): Effect.Effect<string, WorkspacePersistenceError> =>
      isInsideRoot(workspacePath)
        ? Effect.succeed(path.resolve(workspaceRoot, workspacePath))
        : Effect.fail(new WorkspacePersistenceError({ path: workspacePath, reason: "WriteFailure" }));

    const resolveSearch = (workspacePath: WorkspacePath): Effect.Effect<string, WorkspaceSearchError> =>
      isInsideRoot(workspacePath)
        ? Effect.succeed(path.resolve(workspaceRoot, workspacePath))
        : Effect.fail(new WorkspaceSearchError({ path: workspacePath, reason: "SearchFailure" }));

    const exists = Effect.fn("WorkspaceAdapter.exists")(function* (
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

    const read = Effect.fn("WorkspaceAdapter.read")(function* (
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

    const write = Effect.fn("WorkspaceAdapter.write")(function* (
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

    const replaceText = Effect.fn("WorkspaceAdapter.replaceText")(function* (
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

    const grep = Effect.fn("WorkspaceAdapter.grep")(function* (
      request: GrepRequest
    ): Effect.fn.Return<ReadonlyArray<{ readonly path: WorkspacePath; readonly line: string }>, WorkspaceSearchError> {
      const base = yield* resolveSearch(request.path);
      const expression = yield* Effect.try({
        try: () => new RegExp(request.pattern),
        catch: (cause) => new WorkspaceSearchError({ path: request.path, reason: "SearchFailure", cause })
      });
      const entries = yield* fs
        .readDirectory(base, { recursive: true })
        .pipe(
          Effect.mapError((cause) => new WorkspaceSearchError({ path: request.path, reason: "SearchFailure", cause }))
        );
      const matches: Array<{ readonly path: WorkspacePath; readonly line: string }> = [];
      for (const entry of entries) {
        const absolute = path.isAbsolute(entry) ? entry : path.join(base, entry);
        const content = yield* fs.readFileString(absolute).pipe(Effect.option);
        if (content._tag === "None") continue;
        for (const line of content.value.split("\n")) {
          if (expression.test(line)) {
            const relative = path.relative(workspaceRoot, absolute);
            const relativePath = Schema.decodeUnknownOption(WorkspacePath)(relative);
            if (Option.isSome(relativePath)) {
              matches.push({ path: relativePath.value, line });
            }
          }
          expression.lastIndex = 0;
        }
      }
      return matches;
    });

    const glob = Effect.fn("WorkspaceAdapter.glob")(function* (
      request: GlobRequest
    ): Effect.fn.Return<ReadonlyArray<WorkspacePath>, WorkspaceSearchError> {
      const base = yield* resolveSearch(request.path);
      const entries = yield* fs
        .glob(request.pattern, { root: base })
        .pipe(
          Effect.mapError((cause) => new WorkspaceSearchError({ path: request.path, reason: "SearchFailure", cause }))
        );
      return entries.flatMap((entry) => {
        const absolute = path.isAbsolute(entry) ? entry : path.join(base, entry);
        const relative = Schema.decodeUnknownOption(WorkspacePath)(path.relative(workspaceRoot, absolute));
        return Option.isSome(relative) ? [relative.value] : [];
      });
    });

    return Workspace.of({ exists, read, write, replaceText, grep, glob });
  });

export const layer = (root: string): Layer.Layer<Workspace, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Workspace, make(root));
