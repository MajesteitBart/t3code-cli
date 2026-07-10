import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliError } from "./errors.js";
import type {
  CliConfig,
  InteractionMode,
  OpenMode,
  ProjectPolicy,
  RuntimeMode,
  SpeedMode,
  ThreadEnvMode,
  WorkspaceMode,
} from "./types.js";

export const DEFAULT_CONFIG: CliConfig = {
  projectPolicy: "create",
  workspaceMode: "repo",
  openMode: "auto",
  threadEnvMode: "t3",
  runtimeMode: "full-access",
  interactionMode: "default",
  provider: "codex",
  model: "gpt-5.6-sol",
  speedMode: "fast",
  thinkingEffort: "xhigh",
  sessionTtl: "2m",
};

const projectPolicies = new Set<ProjectPolicy>(["create", "existing"]);
const workspaceModes = new Set<WorkspaceMode>(["repo", "folder"]);
const openModes = new Set<OpenMode>(["auto", "desktop", "browser", "none"]);
const threadEnvModes = new Set<ThreadEnvMode>(["t3", "local", "worktree"]);
const runtimeModes = new Set<RuntimeMode>([
  "approval-required",
  "auto-accept-edits",
  "full-access",
]);
const interactionModes = new Set<InteractionMode>(["default", "plan"]);
const speedModes = new Set<SpeedMode>(["standard", "fast"]);

export const CONFIG_KEYS = [
  "projectPolicy",
  "workspaceMode",
  "openMode",
  "threadEnvMode",
  "runtimeMode",
  "interactionMode",
  "provider",
  "model",
  "speedMode",
  "thinkingEffort",
  "sessionTtl",
  "t3Home",
  "origin",
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function defaultConfigPath(): string {
  if (process.env.T3CODE_CLI_CONFIG) return path.resolve(expandHome(process.env.T3CODE_CLI_CONFIG));
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "t3code-cli", "config.json");
  }
  const root = process.env.XDG_CONFIG_HOME
    ? path.resolve(expandHome(process.env.XDG_CONFIG_HOME))
    : path.join(os.homedir(), ".config");
  return path.join(root, "t3code-cli", "config.json");
}

function asString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliError("INVALID_CONFIG", `${key} must be a non-empty string.`);
  }
  return value.trim();
}

export function normalizeConfig(raw: unknown): CliConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError("INVALID_CONFIG", "The config file must contain a JSON object.");
  }
  const input = raw as Record<string, unknown>;
  const result: CliConfig = { ...DEFAULT_CONFIG };

  if (input.projectPolicy !== undefined) {
    const value = asString(input.projectPolicy, "projectPolicy") as ProjectPolicy;
    if (!projectPolicies.has(value)) throw new CliError("INVALID_CONFIG", "projectPolicy must be create or existing.");
    result.projectPolicy = value;
  }
  if (input.workspaceMode !== undefined) {
    const value = asString(input.workspaceMode, "workspaceMode") as WorkspaceMode;
    if (!workspaceModes.has(value)) throw new CliError("INVALID_CONFIG", "workspaceMode must be repo or folder.");
    result.workspaceMode = value;
  }
  if (input.openMode !== undefined) {
    const value = asString(input.openMode, "openMode") as OpenMode;
    if (!openModes.has(value)) throw new CliError("INVALID_CONFIG", "openMode is invalid.");
    result.openMode = value;
  }
  if (input.threadEnvMode !== undefined) {
    const value = asString(input.threadEnvMode, "threadEnvMode") as ThreadEnvMode;
    if (!threadEnvModes.has(value)) throw new CliError("INVALID_CONFIG", "threadEnvMode is invalid.");
    result.threadEnvMode = value;
  }
  if (input.runtimeMode !== undefined) {
    const value = asString(input.runtimeMode, "runtimeMode") as RuntimeMode;
    if (!runtimeModes.has(value)) throw new CliError("INVALID_CONFIG", "runtimeMode is invalid.");
    result.runtimeMode = value;
  }
  if (input.interactionMode !== undefined) {
    const value = asString(input.interactionMode, "interactionMode") as InteractionMode;
    if (!interactionModes.has(value)) throw new CliError("INVALID_CONFIG", "interactionMode is invalid.");
    result.interactionMode = value;
  }
  if (input.provider !== undefined) result.provider = asString(input.provider, "provider");
  if (input.model !== undefined) result.model = asString(input.model, "model");
  if (input.speedMode !== undefined) {
    const value = asString(input.speedMode, "speedMode") as SpeedMode;
    if (!speedModes.has(value)) throw new CliError("INVALID_CONFIG", "speedMode must be standard or fast.");
    result.speedMode = value;
  }
  if (input.thinkingEffort !== undefined) {
    result.thinkingEffort = asString(input.thinkingEffort, "thinkingEffort");
  }
  if (input.sessionTtl !== undefined) result.sessionTtl = asString(input.sessionTtl, "sessionTtl");
  if (input.t3Home !== undefined) result.t3Home = path.resolve(expandHome(asString(input.t3Home, "t3Home")));
  if (input.origin !== undefined) result.origin = new URL(asString(input.origin, "origin")).origin;
  if (input.t3Command !== undefined) {
    if (!Array.isArray(input.t3Command) || !input.t3Command.every((value) => typeof value === "string" && value.length > 0)) {
      throw new CliError("INVALID_CONFIG", "t3Command must be an array of command arguments.");
    }
    result.t3Command = [...input.t3Command];
  }
  return applyEnvironmentOverrides(result);
}

function applyEnvironmentOverrides(config: CliConfig): CliConfig {
  const next = { ...config };
  if (process.env.T3CODE_HOME) next.t3Home = path.resolve(expandHome(process.env.T3CODE_HOME));
  if (process.env.T3CODE_CLI_ORIGIN) next.origin = new URL(process.env.T3CODE_CLI_ORIGIN).origin;
  if (process.env.T3CODE_CLI_PROJECT_POLICY) next.projectPolicy = process.env.T3CODE_CLI_PROJECT_POLICY as ProjectPolicy;
  if (process.env.T3CODE_CLI_WORKSPACE_MODE) next.workspaceMode = process.env.T3CODE_CLI_WORKSPACE_MODE as WorkspaceMode;
  if (process.env.T3CODE_CLI_OPEN_MODE) next.openMode = process.env.T3CODE_CLI_OPEN_MODE as OpenMode;
  if (process.env.T3CODE_CLI_THREAD_ENV_MODE) next.threadEnvMode = process.env.T3CODE_CLI_THREAD_ENV_MODE as ThreadEnvMode;
  if (process.env.T3CODE_CLI_RUNTIME_MODE) next.runtimeMode = process.env.T3CODE_CLI_RUNTIME_MODE as RuntimeMode;
  if (process.env.T3CODE_CLI_INTERACTION_MODE) next.interactionMode = process.env.T3CODE_CLI_INTERACTION_MODE as InteractionMode;
  if (process.env.T3CODE_CLI_PROVIDER) next.provider = process.env.T3CODE_CLI_PROVIDER;
  if (process.env.T3CODE_CLI_MODEL) next.model = process.env.T3CODE_CLI_MODEL;
  if (process.env.T3CODE_CLI_SPEED_MODE) next.speedMode = process.env.T3CODE_CLI_SPEED_MODE as SpeedMode;
  if (process.env.T3CODE_CLI_THINKING_EFFORT) next.thinkingEffort = process.env.T3CODE_CLI_THINKING_EFFORT;
  if (process.env.T3CODE_CLI_T3_COMMAND) {
    const parsed = JSON.parse(process.env.T3CODE_CLI_T3_COMMAND) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new CliError("INVALID_CONFIG", "T3CODE_CLI_T3_COMMAND must be a JSON string array.");
    }
    next.t3Command = parsed;
  }
  return normalizeConfigValues(next);
}

function normalizeConfigValues(config: CliConfig): CliConfig {
  const withoutEnvironment = { ...config };
  if (!projectPolicies.has(withoutEnvironment.projectPolicy)) throw new CliError("INVALID_CONFIG", "Invalid project policy override.");
  if (!workspaceModes.has(withoutEnvironment.workspaceMode)) throw new CliError("INVALID_CONFIG", "Invalid workspace mode override.");
  if (!openModes.has(withoutEnvironment.openMode)) throw new CliError("INVALID_CONFIG", "Invalid open mode override.");
  if (!threadEnvModes.has(withoutEnvironment.threadEnvMode)) throw new CliError("INVALID_CONFIG", "Invalid thread env mode override.");
  if (!runtimeModes.has(withoutEnvironment.runtimeMode)) throw new CliError("INVALID_CONFIG", "Invalid runtime mode override.");
  if (!interactionModes.has(withoutEnvironment.interactionMode)) throw new CliError("INVALID_CONFIG", "Invalid interaction mode override.");
  if (withoutEnvironment.speedMode !== undefined && !speedModes.has(withoutEnvironment.speedMode)) {
    throw new CliError("INVALID_CONFIG", "Invalid speed mode override.");
  }
  return withoutEnvironment;
}

export async function loadConfig(explicitPath?: string): Promise<{ config: CliConfig; path: string; exists: boolean }> {
  const configPath = path.resolve(expandHome(explicitPath ?? defaultConfigPath()));
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return { config: normalizeConfig(raw), path: configPath, exists: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { config: applyEnvironmentOverrides({ ...DEFAULT_CONFIG }), path: configPath, exists: false };
    if (error instanceof CliError) throw error;
    throw new CliError("CONFIG_READ_FAILED", `Could not read config at ${configPath}.`, { cause: error });
  }
}

export async function saveConfig(configPath: string, config: CliConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function setConfigValue(config: CliConfig, key: ConfigKey, rawValue: string): CliConfig {
  const input = { ...config, [key]: rawValue };
  return normalizeConfig(input);
}
