import { Context, Effect, Schema } from "effect";

/**
 * The `WorkspacePath` brand schema: a non-empty, root-relative workspace path.
 *
 * Absolute paths and parent traversal are rejected here. Path normalization,
 * workspace roots, permissions, and output limits remain adapter policy.
 */
export const WorkspacePath = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^(?![\\/])(?!(?:[A-Za-z]:))(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/)),
  Schema.brand("WorkspacePath")
);
export type WorkspacePath = Schema.Schema.Type<typeof WorkspacePath>;

/** A lookup failure: the path is missing or could not be read. */
export class WorkspaceLookupError extends Schema.TaggedErrorClass<WorkspaceLookupError>()("WorkspaceLookupError", {
  path: Schema.String,
  reason: Schema.Literals(["NotFound", "ReadFailure"]),
  cause: Schema.optional(Schema.Defect())
}) {}

/** A mutation failure: the path could not be written, replaced, or the edit did not match. */
export class WorkspacePersistenceError extends Schema.TaggedErrorClass<WorkspacePersistenceError>()(
  "WorkspacePersistenceError",
  {
    path: Schema.String,
    reason: Schema.Literals(["WriteFailure", "NoMatch", "Conflict"]),
    cause: Schema.optional(Schema.Defect())
  }
) {}

/** A search failure: the pattern could not be executed. */
export class WorkspaceSearchError extends Schema.TaggedErrorClass<WorkspaceSearchError>()("WorkspaceSearchError", {
  path: Schema.String,
  reason: Schema.Literals(["SearchFailure"]),
  cause: Schema.optional(Schema.Defect())
}) {}

/** The cohesive `Workspace` error union: lookup, persistence, and search families. */
export type WorkspaceError = WorkspaceLookupError | WorkspacePersistenceError | WorkspaceSearchError;

/** A request for a text search. */
export type GrepRequest = {
  readonly pattern: string;
  readonly path: WorkspacePath;
};

/** A single search match: the file path and the matching line. */
export type GrepMatch = {
  readonly path: WorkspacePath;
  readonly line: string;
};

/** A request for a glob search. */
export type GlobRequest = {
  readonly pattern: string;
  readonly path: WorkspacePath;
};

/**
 * The agent-facing authority for reading and writing files within a scoped
 * project environment. Adapters enforce roots, permissions, and output
 * limits; mutations are atomic.
 */
export class Workspace extends Context.Service<
  Workspace,
  {
    readonly exists: (path: WorkspacePath) => Effect.Effect<boolean, WorkspaceLookupError>;
    readonly read: (path: WorkspacePath) => Effect.Effect<string, WorkspaceLookupError>;
    readonly write: (
      path: WorkspacePath,
      content: string,
      options?: { readonly expectedRevision?: string }
    ) => Effect.Effect<string, WorkspacePersistenceError>;
    readonly replaceText: (
      path: WorkspacePath,
      oldText: string,
      newText: string,
      options?: { readonly expectedRevision?: string }
    ) => Effect.Effect<string, WorkspacePersistenceError>;
    readonly grep: (request: GrepRequest) => Effect.Effect<ReadonlyArray<GrepMatch>, WorkspaceSearchError>;
    readonly glob: (request: GlobRequest) => Effect.Effect<ReadonlyArray<WorkspacePath>, WorkspaceSearchError>;
  }
>()("@prodigy/core/capabilities/workspace") {}
