import * as AiError from "effect/unstable/ai/AiError"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import { Effect, Layer, Stream } from "effect"
import type { Session, Message } from "./session.ts"
import type { ConfigData } from "./config.ts"
import { needsApproval } from "./approval.ts"
import type { OutputEvent } from "./output.ts"

export interface AgentConfig {
  readonly session: Session
  readonly config: ConfigData
  readonly handlers: Record<string, (params: unknown) => Effect.Effect<string, AiError.AiError>>
}

const executeTool = (
  toolName: string,
  params: unknown,
  handlers: Record<string, (params: unknown) => Effect.Effect<string, AiError.AiError>>
): Effect.Effect<{ result: string; isError: boolean }> => {
  const handler = handlers[toolName]
  if (!handler) {
    return Effect.succeed({ result: `Unknown tool: ${toolName}`, isError: true })
  }
  return Effect.matchEffect(handler(params), {
    onSuccess: (result) => Effect.succeed({ result, isError: false }),
    onFailure: (error) => {
      const message = error.reason instanceof Error ? error.reason.message : "Unknown error"
      return Effect.succeed({ result: `Tool error: ${message}`, isError: true })
    },
  })
}

const toolCallToOutputEvent = (part: Response.ToolCallPart<string, unknown>): OutputEvent => ({
  type: "tool-call",
  id: part.id,
  name: part.name,
  params: part.params,
})

const toolResultToOutputEvent = (
  id: string,
  name: string,
  result: string,
  isError: boolean
): OutputEvent => ({
  type: "tool-result",
  id,
  name,
  result,
  isError,
})

const messageToEncoded = (msg: Message): Prompt.MessageEncoded => {
  if (msg.role === "system") {
    return { role: "system", content: msg.content }
  }
  if (msg.role === "user") {
    return { role: "user", content: [{ type: "text", text: msg.content }] }
  }
  return { role: "assistant", content: [{ type: "text", text: msg.content }] }
}

export const runAgent = (
  promptText: string,
  agentConfig: AgentConfig,
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>
): Effect.Effect<OutputEvent[], AiError.AiError | Error> =>
  Effect.gen(function* () {
    const { session, config, handlers } = agentConfig

    const messages: Message[] = [...session.messages]

    if (messages.length === 0 && config.systemPrompt) {
      messages.push({ role: "system", content: config.systemPrompt })
    }

    messages.push({ role: "user", content: promptText })

    const outputEvents: OutputEvent[] = []
    let turnCount = 0
    let finished = false

    while (!finished && turnCount < config.maxTurns) {
      turnCount++

      const promptMessages: Prompt.MessageEncoded[] = messages.map(messageToEncoded)

      const llmStream = LanguageModel.streamText({
        prompt: promptMessages,
        disableToolCallResolution: true,
      })

      yield* llmStream.pipe(
        Stream.mapEffect((part: Response.AnyPart) => Effect.succeed(part)),
        Stream.runForEach((part) => {
          switch (part.type) {
            case "text-delta":
              outputEvents.push({ type: "text-delta", delta: part.delta })
              return Effect.void
            case "tool-call": {
              outputEvents.push(toolCallToOutputEvent(part))
              const approved = needsApproval(part.name, config.approvalMode)
              if (approved && config.approvalMode !== "none") {
                outputEvents.push({
                  type: "tool-approval-request",
                  id: crypto.randomUUID(),
                  toolCallId: part.id,
                  toolName: part.name,
                })
              }
              return Effect.gen(function* () {
                const execResult = yield* executeTool(part.name, part.params, handlers)
                outputEvents.push(toolResultToOutputEvent(part.id, part.name, execResult.result, execResult.isError))
              })
            }
            case "finish":
              finished = true
              outputEvents.push({ type: "finish", text: part.reason || "" })
              return Effect.void
            default:
              return Effect.void
          }
        }),
        Effect.provide(providerLayer)
      )

      const toolResults = outputEvents.filter((e) => e.type === "tool-result")
      for (const toolResult of toolResults) {
        if (toolResult.type === "tool-result") {
          messages.push({
            role: "assistant",
            content: "",
          })
          messages.push({
            role: "assistant",
            content: `[tool result: ${toolResult.name}] ${toolResult.result}`,
          })
        }
      }
    }

    if (!finished) {
      outputEvents.push({ type: "error", message: "Max turns exceeded" })
    }

    return outputEvents
  })
