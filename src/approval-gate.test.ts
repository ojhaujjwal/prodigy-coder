import { describe, it, expect } from "@effect/vitest";
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

describe("approval-gate", () => {
  it.effect('"none" mode always approves', () =>
    Effect.gen(function* () {
      const gate = yield* ApprovalGate;
      const result = yield* gate.approve("shell", { command: "ls" });
      expect(result).toBe(true);
    }).pipe(
      Effect.provide(Layer.merge(makeApprovalGateLayer(createConfig({ approvalMode: "none" })), BunServices.layer))
    )
  );

  it.effect('"dangerous" mode approves non-dangerous tools', () =>
    Effect.gen(function* () {
      const gate = yield* ApprovalGate;
      const result = yield* gate.approve("read", { filePath: "/test.txt" });
      expect(result).toBe(true);
    }).pipe(
      Effect.provide(Layer.merge(makeApprovalGateLayer(createConfig({ approvalMode: "dangerous" })), BunServices.layer))
    )
  );

  it.effect('"dangerous" mode denies dangerous tools when non-interactive', () =>
    Effect.gen(function* () {
      const gate = yield* ApprovalGate;
      const result = yield* gate.approve("shell", { command: "ls" });
      expect(result).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeApprovalGateLayer(createConfig({ approvalMode: "dangerous", nonInteractive: true })),
          BunServices.layer
        )
      )
    )
  );

  it.effect('"all" mode denies all tools when non-interactive', () =>
    Effect.gen(function* () {
      const gate = yield* ApprovalGate;
      const result = yield* gate.approve("read", { filePath: "/test.txt" });
      expect(result).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeApprovalGateLayer(createConfig({ approvalMode: "all", nonInteractive: true })),
          BunServices.layer
        )
      )
    )
  );

  it.effect("non-interactive auto-denies without prompting", () =>
    Effect.gen(function* () {
      const gate = yield* ApprovalGate;
      const result = yield* gate.approve("shell", { command: "ls" });
      expect(result).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeApprovalGateLayer(createConfig({ approvalMode: "none", nonInteractive: true })),
          BunServices.layer
        )
      )
    )
  );

  it.effect("non-TTY stdin auto-denies without prompting", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line prodigy/no-process
      const stdin = globalThis.process.stdin;
      const originalIsTTY: boolean | undefined = stdin.isTTY;
      stdin.isTTY = false;

      const gate = yield* ApprovalGate;
      const result = yield* gate.approve("shell", { command: "ls" });
      expect(result).toBe(false);

      stdin.isTTY = originalIsTTY;
    }).pipe(
      Effect.provide(Layer.merge(makeApprovalGateLayer(createConfig({ approvalMode: "dangerous" })), BunServices.layer))
    )
  );
});
