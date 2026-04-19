import * as HttpClient from "effect/unstable/http/HttpClient"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

const WebFetchParameters = Schema.Struct({
  url: Schema.String,
})

export const WebFetchTool = Tool.make("webfetch", {
  description: "Fetch web content from a URL",
  parameters: WebFetchParameters,
  success: Schema.String,
})

export type WebFetchTool = typeof WebFetchTool

export const webfetchHandler = ({ url }: { url: string }) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(url)
    const content = yield* response.text
    return content
  })