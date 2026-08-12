import { expect, it } from "vitest";
import {
  CommandExecutor,
  DefaultAgenticToolkit,
  HumanInteraction,
  ProdigyAgent,
  SessionStore,
  SkillName,
  SkillRepository,
  Workspace,
  WorkspacePath,
  defaultAgenticProfile,
  defaultAgenticToolkitLayer,
  fileSessionStoreLayer,
  makeLayer,
  memorySessionStoreLayer
} from "@prodigy/core";
import type {
  AgentError,
  AgentEvent,
  AgentFinishReason,
  AgentProfile,
  AgentResult,
  CommandRequest,
  CommandResult,
  DefaultAgenticHandlers,
  GlobRequest,
  GrepMatch,
  GrepRequest,
  HumanInteractionError,
  InteractionRequest,
  InteractionResponse,
  ProfileAuthorities,
  RunId,
  RunRequest,
  Session,
  SessionCheckpoint,
  SessionError,
  SessionId,
  SessionRevision,
  SessionSnapshot,
  Skill,
  ToolApprovalRequest,
  ToolkitAuthorities,
  ToolkitServices,
  UserQuestion,
  WorkspaceError,
  WorkspaceLookupError,
  WorkspacePersistenceError,
  WorkspaceSearchError
} from "@prodigy/core";

it("exposes the curated run-contract surface", () => {
  // Runtime exports resolve.
  expect(ProdigyAgent).toBeDefined();
  expect(SessionStore).toBeDefined();
  expect(memorySessionStoreLayer).toBeDefined();
  expect(fileSessionStoreLayer).toBeDefined();
  expect(makeLayer).toBeDefined();
  expect(DefaultAgenticToolkit).toBeDefined();
  expect(defaultAgenticToolkitLayer).toBeDefined();
  expect(defaultAgenticProfile).toBeDefined();
  expect(Workspace).toBeDefined();
  expect(WorkspacePath).toBeDefined();
  expect(CommandExecutor).toBeDefined();
  expect(HumanInteraction).toBeDefined();
  expect(SkillRepository).toBeDefined();
  expect(SkillName).toBeDefined();

  // The run-request and finish-reason vocabulary is directly usable.
  const request: RunRequest = { prompt: "" };
  const finish: AgentFinishReason = "stop";
  expect(request.prompt).toBe("");
  expect(finish).toBe("stop");
});

// The type-only surface must be nameable by consumers. Branded values
// (`RunId`, `SessionId`, `SessionRevision`) are constructed only by their
// owning authorities; these annotations verify the names resolve.
type _Named = {
  runId: RunId;
  event: AgentEvent;
  result: AgentResult;
  error: AgentError;
  sessionError: SessionError;
  session: Session;
  sessionId: SessionId;
  revision: SessionRevision;
  snapshot: SessionSnapshot;
  checkpoint: SessionCheckpoint;
  profile: AgentProfile<typeof DefaultAgenticToolkit.tools>;
  profileAuthorities: ProfileAuthorities<typeof DefaultAgenticToolkit.tools>;
  toolkitAuthorities: ToolkitAuthorities;
  toolkitServices: ToolkitServices<typeof DefaultAgenticToolkit.tools>;
  workspaceError: WorkspaceError;
  workspaceLookupError: WorkspaceLookupError;
  workspacePersistenceError: WorkspacePersistenceError;
  workspaceSearchError: WorkspaceSearchError;
  grepRequest: GrepRequest;
  grepMatch: GrepMatch;
  globRequest: GlobRequest;
  commandRequest: CommandRequest;
  commandResult: CommandResult;
  interactionRequest: InteractionRequest;
  interactionResponse: InteractionResponse;
  toolApprovalRequest: ToolApprovalRequest;
  userQuestion: UserQuestion;
  humanInteractionError: HumanInteractionError;
  skill: Skill;
  defaultHandlers: DefaultAgenticHandlers;
};
export type Named = _Named;
