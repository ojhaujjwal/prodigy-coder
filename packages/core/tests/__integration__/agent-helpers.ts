import { Effect, Layer, Option, Schema, Stream } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";
import {
  HumanInteraction,
  type InteractionRequest,
  type InteractionResponse
} from "../../src/capabilities/human-interaction.ts";
import { CommandExecutor, type CommandRequest, type CommandResult } from "../../src/capabilities/command-executor.ts";
import {
  Workspace,
  WorkspaceLookupError,
  WorkspacePath,
  type GrepMatch,
  type GrepRequest
} from "../../src/capabilities/workspace.ts";
import { SkillRepository, type Skill } from "../../src/capabilities/skill-repository.ts";
import { PositiveInt, type AgentProfile } from "../../src/agent/agent-profile.ts";

/** A scripted `Workspace` over an in-memory map, honoring read/write/replace/grep/glob. */
export type ScriptedWorkspace = {
  readonly layer: Layer.Layer<Workspace>;
  readonly files: Map<string, string>;
};

export const scriptedWorkspaceLayer = (initial?: Record<string, string>): ScriptedWorkspace => {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  const pathOf = (p: WorkspacePath): string => p;
  // Branded workspace paths come from the parsing boundary (the schema), not
  // casts, matching how adapters produce them in production.
  const brand = (name: string): WorkspacePath => Schema.decodeUnknownSync(WorkspacePath)(name);
  const layer = Layer.succeed(
    Workspace,
    Workspace.of({
      exists: (path) => Effect.succeed(files.has(pathOf(path))),
      read: (path) => {
        const key = pathOf(path);
        const content = files.get(key);
        return content === undefined
          ? Effect.fail(new WorkspaceLookupError({ path: brand(key), reason: "NotFound" }))
          : Effect.succeed(content);
      },
      write: (path, content) =>
        Effect.sync(() => {
          files.set(pathOf(path), content);
          return `rev:${files.size}`;
        }),
      replaceText: (path, oldText, newText) =>
        Effect.sync(() => {
          const current = files.get(pathOf(path));
          if (current === undefined) return "rev:0";
          const index = current.indexOf(oldText);
          if (index === -1) {
            throw new Error(`oldString not found in file: ${oldText}`);
          }
          const updated = current.slice(0, index) + newText + current.slice(index + oldText.length);
          files.set(pathOf(path), updated);
          return `rev:${files.size}`;
        }),
      grep: ({ pattern }: GrepRequest) =>
        Effect.sync(() => {
          const matches: GrepMatch[] = [];
          for (const [filePath, content] of files) {
            for (const [index, line] of content.split("\n").entries()) {
              if (line.includes(pattern)) {
                matches.push({ path: brand(filePath), lineNumber: index + 1, line });
              }
            }
          }
          return matches;
        }),
      glob: ({ pattern }: { pattern: string; path: WorkspacePath }) =>
        Effect.sync(() => {
          // A minimal glob: exact filename match or `*.ext` suffix.
          const [prefix, suffix] = pattern.split("*");
          return Array.from(files.keys())
            .filter((name) =>
              !pattern.includes("*") ? name === pattern : name.startsWith(prefix ?? "") && name.endsWith(suffix ?? "")
            )
            .map(brand);
        })
    })
  );
  return { layer, files };
};

/** A scripted `CommandExecutor` that answers from a map and records calls. */
export type ScriptedCommandExecutor = {
  readonly layer: Layer.Layer<CommandExecutor>;
  readonly calls: Array<CommandRequest>;
};

export const scriptedCommandExecutorLayer = (responses: Record<string, CommandResult>): ScriptedCommandExecutor => {
  const calls: Array<CommandRequest> = [];
  const layer = Layer.succeed(
    CommandExecutor,
    CommandExecutor.of({
      execute: (request) =>
        Effect.sync(() => {
          calls.push(request);
          const key = request.argv.join(" ");
          return responses[key] ?? { exitCode: 0, stdout: "", stderr: "" };
        })
    })
  );
  return { layer, calls };
};

/** A scripted `SkillRepository` with the given skills. */
export const scriptedSkillRepositoryLayer = (skills: readonly Skill[]): Layer.Layer<SkillRepository> =>
  Layer.succeed(
    SkillRepository,
    SkillRepository.of({
      findByName: (name) => Effect.succeed(Option.fromNullishOr(skills.find((s) => s.name === name))),
      autoInvokable: Effect.succeed(skills.filter((s) => !s.disableModelInvocation))
    })
  );

/**
 * A scripted `LanguageModel` that serves one scripted turn per `streamText`
 * call, advancing an internal cursor each call. This is the provider-neutral
 * seam for cases the wire-level OpenAI mock cannot express.
 */
export const scriptedToolModelLayer = (
  turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>
): Layer.Layer<LanguageModel.LanguageModel> => {
  let index = 0;
  return Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        const parts = turns[index] ?? [];
        index += 1;
        return Stream.fromIterable(parts);
      }
    })
  );
};

export const textDelta = (id: string, delta: string): Response.StreamPartEncoded => ({
  type: "text-delta",
  id,
  delta
});

export const finishPart = (reason: "stop" | "tool-calls" | "length"): Response.StreamPartEncoded => ({
  type: "finish",
  reason,
  usage: {
    inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  },
  response: undefined
});

export const EchoTool = Tool.make("echo", {
  description: "Echo a value",
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ value: Schema.String }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return"
});

export const EchoToolkit = Toolkit.make(EchoTool);

/** A text-only profile: an empty toolkit with no handler Layer and no authorities. */
export const textProfile = (maxTurns: PositiveInt = PositiveInt.make(50), systemPrompt = ""): AgentProfile<{}> => ({
  toolkit: Toolkit.empty,
  toolkitHandlerLayer: Layer.empty,

  systemPrompt,
  maxTurns
});

/** Build a profile for the echo toolkit with the given handler Layer. */
export const echoProfile = (
  toolkitHandlerLayer: Layer.Layer<Tool.HandlersFor<typeof EchoToolkit.tools>>,
  maxTurns: PositiveInt = PositiveInt.make(50)
): AgentProfile<typeof EchoToolkit.tools> => ({
  toolkit: EchoToolkit,
  toolkitHandlerLayer,

  systemPrompt: "",
  maxTurns
});

/** A tool that requires human approval before the handler executes. */
export const ApprovalTool = Tool.make("approval-gated", {
  description: "A tool that requires human approval",
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ value: Schema.String }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return",
  needsApproval: true,
  dependencies: [HumanInteraction]
});

export const ApprovalToolkit = Toolkit.make(ApprovalTool);

/** Build a profile for the approval-gated toolkit (requires `HumanInteraction`). */
export const approvalProfile = (
  toolkitHandlerLayer: Layer.Layer<Tool.HandlersFor<typeof ApprovalToolkit.tools>>,
  maxTurns: PositiveInt = PositiveInt.make(50)
): AgentProfile<typeof ApprovalToolkit.tools> => ({
  toolkit: ApprovalToolkit,
  toolkitHandlerLayer,
  systemPrompt: "",
  maxTurns
});

export type ScriptedEchoOutcome =
  | { readonly _tag: "Success"; readonly value: string }
  | { readonly _tag: "Failure"; readonly message: string };

export type ScriptedEchoToolkit = {
  readonly layer: Layer.Layer<Tool.HandlersFor<typeof EchoToolkit.tools>>;
  readonly calls: Array<Readonly<{ value: string }>>;
};

export const scriptedEchoToolkit = (
  outcome: ScriptedEchoOutcome = { _tag: "Success", value: "echoed" }
): ScriptedEchoToolkit => {
  const calls: Array<Readonly<{ value: string }>> = [];
  const layer = EchoToolkit.toLayer({
    echo: (input) => {
      calls.push(input);
      if (outcome._tag === "Failure") {
        return Effect.fail({ message: outcome.message });
      }
      return Effect.succeed({ value: outcome.value });
    }
  });
  return { layer, calls };
};

export type ScriptedInteraction = {
  readonly layer: Layer.Layer<HumanInteraction>;
  readonly requests: Array<InteractionRequest>;
};

/**
 * A scripted `HumanInteraction` adapter for integration tests: records every
 * request and answers each in order from the supplied responses. The core
 * analogue of the CLI's scripted approval tests.
 */
export const scriptedInteractionLayer = (responses: ReadonlyArray<InteractionResponse>): ScriptedInteraction => {
  const requests: Array<InteractionRequest> = [];
  let index = 0;
  const layer = Layer.succeed(
    HumanInteraction,
    HumanInteraction.of({
      request: (input) => {
        requests.push(input);
        const response = responses[index] ?? { _tag: "Denied", reason: "No scripted response" };
        index += 1;
        return Effect.succeed(response);
      }
    })
  );
  return { layer, requests };
};
