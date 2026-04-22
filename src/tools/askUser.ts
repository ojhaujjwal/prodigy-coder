import { Effect, Schema } from "effect";
import * as Prompt from "effect/unstable/cli/Prompt";
import * as Terminal from "effect/Terminal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { AiError, Tool } from "effect/unstable/ai";
import { Toolkit } from "effect/unstable/ai";

const AskUserParameters = Schema.Struct({
  question: Schema.String
});

export const AskUserTool = Tool.make("ask_user", {
  description:
    "Ask the user a free-text question and return their answer. Use this when you need clarification or additional information from the user.",
  parameters: AskUserParameters,
  success: Schema.String,
  failureMode: "return",
  dependencies: [Terminal.Terminal, FileSystem.FileSystem, Path.Path]
});

export type AskUserTool = typeof AskUserTool;

export const makeAskUserHandler =
  (nonInteractive: boolean) =>
  ({ question }: { question: string }, _context: Toolkit.HandlerContext<typeof AskUserTool>) =>
    Effect.gen(function* () {
      if (nonInteractive) {
        return yield* AiError.make({
          module: "AskUserTool",
          method: "askUserHandler",
          reason: new AiError.UnknownError({
            description: "Cannot ask user questions in non-interactive mode"
          })
        });
      }
      return yield* Prompt.run(Prompt.text({ message: question })).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            AiError.make({
              module: "AskUserTool",
              method: "askUserHandler",
              reason: new AiError.UnknownError({ description: String(cause) })
            })
          )
        )
      );
    });
