import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, normalizeConfig, setConfigValue } from "./config.js";

describe("config", () => {
  it("applies documented defaults", () => {
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG).toMatchObject({ runtimeMode: "full-access" });
    expect(DEFAULT_CONFIG).not.toHaveProperty("provider");
    expect(DEFAULT_CONFIG).not.toHaveProperty("model");
    expect(DEFAULT_CONFIG).not.toHaveProperty("speedMode");
    expect(DEFAULT_CONFIG).not.toHaveProperty("thinkingEffort");
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
