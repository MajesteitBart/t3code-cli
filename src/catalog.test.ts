import { describe, expect, it } from "vitest";

import { parseCatalog, renderCatalog, resolveModelChange, sameModelSelection } from "./catalog.js";

/** A trimmed copy of T3's `server.getConfig` providers, as served by 0.0.45. */
const CATALOG_FIXTURE = {
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      status: "ready",
      continuation: { groupKey: "codex:home" },
      showInteractionModeToggle: true,
      models: [
        {
          slug: "gpt-6.1-sol",
          name: "GPT-6.1-Sol",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              { id: "reasoningEffort", label: "Reasoning", type: "select", options: [{ id: "low", isDefault: true }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }] },
              { id: "serviceTier", label: "Speed", type: "select", options: [{ id: "default", isDefault: true }, { id: "priority" }] },
            ],
          },
        },
        {
          slug: "gpt-6-astra",
          name: "GPT-6-Astra",
          isDefault: true,
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              { id: "reasoningEffort", type: "select", options: [{ id: "low" }, { id: "medium", isDefault: true }, { id: "high" }] },
              { id: "serviceTier", type: "select", options: [{ id: "default", isDefault: true }, { id: "priority" }] },
            ],
          },
        },
      ],
    },
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude",
      enabled: true,
      status: "ready",
      continuation: { groupKey: "claude:home:one" },
      showInteractionModeToggle: true,
      models: [
        {
          slug: "claude-opus-5-5",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              { id: "effort", type: "select", options: [{ id: "low" }, { id: "medium", isDefault: true }, { id: "high" }, { id: "xhigh" }] },
              { id: "fastMode", type: "boolean" },
              { id: "contextWindow", type: "select", options: [{ id: "200k" }, { id: "1m", isDefault: true }] },
            ],
          },
        },
        {
          slug: "claude-sonnet-5-5",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              { id: "effort", type: "select", options: [{ id: "medium" }, { id: "high", isDefault: true }] },
              { id: "contextWindow", type: "select", options: [{ id: "200k", isDefault: true }, { id: "1m" }] },
            ],
          },
        },
      ],
    },
    {
      instanceId: "claudeAgent_two",
      driver: "claudeAgent",
      displayName: "Claude Two",
      enabled: true,
      status: "ready",
      continuation: { groupKey: "claude:home:two" },
      showInteractionModeToggle: true,
      models: [{ slug: "claude-opus-5-5", isCustom: false, capabilities: { optionDescriptors: [] } }],
    },
    {
      instanceId: "opencode",
      driver: "opencode",
      enabled: true,
      status: "ready",
      showInteractionModeToggle: false,
      models: [
        {
          slug: "openrouter/aion-3.5",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              { id: "variant", type: "select", options: [{ id: "low" }, { id: "high" }] },
              { id: "agent", type: "select", options: [{ id: "build", isDefault: true }, { id: "plan" }] },
            ],
          },
        },
      ],
    },
    { instanceId: "cursor", driver: "cursor", enabled: false, status: "disabled", models: [] },
  ],
};

const catalog = parseCatalog(CATALOG_FIXTURE);

describe("resolveModelChange", () => {
  it("maps reasoning effort and fast mode to each provider's option ids", () => {
    const codex = resolveModelChange(
      { instanceId: "codex", model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "low" }] },
      { thinkingEffort: "XHigh", speedMode: "fast" },
      catalog,
    );
    expect(codex).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [
        { id: "reasoningEffort", value: "xhigh" },
        { id: "serviceTier", value: "priority" },
      ],
    });

    const claude = resolveModelChange(
      { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      { thinkingEffort: "high", speedMode: "fast" },
      catalog,
    );
    expect(claude.options).toEqual([
      { id: "effort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    const opencode = resolveModelChange(
      { instanceId: "opencode", model: "openrouter/aion-3.5" },
      { thinkingEffort: "high" },
      catalog,
    );
    expect(opencode.options).toEqual([{ id: "variant", value: "high" }]);
  });

  it("turns fast mode on only with a tier named for speed", () => {
    const flexOnly = parseCatalog({
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          models: [
            {
              slug: "gpt-x",
              capabilities: { optionDescriptors: [{ id: "serviceTier", type: "select", options: [{ id: "default", isDefault: true }, { id: "flex" }] }] },
            },
          ],
        },
      ],
    });

    expect(() => resolveModelChange({ instanceId: "codex", model: "gpt-x" }, { speedMode: "fast" }, flexOnly)).toThrow(
      expect.objectContaining({ code: "MODEL_OPTION_UNSUPPORTED" }),
    );
  });

  it("turns fast mode off with the default service tier", () => {
    const standard = resolveModelChange(
      { instanceId: "codex", model: "gpt-6.1-sol", options: [{ id: "serviceTier", value: "priority" }] },
      { speedMode: "standard" },
      catalog,
    );
    expect(standard.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("carries supported settings to a new model and drops alias ids the model does not use", () => {
    const next = resolveModelChange(
      {
        instanceId: "codex",
        model: "gpt-6.1-sol",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "effort", value: "high" },
          { id: "fastMode", value: false },
          { id: "serviceTier", value: "priority" },
        ],
      },
      { model: "gpt-6-astra" },
      catalog,
    );
    expect(next).toEqual({
      instanceId: "codex",
      model: "gpt-6-astra",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ],
    });

    // xhigh is not valid on the new model, so it is dropped rather than carried.
    const dropped = resolveModelChange(
      { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "xhigh" }, { id: "fastMode", value: true }] },
      { model: "claude-sonnet-5-5" },
      catalog,
    );
    expect(dropped).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-5-5" });
  });

  it("sets raw provider options after checking them", () => {
    const next = resolveModelChange(
      { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      { options: [{ id: "contextWindow", value: "200K" }, { id: "fastMode", value: "on" }] },
      catalog,
    );
    expect(next.options).toEqual([
      { id: "contextWindow", value: "200k" },
      { id: "fastMode", value: true },
    ]);
  });

  it("rejects unknown providers, models, options, and values", () => {
    const base = { instanceId: "codex", model: "gpt-6.1-sol" };
    expect(() => resolveModelChange(base, { provider: "nope", model: "x" }, catalog)).toThrow(
      expect.objectContaining({ code: "PROVIDER_NOT_FOUND", exitCode: 2 }),
    );
    expect(() => resolveModelChange(base, { provider: "cursor", model: "x" }, catalog)).toThrow(
      expect.objectContaining({ code: "PROVIDER_DISABLED", exitCode: 4 }),
    );
    expect(() => resolveModelChange(base, { provider: "claudeAgent" }, catalog)).toThrow(
      expect.objectContaining({ code: "MODEL_REQUIRED_FOR_PROVIDER" }),
    );
    expect(() => resolveModelChange(base, { model: "gpt-9" }, catalog)).toThrow(
      expect.objectContaining({ code: "MODEL_NOT_FOUND" }),
    );
    expect(() => resolveModelChange(base, { thinkingEffort: "ultra" }, catalog)).toThrow(
      expect.objectContaining({ code: "INVALID_MODEL_OPTION", details: expect.objectContaining({ allowed: ["low", "medium", "high", "xhigh", "max"] }) }),
    );
    expect(() => resolveModelChange(base, { options: [{ id: "contextWindow", value: "1m" }] }, catalog)).toThrow(
      expect.objectContaining({ code: "INVALID_MODEL_OPTION" }),
    );
    expect(() =>
      resolveModelChange({ instanceId: "claudeAgent", model: "claude-sonnet-5-5" }, { speedMode: "fast" }, catalog),
    ).toThrow(expect.objectContaining({ code: "MODEL_OPTION_UNSUPPORTED" }));
  });
});

describe("sameModelSelection", () => {
  it("ignores option order", () => {
    expect(
      sameModelSelection(
        { instanceId: "codex", model: "m", options: [{ id: "a", value: "1" }, { id: "b", value: true }] },
        { instanceId: "codex", model: "m", options: [{ id: "b", value: true }, { id: "a", value: "1" }] },
      ),
    ).toBe(true);
    expect(sameModelSelection({ instanceId: "codex", model: "m" }, { instanceId: "codex", model: "n" })).toBe(false);
  });
});

describe("renderCatalog", () => {
  it("lists models with their options and marks defaults", () => {
    const rendered = renderCatalog({ providers: catalog.providers.slice(0, 1) }, false);

    expect(rendered).toBe(
      [
        "codex (Codex, driver codex): ready",
        "  gpt-6.1-sol  reasoningEffort: low*|medium|high|xhigh|max · serviceTier: default*|priority",
        "  gpt-6-astra (default)  reasoningEffort: low|medium*|high · serviceTier: default*|priority",
      ].join("\n"),
    );
    expect(renderCatalog({ providers: [catalog.providers[4]!] }, false)).toBe("cursor (cursor, driver cursor): disabled");
  });
});
