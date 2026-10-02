import { randomUUID } from "node:crypto";

import { withT3Api, type T3Api } from "./api.js";
import {
  fetchCatalog,
  findProvider,
  resolveModelChange,
  sameModelSelection,
  type ModelChange,
  type ProviderCatalog,
} from "./catalog.js";
import { CliError } from "./errors.js";
import { applyModelOverrides, THREAD_EFFORT_OPTION_IDS } from "./modelSelection.js";
import { discoverRuntime } from "./runtime.js";
import { T3ThreadApi } from "./threadApi.js";
import {
  configForWait,
  projectById,
  requireThreadId,
  threadStatus,
  waitView,
  type ThreadWaitOptions,
  type ThreadWaitView,
} from "./threadSupport.js";
import { pendingRequests, type PendingQuestion, type PendingRequest } from "./transcript.js";
import type { CliConfig, InteractionMode, ModelSelection, RuntimeMode, T3Thread } from "./types.js";

/** Settings a caller asks to change on an existing thread; anything left out stays as it is. */
export interface ThreadSettingsChange extends ModelChange {
  runtimeMode?: RuntimeMode | undefined;
  interactionMode?: InteractionMode | undefined;
}

export interface ThreadSettingsPlan {
  /** The new model selection, or null when it does not change. */
  modelSelection: ModelSelection | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: InteractionMode | null;
  commands: Array<{ type: string; threadId: string; [key: string]: unknown }>;
  /** False when T3 did not return its catalog, so options were set without validation. */
  catalogUsed: boolean;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

const RESPONSE_TIMEOUT_MS = 15_000;

function hasModelChange(change: ThreadSettingsChange): boolean {
  return (
    change.provider !== undefined ||
    change.model !== undefined ||
    change.thinkingEffort !== undefined ||
    change.speedMode !== undefined ||
    (change.options?.length ?? 0) > 0
  );
}

export function hasSettingsChange(change: ThreadSettingsChange | undefined): change is ThreadSettingsChange {
  return change !== undefined && (hasModelChange(change) || change.runtimeMode !== undefined || change.interactionMode !== undefined);
}

/** A turn is in progress. A session that is only starting, such as after a restart, runs no turn yet. */
/** A provider session that T3 restarts when the permission mode changes. */
function liveSession(thread: T3Thread): boolean {
  return thread.session != null && thread.session.status !== "stopped";
}

function turnRunning(thread: T3Thread): boolean {
  return (
    thread.latestTurn?.state === "running" || thread.session?.status === "running" || thread.session?.activeTurnId != null
  );
}

function activityIds(thread: T3Thread): Set<unknown> {
  return new Set((Array.isArray(thread.activities) ? thread.activities : []).map((activity) => (activity as { id?: unknown }).id));
}

/** Finds an activity that T3 added after `before` was read, such as a provider's response. */
function newActivity(
  thread: T3Thread,
  before: Set<unknown>,
  match: (kind: string, payload: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const activities = Array.isArray(thread.activities) ? (thread.activities as Array<Record<string, unknown>>) : [];
  return (
    activities.find((activity) => {
      const payload = activity?.payload;
      return (
        !before.has(activity?.id) &&
        typeof activity?.kind === "string" &&
        payload !== null &&
        typeof payload === "object" &&
        match(activity.kind, payload as Record<string, unknown>)
      );
    }) ?? null
  );
}

function requireWritableThread(thread: T3Thread): void {
  if (thread.archivedAt != null) {
    throw new CliError("THREAD_ARCHIVED", `Thread ${thread.id} is archived.`, {
      exitCode: 4,
      details: { threadId: thread.id, archivedAt: thread.archivedAt },
    });
  }
}

/**
 * Plans the commands that change a thread's settings the way T3 Code's composer does: the model
 * selection first, then the permission mode, then plan or build mode. Only changed values produce a
 * command. T3 validates a model only when the next turn starts, so the plan checks it up front.
 */
export function planThreadSettings(
  thread: T3Thread,
  change: ThreadSettingsChange,
  catalog: ProviderCatalog | null,
): ThreadSettingsPlan {
  const current = thread.modelSelection ?? null;
  let modelSelection: ModelSelection | null = null;
  if (hasModelChange(change)) {
    if (!current) {
      throw new CliError("T3_INVALID_THREAD", `Thread ${thread.id} has no saved model selection.`, {
        details: { threadId: thread.id },
      });
    }
    const next = catalog
      ? resolveModelChange(current, change, catalog)
      : applyModelOverrides(current, change, "thread", THREAD_EFFORT_OPTION_IDS);
    if (next.instanceId !== current.instanceId && thread.session != null) {
      // T3 rejects moving a started conversation to another driver or to incompatible resume state.
      const from = catalog ? findProvider(catalog, current.instanceId) : null;
      const to = catalog ? findProvider(catalog, next.instanceId) : null;
      // Without a continuation key, nothing shows the two instances can resume each other's conversation.
      const compatible =
        from && to && from.driver === to.driver && from.continuationKey !== null && from.continuationKey === to.continuationKey;
      if (!compatible) {
        throw new CliError(
          "PROVIDER_SWITCH_UNSUPPORTED",
          `Thread ${thread.id} already runs on ${current.instanceId}, and T3 cannot move a started conversation to ${next.instanceId}. Hand the work over to a new thread instead.`,
          { exitCode: 4, details: { threadId: thread.id, provider: current.instanceId, requestedProvider: next.instanceId } },
        );
      }
    }
    if (!sameModelSelection(next, current)) modelSelection = next;
  }

  // A failed restart can leave a live session on the old mode while the thread shows the new one.
  const runtimeMode =
    change.runtimeMode !== undefined &&
    (change.runtimeMode !== thread.runtimeMode || (liveSession(thread) && thread.session?.runtimeMode !== change.runtimeMode))
      ? change.runtimeMode
      : null;
  const interactionMode =
    change.interactionMode !== undefined && change.interactionMode !== thread.interactionMode
      ? change.interactionMode
      : null;
  if (runtimeMode && turnRunning(thread)) {
    throw new CliError(
      "THREAD_BUSY",
      `Changing the permission mode restarts the provider session, which would stop thread ${thread.id}'s running turn. Wait for the turn or interrupt it first.`,
      { exitCode: 4, details: { threadId: thread.id, sessionStatus: thread.session?.status ?? null } },
    );
  }
  if (interactionMode === "plan" && catalog) {
    const provider = findProvider(catalog, (modelSelection ?? current)?.instanceId ?? "");
    if (provider && !provider.supportsPlanMode) {
      throw new CliError(
        "PLAN_MODE_UNSUPPORTED",
        `${provider.instanceId} has no plan mode in T3 Code.${provider.driver === "opencode" ? " Use --option agent=plan instead." : ""}`,
        { exitCode: 2, details: { provider: provider.instanceId } },
      );
    }
  }

  const createdAt = new Date().toISOString();
  const commands: ThreadSettingsPlan["commands"] = [];
  if (modelSelection) {
    commands.push({ type: "thread.meta.update", commandId: randomUUID(), threadId: thread.id, modelSelection });
  }
  if (runtimeMode) {
    commands.push({ type: "thread.runtime-mode.set", commandId: randomUUID(), threadId: thread.id, runtimeMode, createdAt });
  }
  if (interactionMode) {
    commands.push({
      type: "thread.interaction-mode.set",
      commandId: randomUUID(),
      threadId: thread.id,
      interactionMode,
      createdAt,
    });
  }
  return { modelSelection, runtimeMode, interactionMode, commands, catalogUsed: catalog !== null };
}

/** The catalog is only needed to check model settings. Older T3 servers do not serve it. */
async function catalogFor(api: T3Api, change: ThreadSettingsChange): Promise<ProviderCatalog | null> {
  if (!hasModelChange(change) && change.interactionMode !== "plan") return null;
  return await fetchCatalog(api).catch(() => null);
}

/** Dispatches a settings plan and waits until T3's projection shows every change. */
async function applyThreadSettings(
  adapter: T3ThreadApi,
  thread: T3Thread,
  plan: ThreadSettingsPlan,
): Promise<{ dispatches: unknown[]; thread: T3Thread; sessionRestarted: boolean }> {
  if (plan.commands.length === 0) return { dispatches: [], thread, sessionRestarted: false };
  const dispatches: unknown[] = [];
  for (const command of plan.commands) dispatches.push(await adapter.dispatchControl(command));
  const verified = await adapter.poll(thread.id, (candidate) =>
    (!plan.modelSelection || sameModelSelection(candidate.modelSelection, plan.modelSelection)) &&
    (!plan.runtimeMode || candidate.runtimeMode === plan.runtimeMode) &&
    (!plan.interactionMode || candidate.interactionMode === plan.interactionMode)
      ? candidate
      : null,
  );
  if (!verified.value) {
    throw new CliError("THREAD_SETTINGS_NOT_VERIFIED", `T3 did not show the new settings for thread ${thread.id}.`, {
      exitCode: 5,
      details: { threadId: thread.id, commands: plan.commands.map((command) => command.type) },
    });
  }
  if (!plan.runtimeMode || !liveSession(thread)) return { dispatches, thread: verified.value, sessionRestarted: false };

  // T3 saves the mode at once but restarts the live session afterwards, and logs a failed restart only
  // on the server. The session's own mode shows whether the restart took effect.
  const requested = plan.runtimeMode;
  const restarted = await adapter.poll(
    thread.id,
    (candidate) => (!liveSession(candidate) || candidate.session?.runtimeMode === requested ? candidate : null),
    adapter.controlTimeoutMs,
  );
  if (!restarted.value) {
    const lastError = restarted.thread?.session?.lastError ?? null;
    throw new CliError(
      "THREAD_PERMISSION_NOT_APPLIED",
      `T3 saved permission ${requested} for thread ${thread.id}, but its provider session still runs with ${restarted.thread?.session?.runtimeMode ?? "another mode"}.${lastError ? ` T3 reported: ${lastError}` : ""}`,
      {
        exitCode: 5,
        details: {
          threadId: thread.id,
          runtimeMode: requested,
          sessionRuntimeMode: restarted.thread?.session?.runtimeMode ?? null,
          sessionStatus: restarted.thread?.session?.status ?? null,
          lastError,
        },
      },
    );
  }
  return { dispatches, thread: restarted.value, sessionRestarted: liveSession(restarted.value) };
}

/** Plans and applies a settings change inside an open T3 session; used before a message is sent. */
export async function changeSettingsWithApi(
  api: T3Api,
  adapter: T3ThreadApi,
  thread: T3Thread,
  change: ThreadSettingsChange,
): Promise<{ plan: ThreadSettingsPlan; dispatches: unknown[]; thread: T3Thread; sessionRestarted: boolean }> {
  const plan = planThreadSettings(thread, change, await catalogFor(api, change));
  return { plan, ...(await applyThreadSettings(adapter, thread, plan)) };
}

function settingsView(thread: T3Thread) {
  return {
    modelSelection: thread.modelSelection ?? null,
    runtimeMode: thread.runtimeMode ?? null,
    interactionMode: thread.interactionMode ?? null,
    sessionRuntimeMode: thread.session?.runtimeMode ?? null,
  };
}

export function settingsSummary(plan: ThreadSettingsPlan) {
  return {
    modelSelection: plan.modelSelection,
    runtimeMode: plan.runtimeMode,
    interactionMode: plan.interactionMode,
    catalogUsed: plan.catalogUsed,
  };
}

export async function updateThreadSettings(
  config: CliConfig,
  options: { threadId: string; change: ThreadSettingsChange; dryRun?: boolean },
) {
  const threadId = requireThreadId(options.threadId);
  if (!hasSettingsChange(options.change)) {
    throw new CliError("THREAD_SETTINGS_REQUIRED", "Name at least one setting to change.", { exitCode: 2 });
  }
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: !options.dryRun });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    const { thread } = await adapter.read(threadId);
    requireWritableThread(thread);
    const plan = planThreadSettings(thread, options.change, await catalogFor(api, options.change));
    const applied = options.dryRun ? null : await applyThreadSettings(adapter, thread, plan);
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      project: await projectById(api, thread.projectId),
      thread: { id: thread.id, projectId: thread.projectId, title: thread.title },
      dryRun: options.dryRun ?? false,
      changed: plan.commands.length > 0,
      before: settingsView(thread),
      after: applied ? settingsView(applied.thread) : null,
      changes: settingsSummary(plan),
      // Changing the permission mode restarts a live provider session.
      // Set only when the live session came back with the new permission mode.
      sessionRestart: applied?.sessionRestarted ?? false,
      commands: plan.commands,
      dispatches: applied?.dispatches ?? [],
    };
  });
}

export async function interruptThread(config: CliConfig, rawThreadId: string) {
  const threadId = requireThreadId(rawThreadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    const { thread } = await adapter.read(threadId);
    // Interrupting Claude stops its whole session, so only interrupt a turn that is running.
    if (!turnRunning(thread)) {
      throw new CliError("THREAD_NOT_RUNNING", `Thread ${threadId} has no running turn to interrupt.`, {
        exitCode: 4,
        details: { threadId, sessionStatus: thread.session?.status ?? null, latestTurn: thread.latestTurn ?? null },
      });
    }
    // With a turn id, T3 marks that turn interrupted at once; the web UI passes the session's active turn.
    const turnId =
      thread.session?.activeTurnId ?? (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null);
    const command = {
      type: "thread.turn.interrupt",
      commandId: randomUUID(),
      threadId,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    };
    const before = activityIds(thread);
    const dispatch = await adapter.dispatchControl(command);
    // When the provider fails to interrupt, T3 stops the session, so keep waiting for the turn to end.
    const failureOf = (candidate: T3Thread) =>
      newActivity(candidate, before, (kind) => kind === "provider.turn.interrupt.failed");
    const settled = await adapter.poll(
      threadId,
      (candidate) => (turnRunning(candidate) ? null : { thread: candidate, failure: failureOf(candidate) }),
      adapter.controlTimeoutMs,
    );
    if (!settled.value) {
      const failure = settled.thread ? failureOf(settled.thread) : null;
      const detail = (failure?.payload as { detail?: unknown } | undefined)?.detail;
      throw new CliError(
        failure ? "THREAD_INTERRUPT_FAILED" : "THREAD_INTERRUPT_NOT_VERIFIED",
        failure
          ? `The provider could not interrupt thread ${threadId}${typeof detail === "string" ? `: ${detail}` : "."}`
          : `Thread ${threadId} was still running after the interrupt.`,
        {
          exitCode: failure ? 4 : 5,
          details: { threadId, turnId, sessionStatus: settled.thread?.session?.status ?? null, detail: detail ?? null },
        },
      );
    }
    const after = settled.value.thread;
    const failureDetail = (settled.value.failure?.payload as { detail?: unknown } | undefined)?.detail;
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      thread: { id: thread.id, projectId: thread.projectId, title: thread.title },
      turnId,
      latestTurn: after.latestTurn ?? null,
      sessionStatus: after.session?.status ?? null,
      ...(typeof failureDetail === "string" ? { providerError: failureDetail } : {}),
      command,
      dispatch,
    };
  });
}

function selectRequest(
  thread: T3Thread,
  kind: PendingRequest["kind"],
  requestId: string | undefined,
): PendingRequest {
  const noun = kind === "approval" ? "approval" : "question";
  const candidates = pendingRequests(thread).filter((request) => request.kind === kind);
  if (requestId !== undefined) {
    const match = candidates.find((request) => request.requestId === requestId);
    if (match) return match;
    throw new CliError("THREAD_REQUEST_NOT_FOUND", `Thread ${thread.id} has no pending ${noun} ${requestId}.`, {
      exitCode: 3,
      details: { threadId: thread.id, requestId, pending: candidates.map((request) => request.requestId) },
    });
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new CliError("THREAD_REQUEST_NOT_FOUND", `Thread ${thread.id} has no pending ${noun}.`, {
      exitCode: 3,
      details: { threadId: thread.id },
    });
  }
  throw new CliError(
    "THREAD_REQUEST_AMBIGUOUS",
    `Thread ${thread.id} has ${candidates.length} pending ${noun}s; choose one with --request.`,
    { exitCode: 2, details: { threadId: thread.id, pending: candidates.map((request) => request.requestId) } },
  );
}

/** Waits for the provider's resolution of a request, or for its reported failure. */
async function awaitResolution(
  adapter: T3ThreadApi,
  threadId: string,
  requestId: string,
  before: Set<unknown>,
  kind: PendingRequest["kind"],
): Promise<Record<string, unknown>> {
  const resolvedKind = kind === "approval" ? "approval.resolved" : "user-input.resolved";
  const failedKind = kind === "approval" ? "provider.approval.respond.failed" : "provider.user-input.respond.failed";
  const outcome = await adapter.poll(
    threadId,
    (thread) =>
      newActivity(
        thread,
        before,
        (activityKind, payload) => (activityKind === resolvedKind || activityKind === failedKind) && payload.requestId === requestId,
      ),
    RESPONSE_TIMEOUT_MS,
  );
  if (!outcome.value) {
    throw new CliError("THREAD_RESPONSE_NOT_VERIFIED", `T3 did not confirm the response to request ${requestId}.`, {
      exitCode: 5,
      details: { threadId, requestId },
    });
  }
  if (outcome.value.kind === failedKind) {
    const detail = (outcome.value.payload as { detail?: unknown }).detail;
    throw new CliError(
      "THREAD_RESPONSE_FAILED",
      `The provider did not accept the response to request ${requestId}: ${typeof detail === "string" ? detail : "no reason given"}`,
      { exitCode: 4, details: { threadId, requestId, detail: detail ?? null } },
    );
  }
  return outcome.value;
}

async function waitAfterResponse(
  adapter: T3ThreadApi,
  threadId: string,
  wait: ThreadWaitOptions | undefined,
  messageId?: string,
): Promise<Partial<ThreadWaitView>> {
  if (!wait) return {};
  const waited = await adapter.waitForTurn(threadId, {
    timeoutMs: wait.timeoutMs,
    ...(messageId === undefined ? {} : { messageId }),
  });
  return waitView(waited, wait);
}

export async function respondToApproval(
  config: CliConfig,
  options: { threadId: string; requestId?: string; decision: ApprovalDecision; wait?: ThreadWaitOptions },
) {
  const threadId = requireThreadId(options.threadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, configForWait(config, options.wait), async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    const { thread } = await adapter.read(threadId);
    const request = selectRequest(thread, "approval", options.requestId);
    const offered = request.decisions;
    // Claude treats an "always" decision as a denial unless the request offers it.
    const unsupported =
      (offered.length > 0 && !offered.includes(options.decision)) ||
      (options.decision === "acceptAlways" && !offered.includes("acceptAlways"));
    if (unsupported) {
      throw new CliError(
        "DECISION_NOT_OFFERED",
        `This approval does not offer ${options.decision}.${offered.length > 0 ? ` It offers ${offered.join(", ")}.` : ""}`,
        { exitCode: 2, details: { requestId: request.requestId, decision: options.decision, offered } },
      );
    }
    const requestId = request.requestId!;
    const command = {
      type: "thread.approval.respond",
      commandId: randomUUID(),
      threadId,
      requestId,
      decision: options.decision,
      createdAt: new Date().toISOString(),
    };
    const before = activityIds(thread);
    const dispatch = await adapter.dispatchControl(command);
    const resolution = await awaitResolution(adapter, threadId, requestId, before, "approval");
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      thread: { id: thread.id, projectId: thread.projectId, title: thread.title },
      request,
      decision: options.decision,
      command,
      dispatch,
      verification: { resolved: true, activityId: resolution.id ?? null },
      ...(await waitAfterResponse(adapter, threadId, options.wait)),
    };
  });
}

function matchesQuestion(question: PendingQuestion, index: number, key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (
    normalized === String(index + 1) ||
    normalized === question.id.toLowerCase() ||
    (question.header !== null && normalized === question.header.toLowerCase())
  );
}

/**
 * Turns `--answer` values into T3's answers object. Each value is `<question>=<answer>`, where the
 * question is its number, id, or header; a request with one question also takes a bare answer. An
 * answer that names an option sends that option's value, as T3 Code's composer does.
 */
export function resolveAnswers(request: PendingRequest, rawAnswers: readonly string[]): Record<string, string | string[]> {
  const { questions } = request;
  if (questions.length === 0) {
    throw new CliError("ANSWER_UNSUPPORTED", `Request ${request.requestId} has no questions to answer.`, { exitCode: 2 });
  }
  const collected = new Map<number, string[]>();
  for (const raw of rawAnswers) {
    const separator = raw.indexOf("=");
    const key = separator > 0 ? raw.slice(0, separator) : null;
    let index = key === null ? -1 : questions.findIndex((question, position) => matchesQuestion(question, position, key));
    let value = index >= 0 ? raw.slice(separator + 1) : raw;
    if (index < 0) {
      if (questions.length !== 1) {
        throw new CliError(
          "ANSWER_QUESTION_REQUIRED",
          `This request asks ${questions.length} questions; prefix each answer with its number, such as --answer 1=yes.`,
          { exitCode: 2, details: { questions: questions.map((question) => question.question) } },
        );
      }
      index = 0;
      value = raw;
    }
    const question = questions[index]!;
    const trimmed = value.trim();
    const option = question.choices.find(
      (candidate) =>
        candidate.label.toLowerCase() === trimmed.toLowerCase() ||
        (candidate.value !== null && candidate.value.toLowerCase() === trimmed.toLowerCase()),
    );
    if (!option && question.choices.length > 0 && !question.allowCustomAnswer) {
      throw new CliError(
        "INVALID_ANSWER",
        `Question ${index + 1} takes one of: ${question.options.join(", ")}.`,
        { exitCode: 2, details: { question: question.question, answer: value } },
      );
    }
    if (!trimmed) {
      throw new CliError("INVALID_ANSWER", `The answer to question ${index + 1} is empty.`, { exitCode: 2 });
    }
    collected.set(index, [...(collected.get(index) ?? []), option ? (option.value ?? option.label) : trimmed]);
  }

  const answers: Record<string, string | string[]> = {};
  questions.forEach((question, index) => {
    const values = collected.get(index);
    if (!values) {
      throw new CliError("ANSWER_MISSING", `Answer question ${index + 1}: ${question.question}`, {
        exitCode: 2,
        details: { question: question.question },
      });
    }
    // Message-mode questions take one string each; T3 rejects arrays for them.
    if (values.length > 1 && (!question.multiSelect || request.responseMode === "message")) {
      throw new CliError("INVALID_ANSWER", `Question ${index + 1} takes a single answer.`, { exitCode: 2 });
    }
    answers[question.id] = question.multiSelect && request.responseMode !== "message" ? values : values[0]!;
  });
  return answers;
}

export async function answerThread(
  config: CliConfig,
  options: { threadId: string; requestId?: string; answers?: string[]; dismiss?: boolean; wait?: ThreadWaitOptions },
) {
  const threadId = requireThreadId(options.threadId);
  const answerCount = options.answers?.length ?? 0;
  if ((answerCount > 0) === (options.dismiss === true)) {
    throw new CliError("ANSWER_REQUIRED", "Give at least one --answer, or --dismiss the question.", { exitCode: 2 });
  }
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, configForWait(config, options.wait), async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    const { thread } = await adapter.read(threadId);
    const request = selectRequest(thread, "user-input", options.requestId);
    const requestId = request.requestId;
    if (requestId === null) {
      throw new CliError("THREAD_REQUEST_NOT_FOUND", "The pending question has no request id to answer.", { exitCode: 3 });
    }
    if (options.dismiss && request.responseMode !== "message") {
      throw new CliError(
        "DISMISS_UNSUPPORTED",
        "Only questions that outlive their turn can be dismissed. Answer this one, or interrupt the turn.",
        { exitCode: 2, details: { requestId } },
      );
    }
    const answers = options.dismiss ? null : resolveAnswers(request, options.answers ?? []);
    const createdAt = new Date().toISOString();
    const command = answers
      ? { type: "thread.user-input.respond", commandId: randomUUID(), threadId, requestId, answers, createdAt }
      : { type: "thread.user-input.dismiss", commandId: randomUUID(), threadId, requestId, createdAt };
    const before = activityIds(thread);
    const dispatch = await adapter.dispatchControl(command);
    const resolution = await awaitResolution(adapter, threadId, requestId, before, "user-input");
    // T3 sends an answer to a message-mode question as a new turn with this message id.
    const answerMessageId = answers && request.responseMode === "message" ? `async-answer:${requestId}` : undefined;
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      thread: { id: thread.id, projectId: thread.projectId, title: thread.title, status: threadStatus(thread) },
      request,
      dismissed: options.dismiss === true,
      answers,
      ...(answerMessageId ? { answerMessageId } : {}),
      command,
      dispatch,
      verification: { resolved: true, activityId: resolution.id ?? null },
      ...(await waitAfterResponse(adapter, threadId, options.dismiss ? undefined : options.wait, answerMessageId)),
    };
  });
}

export async function listModels(config: CliConfig, options: { provider?: string } = {}) {
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, config, async (api) => {
    const catalog = await fetchCatalog(api);
    const providers = options.provider
      ? catalog.providers.filter((provider) => provider.instanceId === options.provider)
      : catalog.providers;
    if (options.provider && providers.length === 0) {
      throw new CliError("PROVIDER_NOT_FOUND", `T3 has no provider instance ${options.provider}.`, {
        exitCode: 3,
        details: { available: catalog.providers.map((provider) => provider.instanceId) },
      });
    }
    return { runtime, providers };
  });
}
