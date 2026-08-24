import { Hash, Effect, Layer, Option, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { CommandExecutor } from "./command-executor.ts";
import {
  Workspace,
  WorkspacePath,
  WorkspaceLookupError,
  WorkspacePersistenceError,
  WorkspaceSearchError,
  type GrepMatch,
  type GrepRequest,
  type GlobRequest
} from "./workspace.ts";

/**
 * One `rg --no-heading --line-number` output line: `path:lineNumber:text`.
 * The prefix is lazy so the split happens at the first colon-digit-colon —
 * rg always emits the path before the line number, and file paths essentially
 * never contain a `:<digits>:` segment, while matched content frequently
 * contains colon-digit sequences that must stay intact in the text field.
 */
const RG_LINE = /^(.*?):(\d+):(.*)$/;

/**
 * The ripgrep-backed implementation of the {@link Workspace} grep contract.
 *
 * Runs `rg --hidden --no-heading --line-number --with-filename` through the
 * {@link CommandExecutor} authority, so the search inherits the executor's
 * working-directory policy (the CLI adapter pins it to the workspace root)
 * and its timeout policy. Match paths are relative to that working directory,
 * which is what makes them valid workspace-relative `WorkspacePath`s.
 *
 * Exit codes follow rg's contract: `0` means matches were found, `1` means no
 * matches (an empty result, not a failure), and `2` or higher is a real
 * failure (bad pattern, unreadable path) surfaced as `WorkspaceSearchError`
 * instead of being silently swallowed. Binary files and gitignored paths are
 * skipped by rg itself.
 *
 * `-e` and `--` guard the pattern and path against argument injection, so a
 * model-supplied pattern beginning with `-` is searched literally.
 */
export const ripgrepGrep = Effect.fn("FileSystemWorkspace.ripgrepGrep")(function* (
  executor: CommandExecutor["Service"],
  request: GrepRequest
): Effect.fn.Return<ReadonlyArray<GrepMatch>, WorkspaceSearchError> {
  const result = yield* executor
    .execute({
      argv: [
        "rg",
        "--hidden",
        "--no-heading",
        "--line-number",
        "--with-filename",
        "-e",
        request.pattern,
        "--",
        request.path
      ]
    })
    .pipe(Effect.mapError((cause) => new WorkspaceSearchError({ path: request.path, reason: "SearchFailure", cause })));

  if (result.exitCode >= 2) {
    return yield* new WorkspaceSearchError({
      path: request.path,
      reason: "SearchFailure",
      cause: new Error(
        `ripgrep failed with exit code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`
      )
    });
  }

  const matches: GrepMatch[] = [];
  for (const entry of result.stdout.split("\n")) {
    if (entry.length === 0) continue;
    const parsed = RG_LINE.exec(entry);
    if (!parsed) continue;
    const path = Schema.decodeUnknownOption(WorkspacePath)(parsed[1]);
    if (Option.isNone(path)) continue;
    matches.push({ path: path.value, lineNumber: Number(parsed[2]), line: parsed[3] });
  }
  return matches;
});

/**
 * Translate a `find -name` style glob into a RegExp source.
 *
 * Supported syntax mirrors fnmatch: `*` (any run of characters within one
 * path segment), `?` (one character), a double-star segment (any run
 * including `/`; when immediately followed by a separator it may also match
 * zero segments), and character classes `[seq]` / `[!seq]`. Everything else
 * is literal.
 */
const globSource = (glob: string): string => {
  let source = "";
  let index = 0;
  const literal = (char: string) => char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  while (index < glob.length) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 3;
        } else {
          source += ".*";
          index += 2;
        }
      } else {
        source += "[^/]*";
        index += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
      index += 1;
    } else if (char === "[") {
      // A `]` directly after `[` or `[!` is a literal member, so scan past it
      // for the real terminator; an unterminated `[` stays literal.
      let cursor = index + 1;
      if (glob[cursor] === "!") cursor += 1;
      if (glob[cursor] === "]") cursor += 1;
      const close = glob.indexOf("]", cursor);
      if (close === -1 || close === index + 1) {
        source += "\\[";
        index += 1;
      } else {
        const negated = glob[index + 1] === "!";
        const members = glob.slice(cursor, close).replace(/\\/g, "\\\\");
        source += `[${negated ? "^" : ""}${members}]`;
        index = close + 1;
      }
    } else {
      source += literal(char);
      index += 1;
    }
  }
  return source;
};

const SEGMENT_PATTERN = /^[^/]+$/;

/** Join two path fragments with a single separator, tolerating empty parts. */
const joinPath = (left: string, right: string) =>
  [left.replace(/\/+$/, ""), right].filter((part) => part !== "" && part !== ".").join("/");

/**
 * Normalize a search path into a workspace-relative prefix: `.` and `./`
 * collapse to nothing, trailing separators disappear.
 */
const relativePrefix = (searchPath: string) => searchPath.replace(/\/+$/, "").replace(/^\.\//, "");

/**
 * The reference implementation of the {@link Workspace} glob contract,
 * restoring the historical `find <path> -name <pattern> -type f` semantics
 * that models were trained on.
 *
 * - The search is recursive: `<path>` and every directory beneath it.
 * - Only files match (`-type f`); directories never match, even when their
 *   names fit the pattern.
 * - A pattern without `/` matches file basenames, so `*.ts` reaches every
 *   depth without needing `**`.
 * - A pattern containing `/` matches the whole base-relative path, where a
 *   double-star segment crosses directories, so `src` plus a double-star
 *   plus `*.ts` reaches every depth under `src`. Historical `find`
 *   never matched these at all; matching them sensibly is an improvement,
 *   not a compatibility surface.
 * - Hidden files are included, as `find` always did, keeping glob consistent
 *   with the ripgrep-backed grep, which also searches hidden paths.
 *
 * `request.path` resolves against `base` (the caller's workspace root, kept
 * explicit so this function never depends on the process working directory).
 * Results are reported relative to that same root and sorted
 * lexicographically for deterministic output. Unreadable entries (broken
 * symlinks, permissions) are skipped rather than failing the search.
 */
export const findGlob = (
  fs: FileSystem.FileSystem,
  base: string,
  request: GlobRequest
): Effect.Effect<ReadonlyArray<WorkspacePath>, WorkspaceSearchError> =>
  Effect.gen(function* () {
    const expression = yield* Effect.try({
      try: () => new RegExp(`^${globSource(request.pattern)}$`),
      catch: (cause) => new WorkspaceSearchError({ path: request.path, reason: "SearchFailure", cause })
    });

    const prefix = relativePrefix(request.path);
    const searchDir = joinPath(base, request.path);

    const entries = yield* fs
      .readDirectory(searchDir, { recursive: true })
      .pipe(
        Effect.mapError((cause) => new WorkspaceSearchError({ path: request.path, reason: "SearchFailure", cause }))
      );

    const matches: Array<WorkspacePath> = [];
    for (const entry of entries) {
      const relativeEntry = joinPath(prefix, entry);
      // Directories never match (`-type f`); unreadable entries are skipped.
      const info = yield* fs.stat(joinPath(searchDir, entry)).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      const target = SEGMENT_PATTERN.test(request.pattern) ? entry.slice(entry.lastIndexOf("/") + 1) : relativeEntry;
      if (!expression.test(target)) continue;
      const branded = Schema.decodeUnknownOption(WorkspacePath)(relativeEntry);
      if (Option.isSome(branded)) matches.push(branded.value);
    }
    return matches.sort();
  });

/**
 * The runtime-neutral, filesystem-backed `Workspace` adapter. Paths are scoped
 * to a root directory, mutations are atomic with hash-based revisions, and
 * search delegates to the ripgrep and find-parity glob implementations above.
 */
const revisionOf = (content: string) => Hash.hash(content).toString(16);

const make = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const executor = yield* CommandExecutor;
    const workspaceRoot = path.resolve(root);

    const isInsideRoot = (workspacePath: WorkspacePath) => {
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
