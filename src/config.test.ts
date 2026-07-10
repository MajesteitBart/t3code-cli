import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, normalizeConfig, setConfigValue } from "./config.js";

describe("config", () => {
  it("applies documented defaults", () => {
    expect(normalizeConfig({})).toMatchObject({
      ...DEFAULT_CONFIG,
      provider: "codex",
      model: "gpt-5.6-sol",
      speedMode: "fast",
      thinkingEffort: "xhigh",
      runtimeMode: "full-access",
    });
  });

  it("validates project and workspace policy", () => {
    expect(setConfigValue(DEFAULT_CONFIG, "projectPolicy", "existing").projectPolicy).toBe("existing");
    expect(setConfigValue(DEFAULT_CONFIG, "workspaceMode", "folder").workspaceMode).toBe("folder");
    expect(() => setConfigValue(DEFAULT_CONFIG, "projectPolicy", "sometimes")).toThrow(
      "projectPolicy must be create or existing",
    );
  });

  it("normalizes model selection overrides", () => {
    const config = normalizeConfig({
      provider: " claudeAgent ",
      model: " claude-sonnet-4-6 ",
      speedMode: "standard",
      thinkingEffort: " high ",
    });

    expect(config).toMatchObject({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      speedMode: "standard",
      thinkingEffort: "high",
    });
    expect(() => normalizeConfig({ speedMode: "turbo" })).toThrow("speedMode must be standard or fast");
  });
});
