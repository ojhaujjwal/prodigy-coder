import { Effect, Option, Schema } from "effect";
import type * as FileSystem from "effect/FileSystem";
import { WorkspacePath, WorkspaceSearchError, type GlobRequest } from "../index.ts";

/**
 * Translate a `find -name` style glob into a RegExp source.
 *
 * Supported syntax mirrors fnmatch: `*` (any run of characters within one
 * path segment), `?` (one character), a double-star segment (any run
 * including `/`; when immediately followed by a separator it may also match
 * zero segments), and character classes `[seq]` / `[!seq]`. Everything else
 * is literal.
 */
export const globSource = (glob: string): string => {
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
const joinPath = (left: string, right: string): string =>
  [left.replace(/\/+$/, ""), right].filter((part) => part !== "" && part !== ".").join("/");

/**
 * Normalize a search path into a workspace-relative prefix: `.` and `./`
 * collapse to nothing, trailing separators disappear.
 */
const relativePrefix = (searchPath: string): string => searchPath.replace(/\/+$/, "").replace(/^\.\//, "");

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

    // Stat entries with bounded concurrency instead of sequential loop.
    const checked = yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          const relativeEntry = joinPath(prefix, entry);
          const info = yield* fs.stat(joinPath(searchDir, entry)).pipe(Effect.option);
          if (Option.isNone(info) || info.value.type !== "File") return Option.none<WorkspacePath>();
          const target = SEGMENT_PATTERN.test(request.pattern)
            ? entry.slice(entry.lastIndexOf("/") + 1)
            : relativeEntry;
          if (!expression.test(target)) return Option.none<WorkspacePath>();
          const branded = Schema.decodeUnknownOption(WorkspacePath)(relativeEntry);
          return Option.isSome(branded) ? Option.some(branded.value) : Option.none<WorkspacePath>();
        }),
      { concurrency: 32 }
    );

    for (const maybePath of checked) {
      if (Option.isSome(maybePath)) matches.push(maybePath.value);
    }

    return matches.sort();
  });
