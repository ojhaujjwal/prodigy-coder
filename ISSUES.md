# Known Issues

## Minimax/Bedrock Streaming Incompleteness

**Provider**: `minimax.minimax-m2.5` via AWS Bedrock OpenAI-compatible API

### Problem
The minimax model does not properly complete streaming responses when tool calling. It sends:
- `tool-params-start` (with tool name and ID)
- `tool-params-delta` (with JSON parameters)

But **never sends**:
- `tool-params-end` (to signal completion)
- `finish` event (to signal response end)

This causes Effect's `LanguageModel.streamText` to:
1. Never assemble complete `tool-call` events from partial streaming events
2. Never emit a `finish` event, causing the agent loop to run infinitely

### Symptoms
- Agent loop stuck on same messages forever
- No tool calls executed despite LLM attempting to call them
- `finished` flag never becomes `true`
- Same request sent repeatedly with identical payload

### Workaround
Manual tool call assembly and execution:
1. Track `tool-params-start` and `tool-params-delta` events in a pending map
2. On stream completion, assemble any pending tool calls from accumulated deltas
3. Manually execute tool calls using handler context (`effect/ai/Tool/{name}`)
4. Mark turn as finished when no tool calls are made (since LLM never sends `finish`)

### Affected Code
- `src/agent.ts` - stream processing loop needs manual assembly/execution
- Only needed for providers that don't properly complete streaming sequences

### Proper providers
OpenAI, Anthropic, and other well-behaved providers send complete streaming sequences and work correctly with Effect's built-in tool execution.
