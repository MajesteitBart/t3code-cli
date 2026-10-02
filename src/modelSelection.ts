import { CliError } from "./errors.js";
import type { ModelSelection, ProviderOptionSelection, SpeedMode } from "./types.js";

export function nonEmptyOption(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new CliError("INVALID_THREAD_OPTION", `${name} must be a non-empty string.`);
  return trimmed;
}

export function normalizeProviderOptions(options: unknown): ProviderOptionSelection[] {
  if (Array.isArray(options)) {
    return options.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const candidate = entry as Record<string, unknown>;
      const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
      const value = candidate.value;
      return id && (typeof value === "string" || typeof value === "boolean") ? [{ id, value }] : [];
    });
  }
  if (options !== null && typeof options === "object") {
    return Object.entries(options).flatMap(([id, value]) =>
      id.trim() && (typeof value === "string" || typeof value === "boolean") ? [{ id: id.trim(), value }] : [],
    );
  }
  return [];
}

export function setProviderOption(
  selections: ProviderOptionSelection[],
  id: string,
  value: string | boolean,
): void {
  const existing = selections.find((selection) => selection.id === id);
  if (existing) existing.value = value;
  else selections.push({ id, value });
}

export interface ModelOverrides {
  provider?: string | undefined;
  model?: string | undefined;
  speedMode?: SpeedMode | undefined;
  thinkingEffort?: string | undefined;
  /** Provider option ids and values to set, such as `contextWindow=1m`. */
  options?: ProviderOptionSelection[] | undefined;
}

/** Applies explicit overrides to a saved model selection; `owner` names the selection in errors. */
export function applyModelOverrides(
  base: ModelSelection,
  overrides: ModelOverrides,
  owner: "project default" | "thread",
): ModelSelection {
  const provider = nonEmptyOption(overrides.provider, "provider");
  const requestedModel = nonEmptyOption(overrides.model, "model");
  const thinkingEffort = nonEmptyOption(overrides.thinkingEffort, "thinking effort");
  const instanceId = provider ?? base.instanceId;
  if (provider !== undefined && provider !== base.instanceId && requestedModel === undefined) {
    throw new CliError(
      "MODEL_REQUIRED_FOR_PROVIDER",
      `Provider instance ${provider} differs from the ${owner}; select its model with --model.`,
      { details: { provider, [owner === "thread" ? "threadProvider" : "projectProvider"]: base.instanceId } },
    );
  }
  const model = requestedModel ?? base.model;
  const selectionChanged = instanceId !== base.instanceId || model !== base.model;
  const selections = selectionChanged ? [] : normalizeProviderOptions(base.options);

  if (overrides.speedMode !== undefined) {
    setProviderOption(selections, "serviceTier", overrides.speedMode === "fast" ? "fast" : "default");
    setProviderOption(selections, "fastMode", overrides.speedMode === "fast");
  }
  if (thinkingEffort !== undefined) {
    // T3 provider drivers use different descriptor ids for the same user-facing control.
    setProviderOption(selections, "reasoningEffort", thinkingEffort);
    setProviderOption(selections, "effort", thinkingEffort);
    setProviderOption(selections, "reasoning", thinkingEffort);
  }
  for (const option of overrides.options ?? []) setProviderOption(selections, option.id, option.value);

  return {
    instanceId,
    model,
    ...(selections.length > 0 ? { options: selections } : {}),
  };
}
