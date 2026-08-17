/**
 * The runtime-neutral public entrypoint for the Prodigy SDK.
 *
 * This surface is the v1 run-contract: the `ProdigyAgent` service, its
 * composition factory (`makeProdigyAgentLayer`) and profile vocabulary, the run request
 * and event/result/error vocabulary, the default toolkit with its handler
 * layer and profile, and the capability services (`SessionStore`, `Workspace`,
 * `CommandExecutor`, `HumanInteraction`, `SkillRepository`) with the usable
 * in-memory and file-backed session adapters. Importing this module performs
 * no effects and starts no runtime — consumers compose the Layers themselves.
 *
 * Identity schemas and implementation helpers stay unexported. Public value
 * schemas (`PositiveInt`, `WorkspacePath`, and `SkillName`) are exported so
 * callers can parse values before they cross a core interface.
 */
export { ProdigyAgent } from "./agent/prodigy-agent.ts";
export { makeProdigyAgentLayer } from "./agent/prodigy-agent.ts";
export type { RunRequest, RunRequestInput, RunId } from "./agent/run-request.ts";
export type { AgentEvent, AgentResult, AgentFinishReason, JsonValue } from "./agent/agent-event.ts";
export type { AgentError } from "./agent/agent-error.ts";
export { PositiveInt } from "./agent/agent-profile.ts";
export type { AgentProfile, PositiveInt as PositiveIntType } from "./agent/agent-profile.ts";
export { SessionStore } from "./capabilities/session-store.ts";
export type { SessionError } from "./capabilities/session-store.ts";
export { layer as memorySessionStoreLayer } from "./capabilities/memory-session-store.ts";
export { layer as fileSessionStoreLayer } from "./capabilities/file-session-store.ts";
export type {
  Session,
  SessionId,
  SessionRevision,
  SessionSnapshot,
  SessionCheckpoint
} from "./capabilities/session.ts";
export { Workspace, WorkspacePath } from "./capabilities/workspace.ts";
export type {
  WorkspaceError,
  WorkspaceLookupError,
  WorkspacePersistenceError,
  WorkspaceSearchError,
  GrepRequest,
  GrepMatch,
  GlobRequest
} from "./capabilities/workspace.ts";
export { CommandExecutor } from "./capabilities/command-executor.ts";
export type { CommandRequest, CommandResult } from "./capabilities/command-executor.ts";
export { HumanInteraction } from "./capabilities/human-interaction.ts";
export type {
  HumanInteractionError,
  InteractionRequest,
  InteractionResponse,
  ToolApprovalRequest,
  UserQuestion
} from "./capabilities/human-interaction.ts";
export { SkillRepository, SkillName } from "./capabilities/skill-repository.ts";
export type { Skill } from "./capabilities/skill-repository.ts";
export { DefaultAgenticToolkit, defaultAgenticToolkitLayer, defaultAgenticProfile } from "./toolkit/default-toolkit.ts";
export type { DefaultAgenticHandlers } from "./toolkit/default-toolkit.ts";
