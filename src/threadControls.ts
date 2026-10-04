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
import { activeRun, isActiveRun, pendingRequests, type PendingQuestion, type PendingRequest } from "./transcript.js";
import type { CliConfig, InteractionMode, ModelSelection, RuntimeMode, T3ThreadProjection } from "./types.js";

/** Settings a caller asks to change on an existing thread; anything left out stays as it is. */
export interface ThreadSettingsChange extends ModelChange {
  runtimeMode?: RuntimeMode | undefined;
  interactionMode?: InteractionMode | undefined;
}

export interface ThreadSettingsPlan {
  /** The new model selection, or null when it does not change. */
  modelSelection: ModelSelection | null;
  /** True when the new model runs on another provider instance, which T3 reaches through a handoff. */
  providerSwitch: boolean;
  runtimeMode: RuntimeMode | null;
  interactionMode: InteractionMode | null;
  commands: Array<{ type: string; commandId: string; threadId: string; [key: string]: unknown }>;
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

function requireWritableThread(projection: T3ThreadProjection): void {
  const thread = projection.thread;
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
 * command. A model on another provider instance goes through T3's provider switch, which hands the
 * conversation over with a budgeted share of its history.
 */
export function planThreadSettings(
  projection: T3ThreadProjection,
  change: ThreadSettingsChange,
  catalog: ProviderCatalog | null,
): ThreadSettingsPlan {
  const thread = projection.thread;
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
    if (!sameModelSelection(next, current)) modelSelection = next;
  }
  const providerSwitch = modelSelection !== null && modelSelection.instanceId !== current?.instanceId;

  const runtimeMode = change.runtimeMode !== undefined && change.runtimeMode !== thread.runtimeMode ? change.runtimeMode : null;
  const interactionMode =
    change.interactionMode !== undefined && change.interactionMode !== thread.interactionMode ? change.interactionMode : null;
  if ((runtimeMode || providerSwitch) && activeRun(projection)) {
    throw new CliError(
      "THREAD_BUSY",
      `${providerSwitch ? "Switching the provider" : "Changing the permission mode"} restarts thread ${thread.id}'s provider session, which would stop its running turn. Wait for the turn or interrupt it first.`,
      { exitCode: 4, details: { threadId: thread.id, activeRunId: activeRun(projection)?.id ?? null } },
    );
  }
  // A thread already in plan mode keeps it, so a new provider must support it too.
  const keepsPlanMode = thread.interactionMode === "plan" && providerSwitch;
  if ((interactionMode === "plan" || keepsPlanMode) && catalog) {
    const provider = findProvider(catalog, (modelSelection ?? current)?.instanceId ?? "");
    if (provider && !provider.supportsPlanMode) {
      throw new CliError(
        "PLAN_MODE_UNSUPPORTED",
        `${provider.instanceId} has no plan mode in T3 Code.${provider.driver === "opencode" ? " Use --option agent=plan instead." : ""}`,
        { exitCode: 2, details: { provider: provider.instanceId } },
      );
    }
  }

  const commands: ThreadSettingsPlan["commands"] = [];
  if (modelSelection) {
    commands.push({
      type: providerSwitch ? "provider.switch" : "thread.model-selection.set",
      commandId: randomUUID(),
      threadId: thread.id,
      modelSelection,
    });
  }
  if (runtimeMode) {
    commands.push({ type: "thread.runtime-mode.set", commandId: randomUUID(), threadId: thread.id, runtimeMode });
  }
  if (interactionMode) {
    commands.push({ type: "thread.interaction-mode.set", commandId: randomUUID(), threadId: thread.id, interactionMode });
  }
  return { modelSelection, providerSwitch, runtimeMode, interactionMode, commands, catalogUsed: catalog !== null };
}

/** The catalog is only needed to check model settings. */
async function catalogFor(api: T3Api, change: ThreadSettingsChange): Promise<ProviderCatalog | null> {
  if (!hasModelChange(change) && change.interactionMode !== "plan") return null;
  return await fetchCatalog(api).catch(() => null);
}

/** Dispatches a settings plan and waits until T3's projection shows every change. */
async function applyThreadSettings(
  adapter: T3ThreadApi,
  projection: T3ThreadProjection,
  plan: ThreadSettingsPlan,
): Promise<{ dispatches: Array<{ sequence: number }>; projection: T3ThreadProjection }> {
  if (plan.commands.length === 0) return { dispatches: [], projection };
  const dispatches: Array<{ sequence: number }> = [];
  for (const command of plan.commands) dispatches.push(await adapter.dispatch(command));
  const verified = await adapter.poll(
    projection.thread.id,
    (candidate) =>
      (!plan.modelSelection || sameModelSelection(candidate.thread.modelSelection, plan.modelSelection)) &&
      (!plan.runtimeMode || candidate.thread.runtimeMode === plan.runtimeMode) &&
      (!plan.interactionMode || candidate.thread.interactionMode === plan.interactionMode)
        ? candidate
        : null,
    adapter.controlTimeoutMs,
  );
  if (!verified.value) {
    throw new CliError("THREAD_SETTINGS_NOT_VERIFIED", `T3 did not show the new settings for thread ${projection.thread.id}.`, {
      exitCode: 5,
      details: { threadId: projection.thread.id, commands: plan.commands.map((command) => command.type) },
    });
  }
  return { dispatches, projection: verified.value };
}

/** Plans and applies a settings change inside an open T3 session; used before a message is sent. */
export async function changeSettingsWithApi(
  api: T3Api,
  adapter: T3ThreadApi,
  projection: T3ThreadProjection,
  change: ThreadSettingsChange,
): Promise<{ plan: ThreadSettingsPlan; dispatches: Array<{ sequence: number }>; projection: T3ThreadProjection }> {
  // A message that joins a running turn keeps that turn's settings.
  if (activeRun(projection)) {
    throw new CliError(
      "THREAD_BUSY",
      `Thread ${projection.thread.id} is running a turn, and a message sent now would run with its current settings. Wait for the turn, then send with the new settings.`,
      { exitCode: 4, details: { threadId: projection.thread.id, activeRunId: activeRun(projection)?.id ?? null } },
    );
  }
  const plan = planThreadSettings(projection, change, await catalogFor(api, change));
  return { plan, ...(await applyThreadSettings(adapter, projection, plan)) };
}

function settingsView(projection: T3ThreadProjection) {
  return {
    modelSelection: projection.thread.modelSelection ?? null,
    runtimeMode: projection.thread.runtimeMode ?? null,
    interactionMode: projection.thread.interactionMode ?? null,
  };
}

export function settingsSummary(plan: ThreadSettingsPlan) {
  return {
    modelSelection: plan.modelSelection,
    providerSwitch: plan.providerSwitch,
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
    const { projection } = await adapter.inspect(threadId);
    requireWritableThread(projection);
    const plan = planThreadSettings(projection, options.change, await catalogFor(api, options.change));
    const applied = options.dryRun ? null : await applyThreadSettings(adapter, projection, plan);
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      project: await projectById(api, projection.thread.projectId),
      thread: { id: projection.thread.id, projectId: projection.thread.projectId, title: projection.thread.title },
      dryRun: options.dryRun ?? false,
      changed: plan.commands.length > 0,
      before: settingsView(projection),
      after: applied ? settingsView(applied.projection) : null,
      changes: settingsSummary(plan),
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
    const { projection } = await adapter.inspect(threadId);
    const run = activeRun(projection);
    // Interrupting Claude stops its whole session, so only interrupt a turn that is running.
    if (!run) {
      throw new CliError("THREAD_NOT_RUNNING", `Thread ${threadId} has no running turn to interrupt.`, {
        exitCode: 4,
        details: { threadId },
      });
    }
    const command = { type: "run.interrupt", commandId: randomUUID(), threadId, runId: run.id };
    const dispatch = await adapter.dispatch(command);
    const stopped = await adapter.poll(
      threadId,
      (candidate) => {
        const current = candidate.runs.find((other) => other.id === run.id);
        return current && !isActiveRun(current) ? current : null;
      },
      adapter.controlTimeoutMs,
    );
    if (!stopped.value) {
      throw new CliError("THREAD_INTERRUPT_NOT_VERIFIED", `Thread ${threadId} was still running after the interrupt.`, {
        exitCode: 5,
        details: { threadId, runId: run.id },
      });
    }
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      thread: { id: projection.thread.id, projectId: projection.thread.projectId, title: projection.thread.title },
      turnId: run.id,
      runStatus: stopped.value.status,
      command,
      dispatch,
    };
  });
}

function selectRequest(projection: T3ThreadProjection, kind: PendingRequest["kind"], requestId: string | undefined): PendingRequest {
  const threadId = projection.thread.id;
  const noun = kind === "approval" ? "approval" : "question";
  const candidates = pendingRequests(projection).filter((request) => request.kind === kind);
  if (requestId !== undefined) {
    const match = candidates.find((request) => request.requestId === requestId);
    if (match) return match;
    throw new CliError("THREAD_REQUEST_NOT_FOUND", `Thread ${threadId} has no pending ${noun} ${requestId}.`, {
      exitCode: 3,
      details: { threadId, requestId, pending: candidates.map((request) => request.requestId) },
    });
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new CliError("THREAD_REQUEST_NOT_FOUND", `Thread ${threadId} has no pending ${noun}.`, {
      exitCode: 3,
      details: { threadId },
    });
  }
  throw new CliError("THREAD_REQUEST_AMBIGUOUS", `Thread ${threadId} has ${candidates.length} pending ${noun}s; choose one with --request.`, {
    exitCode: 2,
    details: { threadId, pending: candidates.map((request) => request.requestId) },
  });
}

/** Waits until T3 records the request as resolved, or reports that it closed another way. */
async function awaitResolution(adapter: T3ThreadApi, threadId: string, requestId: string) {
  const outcome = await adapter.poll(
    threadId,
    (projection) => {
      const request = projection.runtimeRequests.find((candidate) => candidate.id === requestId);
      return request && request.status !== "pending" ? request : null;
    },
    RESPONSE_TIMEOUT_MS,
  );
  if (!outcome.value) {
    throw new CliError("THREAD_RESPONSE_NOT_VERIFIED", `T3 did not confirm the response to request ${requestId}.`, {
      exitCode: 5,
      details: { threadId, requestId },
    });
  }
  if (outcome.value.status !== "resolved") {
    throw new CliError("THREAD_RESPONSE_FAILED", `T3 closed request ${requestId} as ${outcome.value.status} instead of applying the response.`, {
      exitCode: 4,
      details: { threadId, requestId, status: outcome.value.status },
    });
  }
  return outcome.value;
}

async function waitAfterResponse(
  adapter: T3ThreadApi,
  threadId: string,
  requestId: string,
  wait: ThreadWaitOptions | undefined,
): Promise<Partial<ThreadWaitView>> {
  if (!wait) return {};
  const waited = await adapter.waitForTurn(threadId, { timeoutMs: wait.timeoutMs }).catch((cause: unknown) => {
    if (!(cause instanceof CliError) || cause.code !== "THREAD_WAIT_TIMEOUT") throw cause;
    // T3 already accepted the response; a caller must not send it again.
    throw new CliError(
      "THREAD_WAIT_TIMEOUT",
      `T3 accepted the response to request ${requestId}, but thread ${threadId} did not finish within ${Math.round(wait.timeoutMs / 1000)} seconds. Do not respond again; run threads wait to keep waiting.`,
      { exitCode: cause.exitCode, details: { ...(cause.details as object), responded: true, requestId } },
    );
  });
  return waitView(waited, wait);
}

function requireAnswerable(request: PendingRequest): void {
  if (request.answerable) return;
  throw new CliError(
    "REQUEST_NOT_ANSWERABLE",
    `The provider session that raised request ${request.requestId} is gone, so it cannot take a response.${request.kind === "user-input" ? " Dismiss it with --dismiss." : ""}`,
    { exitCode: 4, details: { requestId: request.requestId } },
  );
}

export async function respondToApproval(
  config: CliConfig,
  options: { threadId: string; requestId?: string; decision: ApprovalDecision; wait?: ThreadWaitOptions },
) {
  const threadId = requireThreadId(options.threadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, configForWait(config, options.wait), async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    // A request's details live in its timeline item, which a bounded window can leave out.
    const { projection } = await adapter.read(threadId);
    const request = selectRequest(projection, "approval", options.requestId);
    requireAnswerable(request);
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
    const command = {
      type: "runtime-request.respond",
      commandId: randomUUID(),
      threadId,
      requestId: request.requestId,
      decision: options.decision,
    };
    const dispatch = await adapter.dispatch(command);
    const resolved = await awaitResolution(adapter, threadId, request.requestId);
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      thread: { id: projection.thread.id, projectId: projection.thread.projectId, title: projection.thread.title },
      request,
      decision: options.decision,
      command,
      dispatch,
      verification: { resolved: true, resolvedAt: resolved.resolvedAt },
      ...(await waitAfterResponse(adapter, threadId, request.requestId, options.wait)),
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
      throw new CliError("INVALID_ANSWER", `Question ${index + 1} takes one of: ${question.options.join(", ")}.`, {
        exitCode: 2,
        details: { question: question.question, answer: value },
      });
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
    // Message-mode questions take one string each.
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
    const { projection } = await adapter.read(threadId);
    const request = selectRequest(projection, "user-input", options.requestId);
    // A live session waits on its question; dismissing it would leave the turn hanging.
    if (options.dismiss && request.blocking && request.answerable) {
      throw new CliError(
        "DISMISS_UNSUPPORTED",
        "A running turn waits on this question. Answer it, or interrupt the turn.",
        { exitCode: 2, details: { requestId: request.requestId } },
      );
    }
    if (!options.dismiss) requireAnswerable(request);
    const answers = options.dismiss ? null : resolveAnswers(request, options.answers ?? []);
    const command = answers
      ? { type: "runtime-request.respond", commandId: randomUUID(), threadId, requestId: request.requestId, answers }
      : { type: "thread.user-input.dismiss", commandId: randomUUID(), threadId, requestId: request.requestId };
    const dispatch = await adapter.dispatch(command);
    const resolved = options.dismiss
      ? await adapter.poll(threadId, (candidate) => {
          const current = candidate.runtimeRequests.find((other) => other.id === request.requestId);
          return current && current.status !== "pending" ? current : null;
        }, RESPONSE_TIMEOUT_MS).then((outcome) => {
          if (!outcome.value) {
            throw new CliError("THREAD_RESPONSE_NOT_VERIFIED", `T3 did not confirm dismissing request ${request.requestId}.`, {
              exitCode: 5,
              details: { threadId, requestId: request.requestId },
            });
          }
          return outcome.value;
        })
      : await awaitResolution(adapter, threadId, request.requestId);
    return {
      runtime,
      auth: { source: invocation.source, version: invocation.version },
      thread: {
        id: projection.thread.id,
        projectId: projection.thread.projectId,
        title: projection.thread.title,
        status: threadStatus(projection.thread),
      },
      request,
      dismissed: options.dismiss === true,
      answers,
      // T3 sends an answer to a message-mode question to the thread as a new turn.
      startsTurn: answers !== null && request.responseMode === "message",
      command,
      dispatch,
      verification: { resolved: true, status: resolved.status, resolvedAt: resolved.resolvedAt },
      ...(await waitAfterResponse(adapter, threadId, request.requestId, options.dismiss ? undefined : options.wait)),
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
