import { Effect, Option, Schema } from "effect";
import type { CommandExecutor } from "../../command-executor.ts";
import { WorkspacePath, WorkspaceSearchError, type GrepMatch, type GrepRequest } from "../index.ts";

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
