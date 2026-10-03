import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { withT3Api, type T3Api } from "./api.js";
import { fetchCatalog, resolveModelChange } from "./catalog.js";
import { CliError } from "./errors.js";
import { readLocalProjects } from "./localProjects.js";
import { applyModelOverrides } from "./modelSelection.js";
import { openThread } from "./open.js";
import { discoverRuntime } from "./runtime.js";
import { createdBy, T3ThreadApi, type ThreadRead } from "./threadApi.js";
import { changeSettingsWithApi, hasSettingsChange, settingsSummary, type ThreadSettingsChange } from "./threadControls.js";
import {
  configForWait,
  projectById,
  requireThreadId,
  threadStatus,
  waitView,
  type ThreadLifecycleStatus,
  type ThreadWaitOptions,
} from "./threadSupport.js";
import {
  activeRun,
  buildTranscript,
  busyState,
  clip,
  pendingRequests,
  queuedRuns,
  runMessage,
  type TranscriptOptions,
} from "./transcript.js";
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
  T3Run,
  T3ThreadProjection,
  T3ThreadShell,
  ThreadEnvMode,
  WorkspaceMode,
  WorkspaceResolution,
} from "./types.js";
import { pathsEqual, resolveWorkspace } from "./workspace.js";

/** Used only when neither the project, the CLI config, nor T3's catalog names a model. */
const FALLBACK_MODEL_SELECTION: ModelSelection = { instanceId: "codex", model: "gpt-5.6-sol" };
const INSPECT_RECENT_MESSAGE_LIMIT = 6;
const INSPECT_MESSAGE_TEXT_LIMIT = 2_000;
const QUEUE_PREVIEW_LIMIT = 200;

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
  /** Wait for the first turn to finish and return its reply. */
  wait?: ThreadWaitOptions;
}

export type ThreadListStatus = ThreadLifecycleStatus | "all";
export type { ThreadWaitOptions, ThreadWaitView } from "./threadSupport.js";

export interface ThreadListOptions extends WorkspaceOptions {
  project?: string;
  status?: ThreadListStatus;
}

/**
 * What to do when the thread is busy. `refuse` (the default; `reject` is the old name) sends nothing.
 * `queue` waits for the running turn, `steer` joins it (`inject` is the old name), and `restart`
 * stops it and starts over with this message.
 */
export type IfBusy = "refuse" | "reject" | "queue" | "steer" | "inject" | "restart";

export interface ThreadSendOptions {
  threadId: string;
  prompt: string;
  wakeSettled?: boolean;
  confirmSettled?: (thread: { id: string; title: string; settledAt?: string | null }, project: T3Project | null) => Promise<boolean>;
  /** Wait for the turn that handles the message and return its reply. */
  wait?: ThreadWaitOptions;
  /** Change the thread's model, effort, speed, or modes before the message starts its turn. */
  settings?: ThreadSettingsChange;
  ifBusy?: IfBusy;
}

interface EffectiveT3Settings {
  defaultThreadEnvMode: EffectiveThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}

interface T3ProjectFileSettings {
  defaultThreadEnvMode: EffectiveThreadEnvMode | null;
}

function asEffectiveThreadEnvMode(value: unknown): EffectiveThreadEnvMode | null {
  return value === "local" || value === "worktree" ? value : null;
}

async function readT3Settings(settingsPath: string | null): Promise<EffectiveT3Settings> {
  // Orchestrator V2 builds start new worktrees from origin unless the setting turns it off.
  const defaults: EffectiveT3Settings = { defaultThreadEnvMode: "local", newWorktreesStartFromOrigin: true };
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

function runSummary(run: T3Run | null) {
  return run
    ? {
        runId: run.id,
        ordinal: run.ordinal,
        status: run.status,
        requestedAt: run.requestedAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      }
    : null;
}

/** A shell thread for list output. `status` stays the lifecycle status; the run status is `runStatus`. */
function shellSummary(thread: T3ThreadShell) {
  return { ...thread, status: threadStatus(thread), runStatus: thread.status ?? "idle" };
}

function latestRun(projection: T3ThreadProjection): T3Run | null {
  return projection.runs.reduce<T3Run | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
}

function queueView(projection: T3ThreadProjection) {
  return queuedRuns(projection).map((run) => {
    const text = runMessage(projection, run)?.text ?? "";
    const preview = clip(text, QUEUE_PREVIEW_LIMIT);
    return {
      runId: run.id,
      position: run.queuePosition ?? null,
      held: run.queueHeld === true,
      text: preview.text,
      textTruncated: preview.truncated,
      requestedAt: run.requestedAt,
    };
  });
}

/** Thread settings and state without its timeline, which `threads read` returns. */
function threadSummary(projection: T3ThreadProjection) {
  const active = activeRun(projection);
  const latest = latestRun(projection);
  return {
    ...projection.thread,
    status: threadStatus(projection.thread),
    runStatus: active?.status ?? latest?.status ?? "idle",
    activeRun: runSummary(active),
    latestRun: runSummary(latest),
    queue: queueView(projection),
  };
}

function threadInspectionView(projection: T3ThreadProjection) {
  const transcript = buildTranscript(projection, { detail: "answers" });
  const messages = [...projection.messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return {
    ...threadSummary(projection),
    messageCount: messages.length,
    turnCount: transcript.view.totalTurns,
    pendingRequests: pendingRequests(projection),
    recentMessages: messages.slice(-INSPECT_RECENT_MESSAGE_LIMIT).map((message) => ({
      id: message.id,
      role: message.role,
      turnId: message.runId,
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

function threadReadView(projection: T3ThreadProjection, options: TranscriptOptions) {
  const transcript = buildTranscript(projection, options);
  return {
    ...threadSummary(projection),
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

/** T3's own default model, from its catalog: the Codex default, else the first enabled provider's. */
async function catalogDefaultModel(api: T3Api): Promise<ModelSelection> {
  const catalog = await fetchCatalog(api).catch(() => null);
  const providers = (catalog?.providers ?? []).filter((provider) => provider.enabled && provider.models.length > 0);
  const provider = providers.find((candidate) => candidate.instanceId === "codex") ?? providers[0];
  const model = provider?.models.find((candidate) => candidate.isDefault) ?? provider?.models[0];
  return provider && model ? { instanceId: provider.instanceId, model: model.slug } : FALLBACK_MODEL_SELECTION;
}

async function resolveModelSelection(
  api: T3Api,
  base: ModelSelection,
  config: CliConfig,
  options: ThreadCreateOptions,
): Promise<ModelSelection> {
  const overrides = {
    provider: options.provider ?? config.provider,
    model: options.model ?? config.model,
    speedMode: options.speedMode ?? config.speedMode,
    thinkingEffort: options.thinkingEffort ?? config.thinkingEffort,
  };
  if (Object.values(overrides).every((value) => value === undefined)) return base;
  // The catalog names the option each model uses for effort and speed; without it, every known id is set.
  const catalog = await fetchCatalog(api).catch(() => null);
  return catalog ? resolveModelChange(base, overrides, catalog) : applyModelOverrides(base, overrides, "project default");
}

async function projectsFromApi(api: T3Api): Promise<T3Project[]> {
  return activeProjects(await api.projects());
}

async function ensureProjectWithApi(
  api: T3Api,
  initialProjects: readonly T3Project[] | null,
  workspace: WorkspaceResolution,
  policy: ProjectPolicy,
  dryRun: boolean,
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

  const projectId = randomUUID();
  const command = {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: projectTitle(workspaceRoot),
    workspaceRoot,
    createWorkspaceRootIfMissing: false,
  };
  const planned: T3Project = {
    id: projectId,
    title: command.title,
    workspaceRoot,
    defaultModelSelection: null,
    deletedAt: null,
  };
  if (dryRun) return { project: planned, created: true, command, dispatch: null };
  const dispatch = await api.mutateProject(command);
  const returned = dispatch as Partial<T3Project> | null;
  const project = returned && typeof returned.id === "string" ? ({ ...planned, ...returned } as T3Project) : planned;
  return { project, created: true, command, dispatch };
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
    const shell = await api.shellSnapshot();
    const projects = activeProjects(shell.projects);
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
    const threads = shell.threads
      .filter((thread) => thread.archivedAt == null && thread.deletedAt == null)
      .filter((thread) => project === null || thread.projectId === project.id)
      .filter((thread) => requestedStatus === "all" || threadStatus(thread) === requestedStatus)
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
      .map(shellSummary);

    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      snapshotSequence: shell.snapshotSequence,
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
    // A bounded window would understate the message count of a long thread.
    const inspected = await new T3ThreadApi(api).read(threadId);
    const project = await projectById(api, inspected.projection.thread.projectId);
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      snapshotSequence: inspected.snapshotSequence,
      project,
      thread: threadInspectionView(inspected.projection),
    };
  });
}

export async function readThread(config: CliConfig, rawThreadId: string, options: TranscriptOptions = {}) {
  const threadId = requireThreadId(rawThreadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, config, async (api, invocation) => {
    // Turn windows are applied locally: numbering and the first turn need the whole thread.
    const read = await new T3ThreadApi(api).read(threadId);
    const project = await projectById(api, read.projection.thread.projectId);
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      snapshotSequence: read.snapshotSequence,
      project,
      thread: threadReadView(read.projection, options),
    };
  });
}

function requireWritable(read: ThreadRead, action: string): void {
  const thread = read.projection.thread;
  if (thread.deletedAt != null) {
    throw new CliError("THREAD_NOT_FOUND", `No T3 Code thread exists with id ${thread.id}.`, {
      exitCode: 3,
      details: { threadId: thread.id },
    });
  }
  if (thread.archivedAt != null) {
    throw new CliError("THREAD_ARCHIVED", `Thread ${thread.id} is archived and cannot ${action}.`, {
      exitCode: 4,
      details: { threadId: thread.id, archivedAt: thread.archivedAt },
    });
  }
}

type DispatchMode =
  | { type: "start_immediately" }
  | { type: "queue_after_active" }
  | { type: "steer_active"; targetRunId: string }
  | { type: "restart_active"; targetRunId: string };

function dispatchModeFor(projection: T3ThreadProjection, ifBusy: IfBusy): DispatchMode {
  const busy = busyState(projection);
  if (!busy) return { type: "start_immediately" };
  const choice = ifBusy === "reject" ? "refuse" : ifBusy === "inject" ? "steer" : ifBusy;
  if (choice === "refuse") {
    throw new CliError(
      "THREAD_BUSY",
      `Thread ${projection.thread.id} ${busy.runRunning ? "is running a turn" : "has queued messages waiting for their turn"}. Wait for it with threads wait, or pass --if-busy queue, steer, or restart.`,
      { exitCode: 4, details: { threadId: projection.thread.id, ...busy } },
    );
  }
  if (choice === "queue") return { type: "queue_after_active" };
  // Steering and restarting act on the run that works now; with only a queue, the message queues too.
  if (!busy.activeRunId) return { type: "queue_after_active" };
  return choice === "steer"
    ? { type: "steer_active", targetRunId: busy.activeRunId }
    : { type: "restart_active", targetRunId: busy.activeRunId };
}

async function confirmWake(
  read: ThreadRead,
  project: T3Project | null,
  options: Pick<ThreadSendOptions, "wakeSettled" | "confirmSettled">,
): Promise<void> {
  const thread = read.projection.thread;
  if (threadStatus(thread) !== "settled" || options.wakeSettled) return;
  // T3 wakes a settled thread on any new message; the CLI asks first.
  if (!options.confirmSettled) {
    throw new CliError(
      "SETTLED_THREAD_CONFIRMATION_REQUIRED",
      `Thread ${thread.id} is settled. Re-run with --wake-settled to send and wake it.`,
      { exitCode: 4, details: { threadId: thread.id, settledAt: thread.settledAt } },
    );
  }
  if (!(await options.confirmSettled(thread, project))) {
    throw new CliError("SETTLED_THREAD_DECLINED", `Did not send a message to settled thread ${thread.id}.`, {
      exitCode: 4,
      details: { threadId: thread.id },
    });
  }
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
    let read = await adapter.inspect(threadId);
    requireWritable(read, "receive a new message");
    const thread = read.projection.thread;
    const project = await projectById(api, thread.projectId);
    await confirmWake(read, project, options);

    // A refused send must change nothing, so check it before any settings change.
    dispatchModeFor(read.projection, options.ifBusy ?? "refuse");
    const settings = hasSettingsChange(options.settings)
      ? await changeSettingsWithApi(api, adapter, read.projection, options.settings)
      : null;
    if (settings) read = { ...read, projection: settings.projection };
    const dispatchMode = dispatchModeFor(read.projection, options.ifBusy ?? "refuse");
    const messageId = randomUUID();
    const command = {
      type: "message.dispatch",
      commandId: randomUUID(),
      threadId,
      messageId,
      text: prompt,
      attachments: [],
      ...createdBy(),
      dispatchMode,
    };
    const dispatch = await adapter.dispatch(command);
    const verification = await adapter.verifyMessage(threadId, messageId, dispatch.sequence);
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
      message: { messageId, textLength: prompt.length, delivery: dispatchMode.type },
      ...(settings
        ? {
            settings: {
              ...settingsSummary(settings.plan),
              commands: settings.plan.commands,
              dispatches: settings.dispatches,
            },
          }
        : {}),
      command: { type: command.type, commandId: command.commandId, threadId, dispatchMode },
      dispatch,
      verification,
      ...(waited && options.wait ? waitView(waited, options.wait, [messageId]) : {}),
    };
  });
}

export async function waitForThread(config: CliConfig, rawThreadId: string, options: ThreadWaitOptions) {
  const threadId = requireThreadId(rawThreadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, configForWait(config, options), async (api, invocation) => {
    const waited = await new T3ThreadApi(api).waitForTurn(threadId, { timeoutMs: options.timeoutMs });
    const thread = waited.projection.thread;
    const project = await projectById(api, thread.projectId);
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      project,
      thread: { id: thread.id, projectId: thread.projectId, title: thread.title },
      ...waitView(waited, options),
    };
  });
}

type ThreadSettlementState = "active" | "settled";

async function changeThreadSettlement(config: CliConfig, rawThreadId: string, state: ThreadSettlementState) {
  const threadId = requireThreadId(rawThreadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  if (runtime.capabilities.threadSettlement !== true) {
    throw new CliError("THREAD_SETTLEMENT_UNSUPPORTED", "This T3 Code server does not advertise thread settlement support.", {
      exitCode: 4,
      details: { capability: "threadSettlement", serverVersion: runtime.serverVersion },
    });
  }
  return await withT3Api(runtime, config, async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    const read = await adapter.inspect(threadId);
    requireWritable(read, "change its settlement");
    const projection = read.projection;
    const thread = projection.thread;
    const busy = busyState(projection);
    const requests = pendingRequests(projection);
    if (state === "settled" && (busy || requests.length > 0)) {
      throw new CliError("THREAD_SETTLE_BLOCKED", `Thread ${threadId} still has active or blocked work.`, {
        exitCode: 4,
        details: {
          threadId,
          activeRunId: busy?.activeRunId ?? null,
          queuedRuns: busy?.queuedRuns ?? 0,
          pendingRequests: requests.map((request) => request.requestId),
        },
      });
    }

    const project = await projectById(api, thread.projectId);
    const command =
      state === "settled"
        ? { type: "thread.settle", commandId: randomUUID(), threadId }
        : { type: "thread.unsettle", commandId: randomUUID(), threadId, reason: "user" as const };
    const dispatch = await adapter.dispatch(command);
    const previousUpdatedAt = thread.updatedAt;
    const changed = await adapter.poll(threadId, (candidate) => {
      const next = candidate.thread;
      if (state === "settled") return next.settledAt != null ? candidate : null;
      if (next.settledAt != null) return null;
      return next.settledOverride === "active" || (next.updatedAt ?? "") > (previousUpdatedAt ?? "") ? candidate : null;
    });
    if (!changed.value) {
      throw new CliError(
        "THREAD_SETTLEMENT_NOT_VERIFIED",
        `T3 did not show thread ${threadId} as ${state}.`,
        { exitCode: 5, details: { threadId, state, dispatchSequence: dispatch.sequence } },
      );
    }
    const after = changed.value.thread;
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      project,
      thread: {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        statusBefore: threadStatus(thread),
        statusAfter: threadStatus(after),
      },
      command,
      dispatch,
      verification: {
        accepted: true,
        state,
        dispatchSequence: dispatch.sequence,
        settledAt: after.settledAt ?? null,
        unsettledAt: after.unsettledAt ?? null,
      },
    };
  });
}

export async function settleThread(config: CliConfig, threadId: string) {
  return await changeThreadSettlement(config, threadId, "settled");
}

export async function unsettleThread(config: CliConfig, threadId: string) {
  return await changeThreadSettlement(config, threadId, "active");
}

type WorkspaceStrategy =
  | { type: "root" }
  | { type: "existing_worktree"; worktreePath: string }
  | { type: "worktree"; baseRef: string; branch: string; startFromOrigin: boolean };

export async function createHandoverThread(config: CliConfig, options: ThreadCreateOptions) {
  const prompt = options.prompt.trim();
  if (!prompt) throw new CliError("PROMPT_REQUIRED", "A non-empty handover prompt is required.");

  const workspace = await resolveWorkspace(options.cwd ?? process.cwd(), options.workspaceMode ?? config.workspaceMode);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  const localProjects = readLocalProjects(runtime);
  const settings = await readT3Settings(runtime.settingsPath);
  const projectFile = await readT3ProjectFile(workspace.workspaceRoot);

  const result = await withT3Api(runtime, configForWait(config, options.wait), async (api, invocation) => {
    const projectResult = await ensureProjectWithApi(
      api,
      localProjects,
      workspace,
      options.projectPolicy ?? config.projectPolicy,
      true,
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
    if (envMode === "worktree" && (!workspace.isGitRepository || workspace.branch === null)) {
      throw new CliError(
        "WORKTREE_REQUIRES_BRANCH",
        "A new worktree requires a Git repository with a current branch. Use --checkout current for this handover.",
        { details: { isGitRepository: workspace.isGitRepository, currentBranch: workspace.branch } },
      );
    }
    const base = projectResult.project.defaultModelSelection ?? (await catalogDefaultModel(api));
    const modelSelection = await resolveModelSelection(api, base, config, options);
    const title = threadTitle(prompt);
    const runtimeMode = options.runtimeMode ?? config.runtimeMode;
    const interactionMode = options.interactionMode ?? config.interactionMode;
    const workspaceStrategy: WorkspaceStrategy =
      envMode === "worktree"
        ? {
            type: "worktree",
            baseRef: workspace.branch!,
            // Without a new branch, `git worktree add` fails when the base branch is checked out elsewhere.
            branch: temporaryWorktreeBranch(),
            startFromOrigin: settings.newWorktreesStartFromOrigin,
          }
        : currentWorktreePath
          ? { type: "existing_worktree", worktreePath: currentWorktreePath }
          : { type: "root" };
    const threadId = randomUUID();
    const messageId = randomUUID();
    const launch = {
      commandId: randomUUID(),
      threadId,
      projectId: projectResult.project.id,
      title,
      generateTitle: true,
      modelSelection,
      runtimeMode,
      interactionMode,
      workspaceStrategy,
      initialMessage: { messageId, text: prompt, attachments: [] },
    };
    const projectDispatch =
      projectResult.created && !options.dryRun ? await api.mutateProject(projectResult.command as { type: string }) : null;
    let launched: { threadId: string; resumed: boolean } | null = null;
    if (!options.dryRun) {
      try {
        const value = await api.launchThread(launch);
        launched = { threadId: value.threadId, resumed: value.resumed };
      } catch (cause) {
        throw new CliError("THREAD_START_FAILED", `T3 could not launch the handover thread: ${cause instanceof Error ? cause.message : String(cause)}`, {
          cause,
          details: {
            threadId,
            // T3 records each launch step under the command id, so it either finishes or cleans up.
            cleanup: "server-managed",
            launchCommandId: launch.commandId,
          },
        });
      }
    }
    const createdThreadId = launched?.threadId ?? threadId;
    const waited =
      launched && options.wait
        ? await new T3ThreadApi(api)
            .waitForTurn(createdThreadId, { messageId, timeoutMs: options.wait.timeoutMs })
            .catch((cause: unknown) => {
              if (!(cause instanceof CliError) || cause.code !== "THREAD_WAIT_TIMEOUT") throw cause;
              throw new CliError(
                "THREAD_WAIT_TIMEOUT",
                `Started thread ${createdThreadId}, but its first turn did not finish within ${Math.round(options.wait!.timeoutMs / 1000)} seconds. Do not hand over again; run threads wait to keep waiting.`,
                { exitCode: cause.exitCode, details: { ...(cause.details as object), threadId: createdThreadId, sent: true } },
              );
            })
        : null;
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      workspace,
      settings: {
        ...settings,
        projectDefaultThreadEnvMode: asEffectiveThreadEnvMode(projectResult.project.defaultThreadEnvMode),
        projectFileDefaultThreadEnvMode: projectFile.defaultThreadEnvMode,
        effectiveThreadEnvMode: envMode,
        threadEnvModeSource: envModeResolution.source,
      },
      project: projectResult.project,
      projectCreated: projectResult.created,
      projectCommand: projectResult.command,
      projectDispatch,
      thread: {
        id: createdThreadId,
        title,
        messageId,
        launch,
        resumed: launched?.resumed ?? false,
      },
      ...(waited && options.wait ? waitView(waited, options.wait, [messageId]) : {}),
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
