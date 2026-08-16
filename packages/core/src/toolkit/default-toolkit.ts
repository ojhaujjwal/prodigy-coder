import { Effect, Option, Predicate, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as AiError from "effect/unstable/ai/AiError";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { CommandExecutor, type CommandExecuteError, type CommandResult } from "../capabilities/command-executor.ts";
import { HumanInteraction, type HumanInteractionError } from "../capabilities/human-interaction.ts";
import { SkillRepository, SkillName } from "../capabilities/skill-repository.ts";
import {
  Workspace,
  WorkspacePath,
  type WorkspaceError,
  type GrepRequest,
  type GrepMatch
} from "../capabilities/workspace.ts";
import { PositiveInt, type AgentProfile } from "../agent/agent-profile.ts";

// ---------------------------------------------------------------------------
// Shared error projection: capability failures become model-visible AiErrors.
// ---------------------------------------------------------------------------

/**
 * The failure vocabulary a toolkit handler can raise: the execution-authority
 * errors (workspace, command, interaction), model-input parse failures, and
 * webfetch transport failures. Projected onto the Effect AI SDK's `AiError` in
 * one place, so handlers name Prodigy's errors, never the SDK's.
 */
type ToolkitCapabilityError =
  | WorkspaceError
  | CommandExecuteError
  | HumanInteractionError
  | Schema.SchemaError
  | HttpClientError.HttpClientError;

export const toToolError =
  (module: string, method: string) =>
  (error: ToolkitCapabilityError): AiError.AiError =>
    AiError.make({
      module,
      method,
      reason: new AiError.UnknownError({ description: describeCapabilityError(error) })
    });

const describeCapabilityError = (error: ToolkitCapabilityError): string => {
  switch (error._tag) {
    case "WorkspaceLookupError":
      return error.reason === "NotFound" ? `file not found: ${error.path}` : `could not read: ${error.path}`;
    case "WorkspacePersistenceError":
      switch (error.reason) {
        case "WriteFailure":
          return `write failed: ${error.path}`;
        case "NoMatch":
          return `edit target not found: ${error.path}`;
        case "Conflict":
          return `concurrent modification: ${error.path}`;
      }
    case "WorkspaceSearchError":
      return `search failed: ${error.path}`;
    case "CommandExecuteError":
      switch (error.reason) {
        case "Spawn":
          return "command could not be started";
        case "Timeout":
          return "command timed out";
        case "Interrupted":
          return "command interrupted";
        case "OutputLimit":
          return "command output exceeded the limit";
        case "Transport":
          return "command transport failed";
      }
    case "HumanInteractionError":
      switch (error.reason) {
        case "Timeout":
          return "human interaction timed out";
        case "ChannelClosed":
          return "human interaction channel closed";
        case "InvalidResponse":
          return "invalid response from human interaction";
      }
    case "SchemaError":
      return error.message;
    case "HttpClientError":
      return error.message;
  }
};

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

const ShellParameters = Schema.Struct({
  command: Schema.String
});

export const ShellTool = Tool.make("shell", {
  description: "Execute a shell command",
  parameters: ShellParameters,
  success: Schema.String,
  failureMode: "return",
  dependencies: [CommandExecutor]
});

export type ShellTool = typeof ShellTool;

export const shellHandler = (
  { command }: Tool.Parameters<typeof ShellTool>,
  _context: Toolkit.HandlerContext<typeof ShellTool>
) =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor;
    const result: CommandResult = yield* executor.execute({ argv: ["bash", "-c", command] });
    const combined = result.stdout + result.stderr;
    if (result.exitCode === 0) {
      return combined || "";
    }
    return `Command failed with exit code ${result.exitCode}: ${combined}`;
  }).pipe(Effect.mapError(toToolError("ShellTool", "shellHandler")));

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

const ReadParameters = Schema.Struct({
  filePath: Schema.String
});

export const ReadTool = Tool.make("read", {
  description: "Read a file's contents",
  parameters: ReadParameters,
  success: Schema.String,
  failureMode: "return",
  dependencies: [Workspace]
});

export type ReadTool = typeof ReadTool;

export const readHandler = (
  { filePath }: Tool.Parameters<typeof ReadTool>,
  _context: Toolkit.HandlerContext<typeof ReadTool>
) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const path = yield* parseWorkspacePath(filePath);
    return yield* workspace.read(path).pipe(Effect.mapError(toToolError("ReadTool", "readHandler")));
  });

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

const WriteParameters = Schema.Struct({
  filePath: Schema.String,
  content: Schema.String
});

export const WriteTool = Tool.make("write", {
  description: "Write content to a file",
  parameters: WriteParameters,
  success: Schema.String,
  failureMode: "return",
  dependencies: [Workspace]
});

export type WriteTool = typeof WriteTool;

export const writeHandler = (
  { filePath, content }: Tool.Parameters<typeof WriteTool>,
  _context: Toolkit.HandlerContext<typeof WriteTool>
) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const path = yield* parseWorkspacePath(filePath);
    yield* workspace.write(path, content).pipe(Effect.mapError(toToolError("WriteTool", "writeHandler")));
    return `Written to ${filePath}`;
  });

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

const EditParameters = Schema.Struct({
  filePath: Schema.String,
  oldString: Schema.String,
  newString: Schema.String
});

export const EditTool = Tool.make("edit", {
  description: "Edit a file by replacing text",
  parameters: EditParameters,
  success: Schema.String,
  failureMode: "return",
  dependencies: [Workspace]
});

export type EditTool = typeof EditTool;

export const editHandler = (
  { filePath, oldString, newString }: Tool.Parameters<typeof EditTool>,
  _context: Toolkit.HandlerContext<typeof EditTool>
) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const path = yield* parseWorkspacePath(filePath);
    yield* workspace
      .replaceText(path, oldString, newString)
      .pipe(Effect.mapError(toToolError("EditTool", "editHandler")));
    return `Edited ${filePath}`;
  });

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const GrepParameters = Schema.Struct({
  pattern: Schema.String,
  path: Schema.String
});

export const GrepTool = Tool.make("grep", {
  description: "Search for text patterns in files",
  parameters: GrepParameters,
  success: Schema.Array(Schema.String),
  failureMode: "return",
  dependencies: [Workspace]
});

export type GrepTool = typeof GrepTool;

export const grepHandler = (
  { pattern, path }: Tool.Parameters<typeof GrepTool>,
  _context: Toolkit.HandlerContext<typeof GrepTool>
) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const workspacePath = yield* parseWorkspacePath(path);
    const request: GrepRequest = { pattern, path: workspacePath };
    const matches: ReadonlyArray<GrepMatch> = yield* workspace
      .grep(request)
      .pipe(Effect.mapError(toToolError("GrepTool", "grepHandler")));
    return matches.map((m) => `${m.path}:${m.line}`);
  });

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

const GlobParameters = Schema.Struct({
  pattern: Schema.String,
  path: Schema.String
});

export const GlobTool = Tool.make("glob", {
  description: "Find files matching a glob pattern",
  parameters: GlobParameters,
  success: Schema.Array(Schema.String),
  failureMode: "return",
  dependencies: [Workspace]
});

export type GlobTool = typeof GlobTool;

export const globHandler = (
  { pattern, path }: Tool.Parameters<typeof GlobTool>,
  _context: Toolkit.HandlerContext<typeof GlobTool>
) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const workspacePath = yield* parseWorkspacePath(path);
    const files: ReadonlyArray<WorkspacePath> = yield* workspace
      .glob({ pattern, path: workspacePath })
      .pipe(Effect.mapError(toToolError("GlobTool", "globHandler")));
    return Array.from(files);
  });

// ---------------------------------------------------------------------------
// webfetch
// ---------------------------------------------------------------------------

const WebFetchParameters = Schema.Struct({
  url: Schema.String
});

export const WebFetchTool = Tool.make("webfetch", {
  description: "Fetch web content from a URL",
  parameters: WebFetchParameters,
  success: Schema.String,
  failureMode: "return",
  dependencies: [HttpClient.HttpClient]
});

export type WebFetchTool = typeof WebFetchTool;

export const webfetchHandler = (
  { url }: Tool.Parameters<typeof WebFetchTool>,
  _context: Toolkit.HandlerContext<typeof WebFetchTool>
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    return yield* response.text;
  }).pipe(Effect.mapError(toToolError("WebFetchTool", "webfetchHandler")));

// ---------------------------------------------------------------------------
// ask_user
// ---------------------------------------------------------------------------

const AskUserParameters = Schema.Struct({
  question: Schema.String
});

export const AskUserTool = Tool.make("ask_user", {
  description:
    "Ask the user a free-text question and return their answer. Use this when you need clarification or additional information from the user.",
  parameters: AskUserParameters,
  success: Schema.String,
  failureMode: "return",
  dependencies: [HumanInteraction]
});

export type AskUserTool = typeof AskUserTool;

export const askUserHandler = (
  { question }: Tool.Parameters<typeof AskUserTool>,
  _context: Toolkit.HandlerContext<typeof AskUserTool>
) =>
  Effect.gen(function* () {
    const interaction = yield* HumanInteraction;
    const response = yield* interaction
      .request({ question })
      .pipe(Effect.mapError(toToolError("AskUserTool", "askUserHandler")));
    if (response._tag === "Answered") {
      return Predicate.isString(response.answer) ? response.answer : JSON.stringify(response.answer);
    }
    return yield* AiError.make({
      module: "AskUserTool",
      method: "askUserHandler",
      reason: new AiError.UnknownError({
        description: "ask_user requires a free-text answer from the interaction channel"
      })
    });
  });

// ---------------------------------------------------------------------------
// load_skill
// ---------------------------------------------------------------------------

const LoadSkillParameters = Schema.Struct({
  name: Schema.String
});

export const LoadSkillTool = Tool.make("load_skill", {
  description:
    "Load a skill's full instructions by name. Use to view the complete content of a skill listed in Available Skills.",
  parameters: LoadSkillParameters,
  success: Schema.String,
  failureMode: "return",
  dependencies: [SkillRepository]
});

export type LoadSkillTool = typeof LoadSkillTool;

export const loadSkillHandler = (
  { name }: Tool.Parameters<typeof LoadSkillTool>,
  _context: Toolkit.HandlerContext<typeof LoadSkillTool>
) =>
  Effect.gen(function* () {
    const repo = yield* SkillRepository;
    const skillName = yield* parseSkillName(name);
    const skill = yield* repo.findByName(skillName);

    if (Option.isNone(skill)) {
      const autoInvokable = yield* repo.autoInvokable;
      const names = autoInvokable.map((s) => s.name).join(", ");
      return yield* AiError.make({
        module: "LoadSkill",
        method: "loadSkillHandler",
        reason: new AiError.UnknownError({
          description: `Skill '${name}' not found. Available auto-invokable skills: ${names}`
        })
      });
    }

    return `# Skill: ${skill.value.name}\n\n${skill.value.content}`;
  });

// ---------------------------------------------------------------------------
// Path parsing helpers
// ---------------------------------------------------------------------------

/** Parse a model-supplied path into a workspace-relative `WorkspacePath`. */
const parseWorkspacePath = (path: string): Effect.Effect<WorkspacePath, AiError.AiError> =>
  Schema.decodeUnknownEffect(WorkspacePath)(path).pipe(
    Effect.mapError(toToolError("WorkspacePath", "parseWorkspacePath"))
  );

/** Parse a model-supplied skill name into a branded `SkillName`. */
const parseSkillName = (name: string): Effect.Effect<SkillName, AiError.AiError> =>
  Schema.decodeUnknownEffect(SkillName)(name).pipe(Effect.mapError(toToolError("SkillName", "parseSkillName")));

// ---------------------------------------------------------------------------
// The default agentic toolkit and its handler layer
// ---------------------------------------------------------------------------

export const DefaultAgenticToolkit = Toolkit.make(
  ShellTool,
  ReadTool,
  WriteTool,
  EditTool,
  GrepTool,
  GlobTool,
  WebFetchTool,
  AskUserTool,
  LoadSkillTool
);

export type DefaultAgenticToolkit = typeof DefaultAgenticToolkit;

export type DefaultAgenticHandlers = Toolkit.HandlersFrom<typeof DefaultAgenticToolkit.tools>;

/**
 * The handler Layer for the default agentic toolkit. Handlers depend on the
 * capability services (`Workspace`, `CommandExecutor`, `HumanInteraction`,
 * `SkillRepository`, `HttpClient`) — no platform services directly. The
 * composition root provides the concrete Layers.
 */
export const defaultAgenticToolkitLayer = DefaultAgenticToolkit.toLayer(
  Effect.sync(() => ({
    shell: shellHandler,
    read: readHandler,
    write: writeHandler,
    edit: editHandler,
    grep: grepHandler,
    glob: globHandler,
    webfetch: webfetchHandler,
    ask_user: askUserHandler,
    load_skill: loadSkillHandler
  }))
);

/**
 * The ready default profile for ordinary local execution: the default agentic
 * toolkit with its handler Layer, declaring the authority services its
 * handlers need (`Workspace`, `CommandExecutor`, `HumanInteraction`,
 * `SkillRepository`). The composition root provides concrete Layers for the
 * authorities (and `HttpClient` for `webfetch`).
 */
export const defaultAgenticProfile = (
  maxTurns: PositiveInt = PositiveInt.make(50)
): AgentProfile<typeof DefaultAgenticToolkit.tools> => ({
  toolkit: DefaultAgenticToolkit,
  toolkitHandlerLayer: defaultAgenticToolkitLayer,
  systemPrompt: "",
  maxTurns
});
