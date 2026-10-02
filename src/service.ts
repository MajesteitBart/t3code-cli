import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { withT3Api, type T3Api } from "./api.js";
import { CliError } from "./errors.js";
import { readLocalProjects } from "./localProjects.js";
import { applyModelOverrides } from "./modelSelection.js";
import { openThread } from "./open.js";
import { discoverRuntime } from "./runtime.js";
import { T3ThreadApi, type ThreadSettlementState } from "./threadApi.js";
import {
  changeSettingsWithApi,
  busyState,
  hasSettingsChange,
  settingsSummary,
  type ThreadSettingsChange,
} from "./threadControls.js";
import {
  configForWait,
  projectById,
  requireThreadId,
  threadStatus,
  waitView,
  type ThreadLifecycleStatus,
  type ThreadWaitOptions,
} from "./threadSupport.js";
import { buildTranscript, pendingRequests, queuedMessages, type TranscriptOptions } from "./transcript.js";
import type {
  CliConfig,
  EffectiveThreadEnvMode,
  InteractionMode,
  ModelSelection,
  OpenMode,
  ProjectPolicy,
  RuntimeMode,
  SpeedMode,
  T3Project,
  T3Thread,
  ThreadEnvMode,
  WorkspaceMode,
  WorkspaceResolution,
} from "./types.js";
import { pathsEqual, resolveWorkspace } from "./workspace.js";

const LEGACY_DEFAULT_MODEL_SELECTION: ModelSelection = { instanceId: "codex", model: "gpt-5.4" };
const CURRENT_DEFAULT_MODEL_SELECTION: ModelSelection = { instanceId: "codex", model: "gpt-5.6-sol" };
const MINIMUM_WORKTREE_BOOTSTRAP_VERSION = "0.0.28";
const MODERN_DEFAULTS_VERSION = "0.0.29";
const INSPECT_RECENT_MESSAGE_LIMIT = 6;
const INSPECT_MESSAGE_TEXT_LIMIT = 2_000;

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

export type ThreadListStatus = ThreadLifecycleStatus | "all";
export type { ThreadWaitOptions, ThreadWaitView } from "./threadSupport.js";

export interface ThreadListOptions extends WorkspaceOptions {
  project?: string;
  status?: ThreadListStatus;
}

export interface ThreadSendOptions {
  threadId: string;
  prompt: string;
  wakeSettled?: boolean;
  confirmSettled?: (thread: T3Thread, project: T3Project | null) => Promise<boolean>;
  /** Wait for the turn that handles the message and return its reply. */
  wait?: ThreadWaitOptions;
  /** Change the thread's model, effort, speed, or modes before the message starts its turn. */
  settings?: ThreadSettingsChange;
  /**
   * What to do when the thread is busy: `reject` (the default) refuses to send; `inject` sends into the
   * running turn, where the provider folds the message in or queues it.
   */
  ifBusy?: "reject" | "inject";
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

function nonArchivedThread(thread: T3Thread): boolean {
  return thread.archivedAt == null && thread.deletedAt == null;
}

function threadSummary(thread: T3Thread) {
  const summary = { ...thread };
  delete summary.messages;
  delete summary.activities;
  delete summary.checkpoints;
  delete summary.proposedPlans;
  return { ...summary, status: threadStatus(thread) };
}

/** The latest context-window report, so callers can see how full the target's context is. */
function contextWindow(thread: T3Thread): { usedTokens: number; maxTokens: number | null } | null {
  const activities = Array.isArray(thread.activities) ? (thread.activities as Array<Record<string, unknown>>) : [];
  const latest = activities.findLast((activity) => activity?.kind === "context-window.updated");
  const payload = latest?.payload as Record<string, unknown> | undefined;
  if (typeof payload?.usedTokens !== "number") return null;
  return { usedTokens: payload.usedTokens, maxTokens: typeof payload.maxTokens === "number" ? payload.maxTokens : null };
}

function threadInspectionView(thread: T3Thread) {
  const messages = thread.messages ?? [];
  const transcript = buildTranscript(thread, { detail: "answers" });
  return {
    ...threadSummary(thread),
    messageCount: messages.length,
    turnCount: transcript.view.totalTurns,
    contextWindow: contextWindow(thread),
    pendingRequests: pendingRequests(thread),
    recentMessages: messages.slice(-INSPECT_RECENT_MESSAGE_LIMIT).map((message) => ({
      id: message.id,
      role: message.role,
      turnId: message.turnId,
      text:
        message.text.length <= INSPECT_MESSAGE_TEXT_LIMIT
          ? message.text
          : `${message.text.slice(0, INSPECT_MESSAGE_TEXT_LIMIT - 1)}…`,
      textTruncated: message.text.length > INSPECT_MESSAGE_TEXT_LIMIT,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
  };
}

function threadReadView(thread: T3Thread, options: TranscriptOptions) {
  const transcript = buildTranscript(thread, options);
  return {
    ...threadSummary(thread),
    messageCount: transcript.messages.length,
    ...transcript,
  };
}

function projectAt(projects: readonly T3Project[], root: string): T3Project | null {
  return activeProjects(projects).find((project) => pathsEqual(project.workspaceRoot, root)) ?? null;
}

/** An exact project wins; a linked worktree otherwise belongs to its main checkout's project. */
function projectForWorkspace(projects: readonly T3Project[], workspace: WorkspaceResolution): T3Project | null {
  return (
    projectAt(projects, workspace.workspaceRoot) ??
    (workspace.mainWorktreeRoot ? projectAt(projects, workspace.mainWorktreeRoot) : null)
  );
}

function projectRootFor(workspace: WorkspaceResolution): string {
  return workspace.mainWorktreeRoot ?? workspace.workspaceRoot;
}

/** Matches the temporary branch T3's UI uses; T3 renames it after the thread gets a title. */
function temporaryWorktreeBranch(): string {
  return `t3code/${randomBytes(4).toString("hex")}`;
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

function resolveModelSelection(
  base: ModelSelection,
  config: CliConfig,
  options: ThreadCreateOptions,
): ModelSelection {
  return applyModelOverrides(
    base,
    {
      provider: options.provider ?? config.provider,
      model: options.model ?? config.model,
      speedMode: options.speedMode ?? config.speedMode,
      thinkingEffort: options.thinkingEffort ?? config.thinkingEffort,
    },
    "project default",
  );
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
  workspace: WorkspaceResolution,
  policy: ProjectPolicy,
  dryRun: boolean,
  defaultModelSelection: ModelSelection,
): Promise<{ project: T3Project; created: boolean; command: unknown | null; dispatch: unknown | null }> {
  const projects = initialProjects ?? (await projectsFromApi(api));
  const existing = projectForWorkspace(projects, workspace);
  if (existing) return { project: existing, created: false, command: null, dispatch: null };
  const workspaceRoot = projectRootFor(workspace);
  if (policy === "existing") {
    throw new CliError("PROJECT_NOT_FOUND", `No T3 Code project exists for ${workspaceRoot}.`, {
      details: {
        workspaceRoot,
        ...(workspace.mainWorktreeRoot ? { linkedWorktree: workspace.workspaceRoot } : {}),
        projectPolicy: policy,
      },
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
    return { runtime, workspace, project: projectForWorkspace(localProjects, workspace) };
  }
  return await withT3Api(runtime, config, async (api) => {
    const projects = await projectsFromApi(api);
    return { runtime, workspace, project: projectForWorkspace(projects, workspace) };
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
      workspace,
      options.projectPolicy ?? config.projectPolicy,
      options.dryRun ?? false,
      defaultModelSelectionForVersion(runtime.serverVersion),
    )),
  }));
}

export async function listThreads(config: CliConfig, options: ThreadListOptions = {}) {
  const requestedProjectId = options.project?.trim();
  if (options.project !== undefined && !requestedProjectId) {
    throw new CliError("PROJECT_ID_REQUIRED", "--project requires a non-empty project id.", {
      exitCode: 2,
    });
  }
  // An empty --cwd, such as an unset variable, still filters: like other commands, it means the current folder.
  const filtersByWorkspace = options.cwd !== undefined;
  if (requestedProjectId && filtersByWorkspace) {
    throw new CliError("THREAD_FILTER_CONFLICT", "Use either --project or --cwd, not both.", {
      exitCode: 2,
    });
  }
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const catalog = await new T3ThreadApi(api).catalog();
    const projects = activeProjects(catalog.projects);
    let project: T3Project | null = null;
    let workspace = null;

    if (requestedProjectId) {
      project = projects.find((candidate) => candidate.id === requestedProjectId) ?? null;
    } else if (filtersByWorkspace) {
      workspace = await resolveWorkspace(options.cwd || process.cwd(), options.workspaceMode ?? config.workspaceMode);
      project = projectForWorkspace(projects, workspace);
    }

    if ((requestedProjectId || filtersByWorkspace) && !project) {
      throw new CliError(
        "PROJECT_NOT_FOUND",
        requestedProjectId
          ? `No active T3 Code project exists with id ${requestedProjectId}.`
          : `No T3 Code project exists for ${workspace!.workspaceRoot}.`,
        { exitCode: 3 },
      );
    }

    const requestedStatus = options.status ?? "all";
    const threads = catalog.threads
      .filter(nonArchivedThread)
      .filter((thread) => project === null || thread.projectId === project.id)
      .filter((thread) => requestedStatus === "all" || threadStatus(thread) === requestedStatus)
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
      // The snapshot fallback carries whole transcripts; the list returns thread summaries only.
      .map(threadSummary);

    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      snapshotSequence: catalog.snapshotSequence,
      filter: {
        status: requestedStatus,
        projectId: project?.id ?? null,
        workspaceRoot: workspace?.workspaceRoot ?? null,
      },
      projects,
      threads,
    };
  });
}

export async function inspectThread(config: CliConfig, rawThreadId: string) {
  const threadId = requireThreadId(rawThreadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, config, async (api, invocation) => {
    // A turn window would understate the turn and message counts of a long thread.
    const inspected = await new T3ThreadApi(api).read(threadId);
    const project = await projectById(api, inspected.thread.projectId);
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      snapshotSequence: inspected.snapshotSequence,
      project,
      thread: threadInspectionView(inspected.thread),
    };
  });
}

export async function readThread(config: CliConfig, rawThreadId: string, options: TranscriptOptions = {}) {
  const threadId = requireThreadId(rawThreadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, config, async (api, invocation) => {
    // Turn windows are applied locally: numbering, the first turn, and prompt grouping need the whole thread.
    const read = await new T3ThreadApi(api).read(threadId);
    const project = await projectById(api, read.thread.projectId);
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      snapshotSequence: read.snapshotSequence,
      project,
      thread: threadReadView(read.thread, options),
    };
  });
}

export async function sendThreadMessage(config: CliConfig, options: ThreadSendOptions) {
  const threadId = requireThreadId(options.threadId);
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw new CliError("PROMPT_REQUIRED", "A non-empty thread message is required.", { exitCode: 2 });
  }

  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  return await withT3Api(runtime, configForWait(config, options.wait), async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    const inspected = await adapter.inspect(threadId);
    const thread = inspected.thread;
    if (thread.archivedAt != null) {
      throw new CliError("THREAD_ARCHIVED", `Thread ${threadId} is archived and cannot receive a new turn.`, {
        exitCode: 4,
        details: { threadId, archivedAt: thread.archivedAt },
      });
    }

    const project = await projectById(api, thread.projectId);
    if (threadStatus(thread) === "settled" && !options.wakeSettled) {
      if (!options.confirmSettled) {
        throw new CliError(
          "SETTLED_THREAD_CONFIRMATION_REQUIRED",
          `Thread ${threadId} is settled. Re-run with --wake-settled to send and wake it.`,
          { exitCode: 4, details: { threadId, settledAt: thread.settledAt } },
        );
      }
      if (!(await options.confirmSettled(thread, project))) {
        throw new CliError("SETTLED_THREAD_DECLINED", `Did not send a message to settled thread ${threadId}.`, {
          exitCode: 4,
          details: { threadId },
        });
      }
    }

    const busy = busyState(thread);
    if (busy && (options.ifBusy ?? "reject") === "reject") {
      throw new CliError(
        "THREAD_BUSY",
        `Thread ${threadId} ${busy.turnRunning ? "is running a turn" : "has a message waiting for its turn"}. Wait for it with threads wait, or pass --if-busy inject to send into the running turn.`,
        {
          exitCode: 4,
          details: {
            threadId,
            ...busy,
            sessionStatus: thread.session?.status ?? null,
            latestTurnState: thread.latestTurn?.state ?? null,
          },
        },
      );
    }

    const settings = hasSettingsChange(options.settings)
      ? await changeSettingsWithApi(api, adapter, thread, options.settings)
      : null;
    // The settings change leaves the new selection on the thread, and the turn carries it to the session.
    const command = adapter.buildTurnStart(settings?.thread ?? thread, prompt);
    const sent = await adapter.dispatchTurn(command);
    const messageId = command.message.messageId;
    const waited = options.wait
      ? await adapter.waitForTurn(threadId, { messageId, timeoutMs: options.wait.timeoutMs }).catch((cause: unknown) => {
          if (!(cause instanceof CliError) || cause.code !== "THREAD_WAIT_TIMEOUT") throw cause;
          throw new CliError(
            "THREAD_WAIT_TIMEOUT",
            `Sent message ${messageId}, but thread ${threadId} did not finish within ${Math.round(options.wait!.timeoutMs / 1000)} seconds. Do not resend it; run threads wait to keep waiting.`,
            { exitCode: cause.exitCode, details: { ...(cause.details as object), sent: true } },
          );
        })
      : null;
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      project,
      thread: {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        statusBeforeSend: threadStatus(thread),
      },
      message: {
        messageId,
        textLength: command.message.text.length,
      },
      ...(settings ? { settings: { ...settingsSummary(settings.plan), sessionRestarted: settings.sessionRestarted, commands: settings.plan.commands, dispatches: settings.dispatches } } : {}),
      command: {
        type: command.type,
        commandId: command.commandId,
        threadId: command.threadId,
        ...(command.modelSelection ? { modelSelection: command.modelSelection } : {}),
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        createdAt: command.createdAt,
      },
      dispatch: sent.dispatch,
      verification: sent.verification,
      ...(waited && options.wait ? waitView(waited, options.wait, [messageId]) : {}),
    };
  });
}

export async function waitForThread(config: CliConfig, rawThreadId: string, options: ThreadWaitOptions) {
  const threadId = requireThreadId(rawThreadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, configForWait(config, options), async (api, invocation) => {
    const waited = await new T3ThreadApi(api).waitForTurn(threadId, { timeoutMs: options.timeoutMs });
    const project = await projectById(api, waited.thread.projectId);
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      project,
      thread: { id: waited.thread.id, projectId: waited.thread.projectId, title: waited.thread.title },
      ...waitView(waited, options),
    };
  });
}

async function changeThreadSettlement(
  config: CliConfig,
  rawThreadId: string,
  state: ThreadSettlementState,
) {
  const threadId = requireThreadId(rawThreadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  if (runtime.capabilities.threadSettlement !== true) {
    throw new CliError(
      "THREAD_SETTLEMENT_UNSUPPORTED",
      "This T3 Code server does not advertise thread settlement support.",
      {
        exitCode: 4,
        details: { capability: "threadSettlement", serverVersion: runtime.serverVersion },
      },
    );
  }
  return await withT3Api(runtime, config, async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    const inspected = await adapter.inspect(threadId);
    const thread = inspected.thread;
    if (thread.archivedAt != null) {
      throw new CliError("THREAD_ARCHIVED", `Thread ${threadId} is archived and cannot change settlement state.`, {
        exitCode: 4,
        details: { threadId, archivedAt: thread.archivedAt },
      });
    }
    // The thread detail omits T3's pending flags, so derive them from the request activities too.
    const requests = pendingRequests(thread);
    const hasPendingApprovals = thread.hasPendingApprovals === true || requests.some((request) => request.kind === "approval");
    const hasPendingUserInput =
      thread.hasPendingUserInput === true || requests.some((request) => request.kind === "user-input");
    // A message queued between turns is submitted work, even while the session looks ready.
    const queued = queuedMessages(thread);
    if (
      state === "settled" &&
      (thread.session?.status === "starting" ||
        thread.session?.status === "running" ||
        thread.latestTurn?.state === "running" ||
        hasPendingApprovals ||
        hasPendingUserInput ||
        queued.length > 0)
    ) {
      throw new CliError("THREAD_SETTLE_BLOCKED", `Thread ${threadId} still has active or blocked work.`, {
        exitCode: 4,
        details: {
          threadId,
          sessionStatus: thread.session?.status ?? null,
          latestTurnState: thread.latestTurn?.state ?? null,
          hasPendingApprovals,
          hasPendingUserInput,
          queuedMessages: queued.length,
        },
      });
    }

    const project = await projectById(api, thread.projectId);
    const command = adapter.buildSettlement(threadId, state);
    const changed = await adapter.dispatchSettlement(command, thread.updatedAt);
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      project,
      thread: {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        statusBefore: threadStatus(thread),
        statusAfter: threadStatus(changed.thread),
      },
      command,
      dispatch: changed.dispatch,
      verification: changed.verification,
    };
  });
}

export async function settleThread(config: CliConfig, threadId: string) {
  return await changeThreadSettlement(config, threadId, "settled");
}

export async function unsettleThread(config: CliConfig, threadId: string) {
  return await changeThreadSettlement(config, threadId, "active");
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
      workspace,
      options.projectPolicy ?? config.projectPolicy,
      true,
      installedDefaultModelSelection,
    );
    // A handover from a linked worktree of the project's checkout keeps working in that worktree.
    const currentWorktreePath = pathsEqual(projectResult.project.workspaceRoot, workspace.workspaceRoot)
      ? null
      : workspace.workspaceRoot;
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
      worktreePath: currentWorktreePath,
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
            projectCwd: projectResult.project.workspaceRoot,
            baseBranch: workspace.branch!,
            // Without a new branch, `git worktree add` fails when the base branch is checked out elsewhere.
            branch: temporaryWorktreeBranch(),
            startFromOrigin: settings.newWorktreesStartFromOrigin,
            requireWorktree: true,
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
          dispatch = await api.dispatchOverWebSocket(command);
        } catch (cause) {
          const disposition =
            cause instanceof CliError
              ? (cause.details as { bootstrapThreadDisposition?: unknown } | undefined)?.bootstrapThreadDisposition
              : undefined;
          throw new CliError("THREAD_START_FAILED", "T3 could not prepare the worktree and start its handover prompt.", {
            cause,
            details: {
              threadId,
              cleanup: disposition === "deleted" || disposition === "not-created" ? disposition : "server-managed",
            },
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

export function normalizeRequestPath(requestPath: string): string {
  if (/^[A-Za-z]:[\\/]/u.test(requestPath)) {
    throw new CliError(
      "INVALID_REQUEST_PATH",
      "Request path is a Windows file path. Git Bash converts arguments that start with a slash: pass the path without its leading slash (api/...) or set MSYS_NO_PATHCONV=1.",
      { details: { requestPath } },
    );
  }
  const normalized = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  // URL parsing treats a backslash like a slash, so both spellings would leave the T3 origin.
  if (/^[\\/]{2}/u.test(normalized)) {
    throw new CliError("INVALID_REQUEST_PATH", "Request path must be a T3 API path such as /api/orchestration/shell.");
  }
  return normalized;
}

export async function rawGet(config: CliConfig, requestPath: string) {
  const normalizedPath = normalizeRequestPath(requestPath);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, config, async (api) => ({
    runtime,
    response: await api.request("GET", normalizedPath),
  }));
}
