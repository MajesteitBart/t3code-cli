import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { withT3Api, type T3Api } from "./api.js";
import { CliError } from "./errors.js";
import { readLocalProjects } from "./localProjects.js";
import { openThread } from "./open.js";
import { discoverRuntime } from "./runtime.js";
import type {
  CliConfig,
  EffectiveThreadEnvMode,
  InteractionMode,
  ModelSelection,
  OpenMode,
  ProviderOptionSelection,
  ProjectPolicy,
  RuntimeMode,
  SpeedMode,
  T3Project,
  ThreadEnvMode,
  WorkspaceMode,
} from "./types.js";
import { pathsEqual, resolveWorkspace } from "./workspace.js";

const LEGACY_DEFAULT_MODEL_SELECTION: ModelSelection = { instanceId: "codex", model: "gpt-5.4" };
const CURRENT_DEFAULT_MODEL_SELECTION: ModelSelection = { instanceId: "codex", model: "gpt-5.6-sol" };
const MINIMUM_WORKTREE_BOOTSTRAP_VERSION = "0.0.28";
const MODERN_DEFAULTS_VERSION = "0.0.29";

export interface WorkspaceOptions {
  cwd?: string;
  workspaceMode?: WorkspaceMode;
}

export interface ThreadCreateOptions extends WorkspaceOptions {
  prompt: string;
  projectPolicy?: ProjectPolicy;
  openMode?: OpenMode;
  threadEnvMode?: ThreadEnvMode;
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode;
  provider?: string;
  model?: string;
  speedMode?: SpeedMode;
  thinkingEffort?: string;
  dryRun?: boolean;
}

interface EffectiveT3Settings {
  defaultThreadEnvMode: EffectiveThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}

interface T3ProjectFileSettings {
  defaultThreadEnvMode: EffectiveThreadEnvMode | null;
}

function parseVersion(version: string): readonly [number, number, number] | null {
  const values = version.match(/^v?(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number);
  if (!values || values.length !== 3 || values.some((value) => !Number.isInteger(value))) return null;
  return [values[0]!, values[1]!, values[2]!];
}

function versionAtLeast(version: string, minimum: string): boolean {
  const actual = parseVersion(version);
  const required = parseVersion(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]! > required[index]!) return true;
    if (actual[index]! < required[index]!) return false;
  }
  return true;
}

function defaultModelSelectionForVersion(version: string): ModelSelection {
  return versionAtLeast(version, MODERN_DEFAULTS_VERSION)
    ? CURRENT_DEFAULT_MODEL_SELECTION
    : LEGACY_DEFAULT_MODEL_SELECTION;
}

function defaultStartFromOriginForVersion(version: string): boolean {
  return versionAtLeast(version, MODERN_DEFAULTS_VERSION);
}

function asEffectiveThreadEnvMode(value: unknown): EffectiveThreadEnvMode | null {
  return value === "local" || value === "worktree" ? value : null;
}

async function readT3Settings(
  settingsPath: string | null,
  serverVersion: string,
): Promise<EffectiveT3Settings> {
  const defaults: EffectiveT3Settings = {
    defaultThreadEnvMode: "local",
    newWorktreesStartFromOrigin: defaultStartFromOriginForVersion(serverVersion),
  };
  if (!settingsPath) return defaults;
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    return {
      defaultThreadEnvMode: asEffectiveThreadEnvMode(raw.defaultThreadEnvMode) ?? defaults.defaultThreadEnvMode,
      newWorktreesStartFromOrigin:
        typeof raw.newWorktreesStartFromOrigin === "boolean"
          ? raw.newWorktreesStartFromOrigin
          : defaults.newWorktreesStartFromOrigin,
    };
  } catch {
    return defaults;
  }
}

async function readT3ProjectFile(workspaceRoot: string): Promise<T3ProjectFileSettings> {
  try {
    const raw = JSON.parse(await readFile(path.join(workspaceRoot, "t3.json"), "utf8")) as Record<string, unknown>;
    return { defaultThreadEnvMode: asEffectiveThreadEnvMode(raw.defaultThreadEnvMode) };
  } catch {
    return { defaultThreadEnvMode: null };
  }
}

function activeProjects(projects: readonly T3Project[]): T3Project[] {
  return projects.filter((project) => project.deletedAt == null);
}

function projectForWorkspace(projects: readonly T3Project[], workspaceRoot: string): T3Project | null {
  return activeProjects(projects).find((project) => pathsEqual(project.workspaceRoot, workspaceRoot)) ?? null;
}

async function projectsFromApi(api: T3Api): Promise<T3Project[]> {
  const shell = await api.shellSnapshot().catch(() => null);
  if (shell && Array.isArray(shell.projects)) return activeProjects(shell.projects);
  const snapshot = await api.snapshot();
  if (!Array.isArray(snapshot.projects)) {
    throw new CliError("T3_INVALID_SNAPSHOT", "T3 returned a snapshot without projects.");
  }
  return activeProjects(snapshot.projects);
}

function projectTitle(workspaceRoot: string): string {
  return path.basename(workspaceRoot) || "project";
}

function threadTitle(prompt: string): string {
  const title = prompt.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, " ").trim() || "New thread";
  return title.length <= 80 ? title : `${title.slice(0, 79)}…`;
}

function effectiveEnvMode(
  requested: ThreadEnvMode,
  project: T3Project,
  projectFile: T3ProjectFileSettings,
  settings: EffectiveT3Settings,
): { mode: EffectiveThreadEnvMode; source: "request" | "project" | "t3.json" | "global" } {
  if (requested !== "t3") return { mode: requested, source: "request" };
  const projectMode = asEffectiveThreadEnvMode(project.defaultThreadEnvMode);
  if (projectMode) return { mode: projectMode, source: "project" };
  if (projectFile.defaultThreadEnvMode) {
    return { mode: projectFile.defaultThreadEnvMode, source: "t3.json" };
  }
  return { mode: settings.defaultThreadEnvMode, source: "global" };
}

function supportsWorktreeBootstrap(version: string): boolean {
  return versionAtLeast(version, MINIMUM_WORKTREE_BOOTSTRAP_VERSION);
}

function nonEmptyOption(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new CliError("INVALID_THREAD_OPTION", `${name} must be a non-empty string.`);
  return trimmed;
}

function normalizeProviderOptions(options: unknown): ProviderOptionSelection[] {
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

function setProviderOption(
  selections: ProviderOptionSelection[],
  id: string,
  value: string | boolean,
): void {
  const existing = selections.find((selection) => selection.id === id);
  if (existing) existing.value = value;
  else selections.push({ id, value });
}

function resolveModelSelection(
  base: ModelSelection,
  config: CliConfig,
  options: ThreadCreateOptions,
): ModelSelection {
  const provider = nonEmptyOption(options.provider ?? config.provider, "provider");
  const requestedModel = nonEmptyOption(options.model ?? config.model, "model");
  const thinkingEffort = nonEmptyOption(
    options.thinkingEffort ?? config.thinkingEffort,
    "thinking effort",
  );
  const instanceId = provider ?? base.instanceId;
  if (provider !== undefined && provider !== base.instanceId && requestedModel === undefined) {
    throw new CliError(
      "MODEL_REQUIRED_FOR_PROVIDER",
      `Provider instance ${provider} differs from the project default; select its model with --model.`,
      { details: { provider, projectProvider: base.instanceId } },
    );
  }
  const model = requestedModel ?? base.model;
  const selectionChanged = instanceId !== base.instanceId || model !== base.model;
  const selections = selectionChanged ? [] : normalizeProviderOptions(base.options);
  const speedMode = options.speedMode ?? config.speedMode;

  if (speedMode !== undefined) {
    setProviderOption(selections, "serviceTier", speedMode === "fast" ? "fast" : "default");
    setProviderOption(selections, "fastMode", speedMode === "fast");
  }
  if (thinkingEffort !== undefined) {
    // T3 provider drivers use different descriptor ids for the same user-facing control.
    setProviderOption(selections, "reasoningEffort", thinkingEffort);
    setProviderOption(selections, "effort", thinkingEffort);
    setProviderOption(selections, "reasoning", thinkingEffort);
  }

  return {
    instanceId,
    model,
    ...(selections.length > 0 ? { options: selections } : {}),
  };
}

function buildProjectCreateCommand(
  workspaceRoot: string,
  title: string,
  createdAt: string,
  defaultModelSelection: ModelSelection,
) {
  const projectId = randomUUID();
  return {
    projectId,
    command: {
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: false,
      defaultModelSelection,
      createdAt,
    },
  } as const;
}

async function ensureProjectWithApi(
  api: T3Api,
  initialProjects: readonly T3Project[] | null,
  workspaceRoot: string,
  policy: ProjectPolicy,
  dryRun: boolean,
  defaultModelSelection: ModelSelection,
): Promise<{ project: T3Project; created: boolean; command: unknown | null; dispatch: unknown | null }> {
  const projects = initialProjects ?? (await projectsFromApi(api));
  const existing = projectForWorkspace(projects, workspaceRoot);
  if (existing) return { project: existing, created: false, command: null, dispatch: null };
  if (policy === "existing") {
    throw new CliError("PROJECT_NOT_FOUND", `No T3 Code project exists for ${workspaceRoot}.`, {
      details: { workspaceRoot, projectPolicy: policy },
    });
  }

  const createdAt = new Date().toISOString();
  const create = buildProjectCreateCommand(
    workspaceRoot,
    projectTitle(workspaceRoot),
    createdAt,
    defaultModelSelection,
  );
  const project: T3Project = {
    id: create.projectId,
    title: projectTitle(workspaceRoot),
    workspaceRoot,
    defaultModelSelection,
    deletedAt: null,
  };
  const dispatch = dryRun ? null : await api.dispatch(create.command);
  return { project, created: true, command: create.command, dispatch };
}

export async function listProjects(config: CliConfig) {
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  const localProjects = readLocalProjects(runtime);
  if (localProjects) {
    return { runtime, auth: { source: "local-sqlite", version: runtime.serverVersion }, projects: localProjects };
  }
  return await withT3Api(runtime, config, async (api, invocation) => {
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      projects: await projectsFromApi(api),
    };
  });
}

export async function resolveProject(config: CliConfig, options: WorkspaceOptions) {
  const workspace = await resolveWorkspace(options.cwd ?? process.cwd(), options.workspaceMode ?? config.workspaceMode);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  const localProjects = readLocalProjects(runtime);
  if (localProjects) {
    return { runtime, workspace, project: projectForWorkspace(localProjects, workspace.workspaceRoot) };
  }
  return await withT3Api(runtime, config, async (api) => {
    const projects = await projectsFromApi(api);
    return { runtime, workspace, project: projectForWorkspace(projects, workspace.workspaceRoot) };
  });
}

export async function ensureProject(config: CliConfig, options: WorkspaceOptions & { projectPolicy?: ProjectPolicy; dryRun?: boolean }) {
  const workspace = await resolveWorkspace(options.cwd ?? process.cwd(), options.workspaceMode ?? config.workspaceMode);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  const localProjects = readLocalProjects(runtime);
  return await withT3Api(runtime, config, async (api) => ({
    runtime,
    workspace,
    ...(await ensureProjectWithApi(
      api,
      localProjects,
      workspace.workspaceRoot,
      options.projectPolicy ?? config.projectPolicy,
      options.dryRun ?? false,
      defaultModelSelectionForVersion(runtime.serverVersion),
    )),
  }));
}

export async function createHandoverThread(config: CliConfig, options: ThreadCreateOptions) {
  const prompt = options.prompt.trim();
  if (!prompt) throw new CliError("PROMPT_REQUIRED", "A non-empty handover prompt is required.");

  const workspace = await resolveWorkspace(options.cwd ?? process.cwd(), options.workspaceMode ?? config.workspaceMode);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  const localProjects = readLocalProjects(runtime);
  const settings = await readT3Settings(runtime.settingsPath, runtime.serverVersion);
  const projectFile = await readT3ProjectFile(workspace.workspaceRoot);
  const installedDefaultModelSelection = defaultModelSelectionForVersion(runtime.serverVersion);

  const result = await withT3Api(runtime, config, async (api, invocation) => {
    const projectResult = await ensureProjectWithApi(
      api,
      localProjects,
      workspace.workspaceRoot,
      options.projectPolicy ?? config.projectPolicy,
      true,
      installedDefaultModelSelection,
    );
    const envModeResolution = effectiveEnvMode(
      options.threadEnvMode ?? config.threadEnvMode,
      projectResult.project,
      projectFile,
      settings,
    );
    const envMode = envModeResolution.mode;
    if (envMode === "worktree" && !supportsWorktreeBootstrap(runtime.serverVersion)) {
      throw new CliError(
        "WORKTREE_HANDOVER_UNSUPPORTED",
        `New-worktree handovers require T3 ${MINIMUM_WORKTREE_BOOTSTRAP_VERSION} or later.`,
        {
          details: {
            serverVersion: runtime.serverVersion,
            minimumServerVersion: MINIMUM_WORKTREE_BOOTSTRAP_VERSION,
          },
        },
      );
    }
    if (envMode === "worktree" && (!workspace.isGitRepository || workspace.branch === null)) {
      throw new CliError(
        "WORKTREE_REQUIRES_BRANCH",
        "A new worktree requires a Git repository with a current branch. Use --checkout current for this handover.",
        { details: { isGitRepository: workspace.isGitRepository, currentBranch: workspace.branch } },
      );
    }
    const createdAt = new Date().toISOString();
    const threadId = randomUUID();
    const modelSelection = resolveModelSelection(
      projectResult.project.defaultModelSelection ?? installedDefaultModelSelection,
      config,
      options,
    );
    const title = threadTitle(prompt);
    const runtimeMode = options.runtimeMode ?? config.runtimeMode;
    const interactionMode = options.interactionMode ?? config.interactionMode;
    const projectDispatch = projectResult.created && !options.dryRun
      ? await api.dispatch(projectResult.command)
      : projectResult.dispatch;
    const createThread = {
      type: "thread.create",
      commandId: randomUUID(),
      threadId,
      projectId: projectResult.project.id,
      title,
      modelSelection,
      runtimeMode,
      interactionMode,
      branch: workspace.branch,
      worktreePath: null,
      createdAt,
    };
    const bootstrap = envMode === "worktree"
      ? {
          createThread: {
            projectId: projectResult.project.id,
            title,
            modelSelection,
            runtimeMode,
            interactionMode,
            branch: workspace.branch,
            worktreePath: null,
            createdAt,
          },
          prepareWorktree: {
            projectCwd: workspace.workspaceRoot,
            baseBranch: workspace.branch!,
            startFromOrigin: settings.newWorktreesStartFromOrigin,
          },
          runSetupScript: true,
        }
      : undefined;
    const command = {
      type: "thread.turn.start",
      commandId: randomUUID(),
      threadId,
      message: {
        messageId: randomUUID(),
        role: "user",
        text: prompt,
        attachments: [],
      },
      modelSelection,
      titleSeed: title,
      runtimeMode,
      interactionMode,
      ...(bootstrap ? { bootstrap } : {}),
      createdAt,
    };
    let createDispatch: unknown = null;
    let dispatch: unknown = null;
    if (!options.dryRun) {
      if (envMode === "worktree") {
        try {
          dispatch = await api.dispatch(command);
        } catch (cause) {
          throw new CliError("THREAD_START_FAILED", "T3 could not prepare the worktree and start its handover prompt.", {
            cause,
            details: { threadId, cleanup: "server-managed" },
          });
        }
      } else {
        createDispatch = await api.dispatch(createThread);
        try {
          dispatch = await api.dispatch(command);
        } catch (cause) {
          const cleanup = await api
            .dispatch({ type: "thread.delete", commandId: randomUUID(), threadId })
            .then(() => "deleted" as const)
            .catch(() => "failed" as const);
          throw new CliError("THREAD_START_FAILED", "T3 created the thread but could not start its handover prompt.", {
            cause,
            details: { threadId, cleanup },
          });
        }
      }
    }
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      workspace,
      settings: {
        ...settings,
        projectDefaultThreadEnvMode:
          asEffectiveThreadEnvMode(projectResult.project.defaultThreadEnvMode),
        projectFileDefaultThreadEnvMode: projectFile.defaultThreadEnvMode,
        effectiveThreadEnvMode: envMode,
        threadEnvModeSource: envModeResolution.source,
      },
      project: projectResult.project,
      projectCreated: projectResult.created,
      projectCommand: projectResult.command,
      projectDispatch,
      thread: { id: threadId, title, createCommand: createThread, createDispatch, command, dispatch },
    };
  });

  const opened = options.dryRun
    ? { mode: options.openMode ?? config.openMode, kind: "none" as const, url: null, exactThread: false }
    : await openThread(options.openMode ?? config.openMode, runtime, result.thread.id);
  return { ...result, opened, dryRun: options.dryRun ?? false };
}

export async function rawGet(config: CliConfig, requestPath: string) {
  if (!requestPath.startsWith("/") || requestPath.startsWith("//")) {
    throw new CliError("INVALID_REQUEST_PATH", "Request path must start with one slash.");
  }
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, config, async (api) => ({
    runtime,
    response: await api.request("GET", requestPath),
  }));
}
