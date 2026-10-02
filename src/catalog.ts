import type { T3Api } from "./api.js";
import { CliError } from "./errors.js";
import type { ModelSelection, ProviderOptionSelection, SpeedMode } from "./types.js";

export interface OptionDescriptor {
  id: string;
  label: string | null;
  type: "select" | "boolean";
  /** Allowed values of a select option; the default is marked. */
  values: Array<{ id: string; label: string | null; isDefault: boolean }>;
}

export interface CatalogModel {
  slug: string;
  name: string | null;
  aliases: string[];
  isDefault: boolean;
  isCustom: boolean;
  /** Null when T3 does not describe the model's options. */
  options: OptionDescriptor[] | null;
}

export interface CatalogProvider {
  instanceId: string;
  driver: string;
  displayName: string | null;
  enabled: boolean;
  status: string | null;
  /** Instances can only share a thread when their resume state is compatible. */
  continuationKey: string | null;
  supportsPlanMode: boolean;
  models: CatalogModel[];
}

export interface ProviderCatalog {
  providers: CatalogProvider[];
}

/** The model settings a caller asks to change; anything left out keeps its current value. */
export interface ModelChange {
  provider?: string | undefined;
  model?: string | undefined;
  thinkingEffort?: string | undefined;
  speedMode?: SpeedMode | undefined;
  options?: ProviderOptionSelection[] | undefined;
}

/** T3 drivers name the same reasoning control differently; OpenCode calls it a variant. */
const EFFORT_OPTION_IDS = ["reasoningEffort", "effort", "reasoning", "variant"];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseDescriptor(value: unknown): OptionDescriptor[] {
  const descriptor = record(value);
  if (!descriptor || typeof descriptor.id !== "string") return [];
  if (descriptor.type !== "select" && descriptor.type !== "boolean") return [];
  return [{
    id: descriptor.id,
    label: string(descriptor.label),
    type: descriptor.type,
    values: list(descriptor.options).flatMap((entry) => {
      const option = record(entry);
      return typeof option?.id === "string"
        ? [{ id: option.id, label: string(option.label), isDefault: option.isDefault === true }]
        : [];
    }),
  }];
}

/** Reads the provider list from T3's `server.getConfig` response. */
export function parseCatalog(config: unknown): ProviderCatalog {
  return {
    providers: list(record(config)?.providers).flatMap((entry) => {
      const provider = record(entry);
      if (!provider || typeof provider.instanceId !== "string") return [];
      return [{
        instanceId: provider.instanceId,
        driver: string(provider.driver) ?? provider.instanceId,
        displayName: string(provider.displayName),
        enabled: provider.enabled !== false,
        status: string(provider.status),
        continuationKey: string(record(provider.continuation)?.groupKey),
        supportsPlanMode: provider.showInteractionModeToggle === true,
        models: list(provider.models).flatMap((value) => {
          const model = record(value);
          if (!model || typeof model.slug !== "string") return [];
          const capabilities = record(model.capabilities);
          return [{
            slug: model.slug,
            name: string(model.name),
            aliases: list(model.aliases).filter((alias): alias is string => typeof alias === "string"),
            isDefault: model.isDefault === true,
            isCustom: model.isCustom === true,
            options: Array.isArray(capabilities?.optionDescriptors)
              ? capabilities.optionDescriptors.flatMap(parseDescriptor)
              : null,
          }];
        }),
      }];
    }),
  };
}

/** T3 serves its provider catalog only over WebSocket RPC. */
export async function fetchCatalog(api: T3Api): Promise<ProviderCatalog> {
  try {
    return parseCatalog(await api.rpc("server.getConfig", {}));
  } catch (cause) {
    throw new CliError("T3_CATALOG_UNAVAILABLE", "T3 did not return its provider and model catalog.", { cause });
  }
}

export function findProvider(catalog: ProviderCatalog, instanceId: string): CatalogProvider | null {
  return catalog.providers.find((provider) => provider.instanceId === instanceId) ?? null;
}

export function findModel(provider: CatalogProvider, slug: string): CatalogModel | null {
  return provider.models.find((model) => model.slug === slug || model.aliases.includes(slug)) ?? null;
}

function invalid(code: string, message: string, details: Record<string, unknown>): CliError {
  return new CliError(code, message, { exitCode: 2, details });
}

function selectValue(descriptor: OptionDescriptor, requested: string, modelSlug: string): string {
  const match = descriptor.values.find((value) => value.id.toLowerCase() === requested.trim().toLowerCase());
  if (match) return match.id;
  throw invalid(
    "INVALID_MODEL_OPTION",
    `${modelSlug} does not accept ${descriptor.id}=${requested}. Allowed: ${descriptor.values.map((value) => value.id).join(", ")}.`,
    { option: descriptor.id, value: requested, allowed: descriptor.values.map((value) => value.id) },
  );
}

function booleanValue(descriptor: OptionDescriptor, requested: string | boolean): boolean {
  if (typeof requested === "boolean") return requested;
  const normalized = requested.trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(normalized)) return true;
  if (["false", "off", "no", "0"].includes(normalized)) return false;
  throw invalid("INVALID_MODEL_OPTION", `${descriptor.id} takes true or false, not ${requested}.`, {
    option: descriptor.id,
    value: requested,
  });
}

function validValue(descriptor: OptionDescriptor, value: string | boolean): boolean {
  return descriptor.type === "boolean"
    ? typeof value === "boolean"
    : typeof value === "string" && descriptor.values.some((candidate) => candidate.id === value);
}

function setOption(options: ProviderOptionSelection[], id: string, value: string | boolean): void {
  const existing = options.find((option) => option.id === id);
  if (existing) existing.value = value;
  else options.push({ id, value });
}

/** The value that turns fast mode on or off, for models whose fast mode is a service tier. */
function serviceTierValue(descriptor: OptionDescriptor, fast: boolean): string | null {
  if (!fast) return descriptor.values.find((value) => value.isDefault || value.id === "default")?.id ?? null;
  return (
    descriptor.values.find((value) => value.id === "priority" || value.id === "fast")?.id ??
    descriptor.values.find((value) => !value.isDefault && value.id !== "default")?.id ??
    null
  );
}

/**
 * Resolves a thread's next model selection against T3's catalog. It checks the provider, model, and
 * option values, maps reasoning effort and fast mode to the option ids the model uses, carries
 * supported settings across a model change, and drops option ids the model does not have.
 */
export function resolveModelChange(current: ModelSelection, change: ModelChange, catalog: ProviderCatalog): ModelSelection {
  const instanceId = change.provider?.trim() || current.instanceId;
  const provider = findProvider(catalog, instanceId);
  if (!provider) {
    throw invalid("PROVIDER_NOT_FOUND", `T3 has no provider instance ${instanceId}.`, {
      provider: instanceId,
      available: catalog.providers.map((candidate) => candidate.instanceId),
    });
  }
  if (!provider.enabled) {
    throw new CliError("PROVIDER_DISABLED", `Provider instance ${instanceId} is disabled in T3 Code.`, {
      exitCode: 4,
      details: { provider: instanceId, status: provider.status },
    });
  }
  if (instanceId !== current.instanceId && !change.model?.trim()) {
    throw invalid("MODEL_REQUIRED_FOR_PROVIDER", `Select the ${instanceId} model with --model.`, {
      provider: instanceId,
      threadProvider: current.instanceId,
    });
  }
  const requestedSlug = change.model?.trim() || current.model;
  const model = findModel(provider, requestedSlug);
  if (!model) {
    throw invalid(
      "MODEL_NOT_FOUND",
      `${instanceId} has no model ${requestedSlug}. Run t3code models list --provider ${instanceId} to see its models.`,
      { provider: instanceId, model: requestedSlug },
    );
  }

  const sameModel = instanceId === current.instanceId && model.slug === current.model;
  const descriptors = model.options;
  const carried = (current.options ?? []).filter((option) => {
    if (descriptors === null) return sameModel;
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    return descriptor !== undefined && validValue(descriptor, option.value);
  });
  const options = carried.map((option) => ({ ...option }));
  const descriptor = (id: string) => descriptors?.find((candidate) => candidate.id === id);

  if (change.thinkingEffort !== undefined) {
    const effort = EFFORT_OPTION_IDS.map(descriptor).find((candidate) => candidate?.type === "select");
    if (!effort) {
      throw invalid("MODEL_OPTION_UNSUPPORTED", `${model.slug} has no reasoning effort setting.`, { model: model.slug });
    }
    setOption(options, effort.id, selectValue(effort, change.thinkingEffort, model.slug));
  }
  if (change.speedMode !== undefined) {
    const fast = change.speedMode === "fast";
    const fastMode = descriptor("fastMode");
    const serviceTier = descriptor("serviceTier");
    const tier = serviceTier?.type === "select" ? serviceTierValue(serviceTier, fast) : null;
    if (fastMode?.type === "boolean") setOption(options, fastMode.id, fast);
    else if (serviceTier && tier) setOption(options, serviceTier.id, tier);
    else if (fast) {
      throw invalid("MODEL_OPTION_UNSUPPORTED", `${model.slug} has no fast mode.`, { model: model.slug });
    }
  }
  for (const option of change.options ?? []) {
    const target = descriptor(option.id);
    if (descriptors !== null && !target) {
      throw invalid(
        "INVALID_MODEL_OPTION",
        `${model.slug} has no option ${option.id}. Options: ${descriptors.map((candidate) => candidate.id).join(", ") || "none"}.`,
        { option: option.id, available: descriptors.map((candidate) => candidate.id) },
      );
    }
    const value = !target
      ? option.value
      : target.type === "boolean"
        ? booleanValue(target, option.value)
        : selectValue(target, String(option.value), model.slug);
    setOption(options, option.id, value);
  }

  return { instanceId, model: model.slug, ...(options.length > 0 ? { options } : {}) };
}

export function sameModelSelection(left: ModelSelection | null | undefined, right: ModelSelection | null | undefined): boolean {
  if (!left || !right) return left === right;
  const normalize = (selection: ModelSelection) =>
    JSON.stringify([...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
  return left.instanceId === right.instanceId && left.model === right.model && normalize(left) === normalize(right);
}

function describeOption(option: OptionDescriptor): string {
  if (option.type === "boolean") return `${option.id}: true|false`;
  return `${option.id}: ${option.values.map((value) => `${value.id}${value.isDefault ? "*" : ""}`).join("|")}`;
}

/** Large catalogs, such as OpenCode's hundreds of models, are summarized unless asked for. */
const LISTED_MODEL_LIMIT = 40;

export function renderCatalog(catalog: ProviderCatalog, expand: boolean): string {
  return catalog.providers
    .map((provider) => {
      const state = provider.enabled ? (provider.status ?? "unknown") : "disabled";
      const heading = `${provider.instanceId} (${provider.displayName ?? provider.driver}, driver ${provider.driver}): ${state}`;
      if (!provider.enabled || provider.models.length === 0) return heading;
      if (!expand && provider.models.length > LISTED_MODEL_LIMIT) {
        return `${heading}\n  ${provider.models.length} models; list them with --provider ${provider.instanceId}`;
      }
      const models = provider.models.map((model) => {
        const options = model.options?.map(describeOption).join(" · ");
        return `  ${model.slug}${model.isDefault ? " (default)" : ""}${options ? `  ${options}` : ""}`;
      });
      return [heading, ...models].join("\n");
    })
    .join("\n\n");
}
