import type * as Path from "effect/Path";
import type { WorkspacePath } from "../index.ts";

/**
 * Check whether a workspace-relative path resolves inside the workspace root.
 *
 * The check is purely lexical against the resolved absolute paths — no I/O.
 * Both the original CLI adapter (`CommandExecutor`) and the `Workspace`
 * adapter share this predicate; keeping it canonical avoids drift between the
 * two security boundaries.
 */
export const isInsideRoot = (pathService: Path.Path, workspaceRoot: string, candidate: WorkspacePath): boolean => {
  const resolved = pathService.resolve(workspaceRoot, candidate);
  const relative = pathService.relative(workspaceRoot, resolved);
  return relative !== ".." && !relative.startsWith(`..${pathService.sep}`) && !pathService.isAbsolute(relative);
};

/**
 * Check whether a relative cwd (already made absolute) stays inside the
 * workspace root. Used by the command executor authority.
 */
export const isCwdInsideRoot = (pathService: Path.Path, workspaceRoot: string, cwd: string): boolean => {
  const relative = pathService.relative(workspaceRoot, cwd);
  return relative !== ".." && !relative.startsWith(`..${pathService.sep}`) && !pathService.isAbsolute(relative);
};
