import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BunServices } from "@effect/platform-bun";
import { ApprovalGate, makeApprovalGateLayer } from "./approval-gate.ts";
import type { ConfigData } from "./config.ts";

const createConfig = (overrides?: Partial<ConfigData>): ConfigData => ({
  provider: {
    type: "openai-compat" as const,
    apiKey: "test-key",
    baseUrl: "http://localhost:0",
    model: "test-model"
  },
  approvalMode: "none",
  maxTurns: 10,
  systemPrompt: undefined,
  nonInteractive: false,
  ...overrides
});

const withApprovalGate = <A, E>(config: ConfigData, effect: Effect.Effect<A, E, ApprovalGate>) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(makeApprovalGateLayer(config));
    return yield* effect.pipe(Effect.provide(context));
  });

layer(BunServices.layer)("approval-gate", (it) => {
  it.effect('"none" mode always approves', () =>
    withApprovalGate(
      createConfig({ approvalMode: "none" }),
      Effect.gen(function* () {
        const gate = yield* ApprovalGate;
        const result = yield* gate.approve("shell", { command: "ls" });
        expect(result).toBe(true);
      })
    )
  );

  it.effect('"dangerous" mode approves non-dangerous tools', () =>
    withApprovalGate(
      createConfig({ approvalMode: "dangerous" }),
      Effect.gen(function* () {
        const gate = yield* ApprovalGate;
        const result = yield* gate.approve("read", { filePath: "/test.txt" });
        expect(result).toBe(true);
      })
    )
  );

  it.effect('"dangerous" mode denies dangerous tools when non-interactive', () =>
    withApprovalGate(
      createConfig({ approvalMode: "dangerous", nonInteractive: true }),
      Effect.gen(function* () {
        const gate = yield* ApprovalGate;
        const result = yield* gate.approve("shell", { command: "ls" });
        expect(result).toBe(false);
      })
    )
  );

  it.effect('"all" mode denies all tools when non-interactive', () =>
    withApprovalGate(
      createConfig({ approvalMode: "all", nonInteractive: true }),
      Effect.gen(function* () {
        const gate = yield* ApprovalGate;
        const result = yield* gate.approve("read", { filePath: "/test.txt" });
        expect(result).toBe(false);
      })
    )
  );

  it.effect("non-interactive auto-denies without prompting", () =>
    withApprovalGate(
      createConfig({ approvalMode: "dangerous", nonInteractive: true }),
      Effect.gen(function* () {
        const gate = yield* ApprovalGate;
        const result = yield* gate.approve("shell", { command: "ls" });
        expect(result).toBe(false);
      })
    )
  );
});
