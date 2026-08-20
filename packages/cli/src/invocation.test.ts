import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { resolveConfig } from "./invocation.ts";
import type { InvocationFlags } from "./invocation.ts";
import type { ConfigData } from "./config.ts";

const baseConfig: ConfigData = {
  provider: {
    type: "openai-compat",
    apiKey: "key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4o"
  },
  approvalMode: "none",
  maxTurns: 50,
  systemPrompt: "Base",
  nonInteractive: false
};

const noFlags: InvocationFlags = {
  model: Option.none(),
  maxTurns: Option.none(),
  approvalMode: Option.none(),
  systemPrompt: Option.none(),
  nonInteractive: false
};

describe("resolveConfig", () => {
  it("keeps appConfig values when no flags are set", () => {
    const resolved = resolveConfig(baseConfig, noFlags);
    expect(resolved).toEqual(baseConfig);
  });

  it("flag model overrides the appConfig model", () => {
    const resolved = resolveConfig(baseConfig, { ...noFlags, model: Option.some("claude-3-5-sonnet") });
    expect(resolved.provider.model).toBe("claude-3-5-sonnet");
  });

  it("flag maxTurns overrides the appConfig maxTurns", () => {
    const resolved = resolveConfig(baseConfig, { ...noFlags, maxTurns: Option.some(10) });
    expect(resolved.maxTurns).toBe(10);
  });

  it("flag approvalMode overrides the appConfig approvalMode", () => {
    const resolved = resolveConfig(baseConfig, { ...noFlags, approvalMode: Option.some("all") });
    expect(resolved.approvalMode).toBe("all");
  });

  it("flag systemPrompt overrides the appConfig systemPrompt", () => {
    const resolved = resolveConfig(baseConfig, { ...noFlags, systemPrompt: Option.some("Override") });
    expect(resolved.systemPrompt).toBe("Override");
  });

  it("nonInteractive flag sets nonInteractive true", () => {
    const resolved = resolveConfig(baseConfig, { ...noFlags, nonInteractive: true });
    expect(resolved.nonInteractive).toBe(true);
  });

  it("nonInteractive flag does not clear an appConfig-true nonInteractive", () => {
    const config = { ...baseConfig, nonInteractive: true };
    const resolved = resolveConfig(config, noFlags);
    expect(resolved.nonInteractive).toBe(true);
  });

  it("keeps appConfig fields that have no flag override", () => {
    const resolved = resolveConfig(baseConfig, {
      ...noFlags,
      model: Option.some("claude-3-5-sonnet")
    });
    expect(resolved.provider.apiKey).toBe("key");
    expect(resolved.provider.baseUrl).toBe("https://api.example.com/v1");
    expect(resolved.approvalMode).toBe("none");
    expect(resolved.maxTurns).toBe(50);
    expect(resolved.systemPrompt).toBe("Base");
  });
});
