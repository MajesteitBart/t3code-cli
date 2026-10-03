import { randomUUID } from "node:crypto";

import { withT3Api, type T3Api } from "./api.js";
import { fetchCatalog, resolveModelChange } from "./catalog.js";
import { CliError } from "./errors.js";
import { applyModelOverrides, normalizeProviderOptions, type ModelOverrides } from "./modelSelection.js";
import { openThread } from "./open.js";
import { readLocalProjects } from "./localProjects.js";
import { discoverRuntime } from "./runtime.js";
import { createdBy, T3ThreadApi, type ThreadRead } from "./threadApi.js";
import { projectById, requireThreadId } from "./threadSupport.js";
import { activeRun, buildTranscript, queuedRuns, runMessage } from "./transcript.js";
import type {
  CliConfig,
  InteractionMode,
  ModelSelection,
  OpenMode,
  RuntimeMode,
  SpeedMode,
  T3AppThread,
  T3Project,
  T3Runtime,
  T3ThreadProjection,
} from "./types.js";
import { pathsEqual, resolveWorkspace } from "./workspace.js";

/** Used only when neither the schedule, its project, nor T3's catalog names a model. */
const FALLBACK_MODEL_SELECTION: ModelSelection = { instanceId: "codex", model: "gpt-5.6-sol" };
const MIN_SCHEDULE_INTERVAL_MS = 60_000;
const SEARCH_QUERY_MIN = 2;
const SEARCH_QUERY_MAX = 200;
const SEARCH_LIMIT_MAX = 50;
// A manual run can launch a thread in a new worktree, which T3 allows several minutes.
const SCHEDULE_RUN_TIMEOUT_MS = 10 * 60_000;

const DURATION_UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const FULL_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function usage(code: string, message: string, details?: Record<string, unknown>): CliError {
  return new CliError(code, message, { exitCode: 2, ...(details ? { details } : {}) });
}

/** Parses durations such as 30m, 2h, 1d, or 1h30m into milliseconds; null when the text is not one. */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase();
  if (!/^(\d+[smhdw])+$/u.test(value)) return null;
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+)([smhdw])/gu)) total += Number(amount) * DURATION_UNITS[unit!]!;
  return total;
}

function formatDuration(milliseconds: number): string {
  let rest = milliseconds;
  const parts: string[] = [];
  for (const unit of ["d", "h", "m", "s"]) {
    const size = DURATION_UNITS[unit]!;
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  return parts.join("") || `${milliseconds}ms`;
}

function connection(runtime: T3Runtime, invocation: { source: string; version: string | null }) {
  return { runtime, auth: { source: invocation.source, version: invocation.version } };
}

function requireLiveThread(read: ThreadRead): T3AppThread {
  const thread = read.projection.thread;
  if (thread.deletedAt != null) {
    throw new CliError("THREAD_NOT_FOUND", `No T3 Code thread exists with id ${thread.id}.`, {
      exitCode: 3,
      details: { threadId: thread.id },
    });
  }
  return thread;
}

function threadRef(thread: T3AppThread) {
  return { id: thread.id, projectId: thread.projectId, title: thread.title };
}

/** Dispatches a command, then reads `threadId` until `applied` holds; fails with exit code 5 when it never does. */
async function dispatchVerified(
  adapter: T3ThreadApi,
  threadId: string,
  command: { type: string; commandId: string; [key: string]: unknown },
  applied: (projection: T3ThreadProjection) => boolean,
  failure: { code: string; message: string },
) {
  const dispatch = await adapter.dispatch(command);
  const seen = await adapter.poll(threadId, (projection) => (applied(projection) ? projection : null));
  if (!seen.value) {
    throw new CliError(failure.code, failure.message, {
      exitCode: 5,
      details: { threadId, type: command.type, dispatchSequence: dispatch.sequence },
    });
  }
  return { dispatch, projection: seen.value };
}

// Forks and merge-back

export type SourcePoint =
  | { type: "latest_stable" }
  | { type: "run"; runId: string }
  | { type: "checkpoint"; checkpointId: string };

/**
 * Resolves `--from`: `latest`, a run or checkpoint id (with or without a `run:`/`checkpoint:` prefix),
 * or `turn:<n>` with the turn number `threads read` prints.
 */
export function sourcePointFor(projection: T3ThreadProjection, raw: string | undefined): SourcePoint {
  const value = raw?.trim() ?? "latest";
  if (value === "latest") return { type: "latest_stable" };
  const turn = /^turn:(\d+)$/u.exec(value);
  if (turn) {
    const entry = buildTranscript(projection, { detail: "answers" }).turns.find((candidate) => candidate.index === Number(turn[1]));
    // A fork's inherited turns are runs of its source thread, which T3 forks only from that thread.
    if (entry?.inherited) {
      throw new CliError(
        "SOURCE_POINT_INHERITED",
        `Turn ${turn[1]} of thread ${projection.thread.id} is inherited from thread ${entry.sourceThreadId}. Fork that thread instead.`,
        { exitCode: 2, details: { threadId: projection.thread.id, sourceThreadId: entry.sourceThreadId, runId: entry.turnId } },
      );
    }
    if (entry?.turnId) return { type: "run", runId: entry.turnId };
  }
  const runIds = new Set(projection.runs.map((run) => run.id));
  const checkpointIds = new Set(
    (projection.checkpoints ?? []).flatMap((checkpoint) => {
      const id = record(checkpoint)?.id;
      return typeof id === "string" ? [id] : [];
    }),
  );
  // T3's own ids already start with run: or checkpoint:, so the whole value is tried first.
  const candidates = [value, value.replace(/^run:/u, ""), value.replace(/^checkpoint:/u, "")];
  for (const id of candidates) {
    if (runIds.has(id)) return { type: "run", runId: id };
    if (checkpointIds.has(id)) return { type: "checkpoint", checkpointId: id };
  }
  throw new CliError(
    "SOURCE_POINT_NOT_FOUND",
    `Thread ${projection.thread.id} has no run, checkpoint, or turn matching ${value}. Use latest, turn:<n>, or a run id from threads read --json.`,
    { exitCode: 3, details: { threadId: projection.thread.id, from: value } },
  );
}

async function readForSourcePoint(adapter: T3ThreadApi, threadId: string, from: string | undefined): Promise<ThreadRead> {
  // Turn numbers and older checkpoints need the whole thread; `latest` only needs its runs.
  return from === undefined || from.trim() === "latest" ? await adapter.inspect(threadId) : await adapter.read(threadId);
}

export interface ForkOptions {
  threadId: string;
  from?: string;
  title?: string;
  openMode?: OpenMode;
}

export async function forkThread(config: CliConfig, options: ForkOptions) {
  const threadId = requireThreadId(options.threadId);
  const title = options.title?.trim();
  if (options.title !== undefined && !title) throw usage("TITLE_REQUIRED", "--title needs a non-empty title.");
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  const result = await withT3Api(runtime, config, async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    const read = await readForSourcePoint(adapter, threadId, options.from);
    const source = requireLiveThread(read);
    const sourcePoint = sourcePointFor(read.projection, options.from);
    const targetThreadId = randomUUID();
    const command = {
      type: "thread.fork",
      commandId: randomUUID(),
      sourceThreadId: threadId,
      targetThreadId,
      sourcePoint,
      ...(title ? { title } : {}),
      ...createdBy(),
    };
    const dispatch = await adapter.dispatch(command);
    const created = await adapter.poll(targetThreadId, (projection) => projection);
    if (!created.value) {
      throw new CliError("FORK_NOT_VERIFIED", `T3 accepted the fork of ${threadId}, but thread ${targetThreadId} did not appear.`, {
        exitCode: 5,
        details: { sourceThreadId: threadId, targetThreadId, dispatchSequence: dispatch.sequence },
      });
    }
    const fork = created.value.thread;
    return {
      ...connection(runtime, invocation),
      project: await projectById(api, fork.projectId),
      source: threadRef(source),
      sourcePoint,
      thread: { ...threadRef(fork), forkedFrom: fork.forkedFrom ?? null },
      command,
      dispatch,
    };
  });
  const opened = await openThread(options.openMode ?? config.openMode, runtime, result.thread.id);
  return { ...result, opened };
}

/** The thread a fork came from, from its fork record or, failing that, its lineage. */
export function forkParentOf(thread: T3AppThread): string | null {
  if (typeof thread.forkedFrom?.threadId === "string") return thread.forkedFrom.threadId;
  return thread.lineage?.relationshipToParent === "fork" ? (thread.lineage.parentThreadId ?? null) : null;
}

function mergeBackTransfers(projection: T3ThreadProjection, sourceThreadId: string) {
  const transfers = Array.isArray(projection.contextTransfers) ? projection.contextTransfers : [];
  return transfers.flatMap((entry) => {
    const transfer = record(entry);
    return transfer && transfer.type === "merge_back" && transfer.sourceThreadId === sourceThreadId && typeof transfer.id === "string"
      ? [{ id: transfer.id, status: typeof transfer.status === "string" ? transfer.status : null }]
      : [];
  });
}

export interface MergeBackOptions {
  threadId: string;
  into?: string;
  from?: string;
}

export async function mergeBackThread(config: CliConfig, options: MergeBackOptions) {
  const threadId = requireThreadId(options.threadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    const read = await readForSourcePoint(adapter, threadId, options.from);
    const fork = requireLiveThread(read);
    const targetThreadId = options.into === undefined ? forkParentOf(fork) : requireThreadId(options.into);
    if (!targetThreadId) {
      throw new CliError("THREAD_NOT_A_FORK", `Thread ${threadId} is not a fork. Pass --into <thread-id> to name the thread to merge into.`, {
        exitCode: 4,
        details: { threadId },
      });
    }
    const sourcePoint = sourcePointFor(read.projection, options.from);
    const before = await adapter.inspect(targetThreadId);
    const target = requireLiveThread(before);
    const known = new Set(mergeBackTransfers(before.projection, threadId).map((transfer) => transfer.id));
    const command = {
      type: "thread.merge_back",
      commandId: randomUUID(),
      sourceThreadId: threadId,
      targetThreadId,
      sourcePoint,
      ...createdBy(),
    };
    const { dispatch, projection } = await dispatchVerified(
      adapter,
      targetThreadId,
      command,
      (candidate) => mergeBackTransfers(candidate, threadId).some((transfer) => !known.has(transfer.id)),
      { code: "MERGE_BACK_NOT_VERIFIED", message: `T3 accepted the merge-back, but thread ${targetThreadId} shows no new transfer from ${threadId}.` },
    );
    const transfer = mergeBackTransfers(projection, threadId).find((candidate) => !known.has(candidate.id))!;
    return {
      ...connection(runtime, invocation),
      project: await projectById(api, target.projectId),
      source: threadRef(fork),
      target: threadRef(target),
      sourcePoint,
      transfer,
      command,
      dispatch,
    };
  });
}

// The follow-up queue

function queueEntries(projection: T3ThreadProjection) {
  return queuedRuns(projection).map((run, index) => ({
    runId: run.id,
    position: index + 1,
    held: run.queueHeld === true,
    text: runMessage(projection, run)?.text ?? "",
    requestedAt: run.requestedAt,
  }));
}

export async function listQueue(config: CliConfig, rawThreadId: string) {
  const threadId = requireThreadId(rawThreadId);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const read = await new T3ThreadApi(api).inspect(threadId);
    const thread = requireLiveThread(read);
    return {
      ...connection(runtime, invocation),
      thread: threadRef(thread),
      activeRunId: activeRun(read.projection)?.id ?? null,
      queue: queueEntries(read.projection),
    };
  });
}

export type QueueChange =
  | { type: "edit"; runId: string; text: string }
  | { type: "cancel"; runId: string }
  | { type: "move"; runId: string; beforeRunId: string | null }
  | { type: "promote"; runId: string }
  | { type: "resume" };

function requireQueued(projection: T3ThreadProjection, runId: string) {
  const run = queuedRuns(projection).find((candidate) => candidate.id === runId);
  if (!run) {
    throw new CliError("QUEUED_RUN_NOT_FOUND", `Thread ${projection.thread.id} has no queued message with run id ${runId}. List the queue with threads queue list.`, {
      exitCode: 3,
      details: { threadId: projection.thread.id, runId },
    });
  }
  return run;
}

/** Plans one queue command: what to dispatch and how the projection shows it took effect. */
function planQueueChange(projection: T3ThreadProjection, change: QueueChange) {
  const threadId = projection.thread.id;
  const base = { commandId: randomUUID(), threadId };
  const stillQueued = (candidate: T3ThreadProjection, runId: string) => queuedRuns(candidate).some((run) => run.id === runId);
  switch (change.type) {
    case "edit": {
      const run = requireQueued(projection, change.runId);
      return {
        command: { type: "queued-run.edit", ...base, runId: run.id, text: change.text },
        applied: (candidate: T3ThreadProjection) => candidate.messages.some((message) => message.id === run.userMessageId && message.text === change.text),
      };
    }
    case "cancel":
      requireQueued(projection, change.runId);
      return {
        command: { type: "queued-run.cancel", ...base, runId: change.runId },
        applied: (candidate: T3ThreadProjection) => !stillQueued(candidate, change.runId),
      };
    case "move": {
      requireQueued(projection, change.runId);
      if (change.beforeRunId !== null) {
        if (change.beforeRunId === change.runId) throw usage("QUEUE_MOVE_INVALID", "A queued message cannot move before itself.");
        requireQueued(projection, change.beforeRunId);
      }
      return {
        command: { type: "queued-run.reorder", ...base, runId: change.runId, beforeRunId: change.beforeRunId },
        applied: (candidate: T3ThreadProjection) => {
          const order = queuedRuns(candidate).map((run) => run.id);
          const at = order.indexOf(change.runId);
          if (at < 0) return false;
          return change.beforeRunId === null ? at === order.length - 1 : order[at + 1] === change.beforeRunId;
        },
      };
    }
    case "promote": {
      requireQueued(projection, change.runId);
      const target = activeRun(projection);
      if (!target) {
        throw new CliError("THREAD_NOT_RUNNING", `Thread ${threadId} has no running turn to steer the queued message into.`, {
          exitCode: 4,
          details: { threadId, runId: change.runId },
        });
      }
      return {
        command: { type: "queued-message.promote-to-steer", ...base, queuedRunId: change.runId, targetRunId: target.id },
        applied: (candidate: T3ThreadProjection) => !stillQueued(candidate, change.runId),
      };
    }
    case "resume":
      if (!queuedRuns(projection).some((run) => run.queueHeld === true)) {
        throw new CliError("QUEUE_NOT_HELD", `Thread ${threadId} has no held queue to resume.`, {
          exitCode: 4,
          details: { threadId, queuedRuns: queuedRuns(projection).length },
        });
      }
      return {
        command: { type: "queue.resume", ...base },
        applied: (candidate: T3ThreadProjection) => !queuedRuns(candidate).some((run) => run.queueHeld === true),
      };
  }
}

export async function changeQueue(config: CliConfig, rawThreadId: string, change: QueueChange) {
  const threadId = requireThreadId(rawThreadId);
  if (change.type === "edit" && !change.text.trim()) {
    throw usage("PROMPT_REQUIRED", "A queued message cannot be edited to an empty message.");
  }
  const normalized = change.type === "edit" ? { ...change, text: change.text.trim() } : change;
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    const read = await adapter.inspect(threadId);
    const thread = requireLiveThread(read);
    const plan = planQueueChange(read.projection, normalized);
    const { dispatch, projection } = await dispatchVerified(adapter, threadId, plan.command, plan.applied, {
      code: "QUEUE_CHANGE_NOT_VERIFIED",
      message: `T3 accepted ${plan.command.type}, but thread ${threadId} does not show the change.`,
    });
    return {
      ...connection(runtime, invocation),
      thread: threadRef(thread),
      change: normalized,
      command: plan.command,
      dispatch,
      activeRunId: activeRun(projection)?.id ?? null,
      queue: queueEntries(projection),
    };
  });
}

// Organization: pin, snooze, archive, rename

export type OrganizeAction =
  | { type: "pin" }
  | { type: "unpin" }
  | { type: "snooze"; until: string }
  | { type: "unsnooze" }
  | { type: "archive" }
  | { type: "unarchive" }
  | { type: "rename"; title: string };

/** Turns an ISO time or a duration from now, such as 2h, into a future ISO time. */
export function snoozeTime(raw: string, now = Date.now()): string {
  const duration = parseDuration(raw);
  const at = duration === null ? Date.parse(raw.trim()) : now + duration;
  if (!Number.isFinite(at)) {
    throw usage("INVALID_SNOOZE_TIME", `Write --until as an ISO time or a duration such as 30m, 2h, or 1d, not ${raw}.`);
  }
  if (at <= now) throw usage("INVALID_SNOOZE_TIME", `The snooze time ${new Date(at).toISOString()} is not in the future.`);
  return new Date(at).toISOString();
}

function organizePlan(threadId: string, action: OrganizeAction) {
  const base = { commandId: randomUUID(), threadId };
  switch (action.type) {
    case "pin":
      return { command: { type: "thread.pin", ...base }, field: "pinnedAt", applied: (thread: T3AppThread) => thread.pinnedAt != null };
    case "unpin":
      return { command: { type: "thread.unpin", ...base }, field: "pinnedAt", applied: (thread: T3AppThread) => thread.pinnedAt == null };
    case "snooze":
      return {
        command: { type: "thread.snooze", ...base, snoozedUntil: action.until },
        field: "snoozedUntil",
        applied: (thread: T3AppThread) => thread.snoozedUntil != null && Date.parse(thread.snoozedUntil) === Date.parse(action.until),
      };
    case "unsnooze":
      return {
        command: { type: "thread.unsnooze", ...base, reason: "user" },
        field: "snoozedUntil",
        applied: (thread: T3AppThread) => thread.snoozedUntil == null,
      };
    case "archive":
      return { command: { type: "thread.archive", ...base }, field: "archivedAt", applied: (thread: T3AppThread) => thread.archivedAt != null };
    case "unarchive":
      return { command: { type: "thread.unarchive", ...base }, field: "archivedAt", applied: (thread: T3AppThread) => thread.archivedAt == null };
    case "rename":
      return {
        command: { type: "thread.metadata.update", ...base, title: action.title },
        field: "title",
        applied: (thread: T3AppThread) => thread.title === action.title,
      };
  }
}

export async function organizeThread(config: CliConfig, rawThreadId: string, action: OrganizeAction) {
  const threadId = requireThreadId(rawThreadId);
  const normalized = action.type === "rename" ? { ...action, title: action.title.trim() } : action;
  if (normalized.type === "rename" && !normalized.title) throw usage("TITLE_REQUIRED", "--title needs a non-empty title.");
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const adapter = new T3ThreadApi(api);
    const thread = requireLiveThread(await adapter.inspect(threadId));
    const plan = organizePlan(threadId, normalized);
    const { dispatch, projection } = await dispatchVerified(adapter, threadId, plan.command, (candidate) => plan.applied(candidate.thread), {
      code: "THREAD_CHANGE_NOT_VERIFIED",
      message: `T3 accepted ${plan.command.type}, but thread ${threadId} does not show the change.`,
    });
    return {
      ...connection(runtime, invocation),
      project: await projectById(api, thread.projectId),
      thread: threadRef(projection.thread),
      action: normalized.type,
      change: { field: plan.field, before: thread[plan.field] ?? null, after: projection.thread[plan.field] ?? null },
      command: plan.command,
      dispatch,
    };
  });
}

// Search

/** One hit of T3's thread search: a message snippet from a user or assistant message. */
export interface SearchMatch {
  threadId: string;
  projectId: string;
  /** `user` or `assistant`: who wrote the matching message. */
  source: string;
  snippet: string;
  messageCreatedAt: string | null;
}

export async function searchThreads(config: CliConfig, options: { query: string; limit?: number }) {
  const query = options.query.trim();
  if (query.length < SEARCH_QUERY_MIN || query.length > SEARCH_QUERY_MAX) {
    throw usage("SEARCH_QUERY_INVALID", `A search query needs ${SEARCH_QUERY_MIN} to ${SEARCH_QUERY_MAX} characters.`);
  }
  if (options.limit !== undefined && (options.limit < 1 || options.limit > SEARCH_LIMIT_MAX)) {
    throw usage("SEARCH_LIMIT_INVALID", `--limit must be between 1 and ${SEARCH_LIMIT_MAX}.`);
  }
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const result = record(await api.rpc("orchestration.searchThreads", { query, ...(options.limit === undefined ? {} : { limit: options.limit }) }));
    if (!result || !Array.isArray(result.matches)) throw new CliError("T3_INVALID_RESPONSE", "T3 returned a search result without matches.");
    const shell = await api.shellSnapshot();
    const threads = new Map([...shell.threads, ...shell.archivedThreads].map((thread) => [thread.id, thread]));
    const projects = new Map(shell.projects.map((project) => [project.id, project]));
    const matches = (result.matches as SearchMatch[]).map((match) => {
      const thread = threads.get(match.threadId);
      return {
        ...match,
        threadTitle: thread?.title ?? null,
        projectTitle: projects.get(match.projectId)?.title ?? null,
        archived: thread ? thread.archivedAt != null : null,
      };
    });
    return { ...connection(runtime, invocation), query, limit: options.limit ?? null, matches };
  });
}

// Scheduled tasks

export type TaskSchedule = { type: "interval"; everyMs: number } | { type: "fixed_time"; timeOfDay: string; weekdays?: number[] };
type WorkspaceStrategy = { type: "root" } | { type: "worktree"; baseRef: string } | { type: string; [key: string]: unknown };

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: TaskSchedule;
  projectId: string;
  threadId: string | null;
  workspaceStrategy: WorkspaceStrategy;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  createdBy: string;
  creationSource: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string;
  lastRunError: string | null;
  runCount: number;
  [key: string]: unknown;
}

export interface ScheduleOptions {
  title?: string;
  prompt?: string;
  every?: string;
  at?: string;
  days?: string;
  cwd?: string;
  project?: string;
  thread?: string;
  checkout?: "current" | "worktree";
  provider?: string;
  model?: string;
  thinkingEffort?: string;
  speedMode?: SpeedMode;
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode;
  disabled?: boolean;
}

function parseTimeOfDay(raw: string): string {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/u.exec(raw.trim());
  if (!match) throw usage("INVALID_SCHEDULE", `Write --at as a 24-hour time such as 09:30, not ${raw}.`);
  return `${match[1]!.padStart(2, "0")}:${match[2]}`;
}

function parseDays(raw: string): number[] {
  const days = new Set<number>();
  for (const word of raw.toLowerCase().split(/[\s,]+/u).filter(Boolean)) {
    if (word === "daily") return [];
    if (word === "weekdays") [1, 2, 3, 4, 5].forEach((day) => days.add(day));
    else if (word === "weekends") [0, 6].forEach((day) => days.add(day));
    else {
      const day = WEEKDAYS.indexOf(word as (typeof WEEKDAYS)[number]);
      const full = FULL_WEEKDAYS.indexOf(word);
      if (day < 0 && full < 0) {
        throw usage("INVALID_SCHEDULE", `Unknown day ${word}. Use mon, tue, wed, thu, fri, sat, sun, weekdays, weekends, or daily.`);
      }
      days.add(day >= 0 ? day : full);
    }
  }
  const sorted = [...days].sort((left, right) => left - right);
  // T3 treats no weekdays and all seven alike: every day.
  return sorted.length === 7 ? [] : sorted;
}

/** The schedule the flags ask for, built on the current one for partial updates; null when the flags name none. */
export function scheduleFrom(options: Pick<ScheduleOptions, "every" | "at" | "days">, current: TaskSchedule | null): TaskSchedule | null {
  if (options.every !== undefined && (options.at !== undefined || options.days !== undefined)) {
    throw usage("SCHEDULE_CONFLICT", "Use either --every or --at with --days, not both.");
  }
  if (options.every !== undefined) {
    const everyMs = parseDuration(options.every);
    if (everyMs === null) throw usage("INVALID_SCHEDULE", `Write --every as a duration such as 30m, 2h, or 1d, not ${options.every}.`);
    if (everyMs < MIN_SCHEDULE_INTERVAL_MS) throw usage("INVALID_SCHEDULE", "T3 runs scheduled tasks at most once a minute; use --every 1m or more.");
    return { type: "interval", everyMs };
  }
  if (options.at === undefined && options.days === undefined) return null;
  const fixed = current?.type === "fixed_time" ? current : null;
  const timeOfDay = options.at === undefined ? fixed?.timeOfDay : parseTimeOfDay(options.at);
  if (!timeOfDay) throw usage("INVALID_SCHEDULE", "--days needs --at to say when the task runs.");
  const weekdays = options.days === undefined ? (fixed?.weekdays ?? []) : parseDays(options.days);
  return { type: "fixed_time", timeOfDay, ...(weekdays.length > 0 ? { weekdays } : {}) };
}

export function describeSchedule(schedule: TaskSchedule): string {
  if (schedule.type === "interval") return `every ${formatDuration(schedule.everyMs)}`;
  const days = schedule.weekdays ?? [];
  const label =
    days.length === 0 ? "daily" : days.join(",") === "1,2,3,4,5" ? "weekdays" : days.map((day) => WEEKDAYS[day] ?? String(day)).join(",");
  return `at ${schedule.timeOfDay} ${label}`;
}

/** Calls a scheduled-task RPC and names the failure when T3 rejects it. */
async function scheduleRpc(api: T3Api, tag: string, payload: unknown, timeoutMs?: number): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await api.rpc(tag, payload, timeoutMs);
  } catch (cause) {
    if (!(cause instanceof CliError) || cause.code !== "T3_RPC_FAILED") throw cause;
    throw new CliError("SCHEDULE_REJECTED", `T3 rejected ${tag}: ${cause.message}`, { exitCode: 4, cause, details: { rpc: tag } });
  }
  const result = record(value);
  if (!result) throw new CliError("T3_INVALID_RESPONSE", `T3 returned an invalid ${tag} result.`);
  return result;
}

function taskOf(result: Record<string, unknown>, tag: string): ScheduledTask {
  const task = record(result.task);
  if (typeof task?.id !== "string") throw new CliError("T3_INVALID_RESPONSE", `T3 returned no scheduled task for ${tag}.`);
  return task as ScheduledTask;
}

async function listTasks(api: T3Api): Promise<ScheduledTask[]> {
  const result = await scheduleRpc(api, "scheduledTasks.list", {});
  if (!Array.isArray(result.tasks)) throw new CliError("T3_INVALID_RESPONSE", "T3 returned a scheduled task list without tasks.");
  return result.tasks as ScheduledTask[];
}

async function findTask(api: T3Api, rawTaskId: string): Promise<ScheduledTask> {
  const taskId = rawTaskId.trim();
  if (!taskId) throw usage("SCHEDULE_ID_REQUIRED", "A non-empty scheduled task id is required.");
  const task = (await listTasks(api)).find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new CliError("SCHEDULE_NOT_FOUND", `No scheduled task exists with id ${taskId}. List them with schedules list.`, {
      exitCode: 3,
      details: { taskId },
    });
  }
  return task;
}

const TASK_VERIFY_TIMEOUT_MS = 5_000;

/** The fields a saved task must show, so a save that T3 acknowledged but did not keep is caught. */
function savedFields(task: Record<string, unknown>) {
  const model = record(task.modelSelection);
  return {
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    schedule: task.schedule,
    projectId: task.projectId,
    threadId: task.threadId ?? null,
    workspaceStrategy: task.workspaceStrategy,
    modelSelection: {
      instanceId: model?.instanceId,
      model: model?.model,
      // Keyed by id, so the comparison does not depend on the order T3 stores them in.
      options: Object.fromEntries(normalizeProviderOptions(model?.options).map((option) => [option.id, option.value])),
    },
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
  };
}

/** True when every value in `expected` appears in `actual`; T3 may add fields of its own. */
function includes(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  const want = record(expected);
  if (!want) {
    return Array.isArray(expected)
      ? Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => includes(actual[index], value))
      : actual === expected;
  }
  const have = record(actual);
  return have !== null && Object.entries(want).every(([key, value]) => includes(have[key], value));
}

/** Lists the tasks until `check` accepts the task, because a scheduled-task RPC result is only an acknowledgement. */
async function verifyTask(
  api: T3Api,
  taskId: string,
  check: (task: ScheduledTask) => boolean,
  failure: string,
): Promise<ScheduledTask> {
  const deadline = Date.now() + TASK_VERIFY_TIMEOUT_MS;
  for (;;) {
    const task = (await listTasks(api)).find((candidate) => candidate.id === taskId);
    if (task && check(task)) return task;
    if (Date.now() >= deadline) {
      throw new CliError("SCHEDULE_NOT_VERIFIED", failure, { exitCode: 5, details: { taskId, listed: task !== undefined } });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function projectNotFound(message: string): CliError {
  return new CliError("PROJECT_NOT_FOUND", message, { exitCode: 3 });
}

function checkProjectFlags(options: Pick<ScheduleOptions, "cwd" | "project">): void {
  if (options.project !== undefined && options.cwd !== undefined) {
    throw usage("PROJECT_FILTER_CONFLICT", "Use either --project or --cwd, not both.");
  }
}

/**
 * Finds a folder's project the way `projects resolve` does, but inside the open session: a second
 * runtime discovery would cost another session and, on Windows, can crash Node as the command exits.
 */
async function projectForFolder(api: T3Api, config: CliConfig, cwd: string | undefined) {
  const workspace = await resolveWorkspace(cwd || process.cwd(), config.workspaceMode);
  const projects = (readLocalProjects(api.runtime) ?? (await api.projects())).filter((project) => project.deletedAt == null);
  // An exact project wins; a linked worktree otherwise belongs to its main checkout's project.
  const at = (root: string | null) => (root ? (projects.find((project) => pathsEqual(project.workspaceRoot, root)) ?? null) : null);
  const project = at(workspace.workspaceRoot) ?? at(workspace.mainWorktreeRoot);
  if (!project) throw projectNotFound(`No T3 Code project exists for ${workspace.mainWorktreeRoot ?? workspace.workspaceRoot}.`);
  return { project, branch: workspace.branch };
}

async function projectWithId(api: T3Api, projectId: string): Promise<T3Project> {
  const project = (await api.projects()).find((candidate) => candidate.id === projectId.trim());
  if (!project) throw projectNotFound(`No active T3 Code project exists with id ${projectId}.`);
  return project;
}

async function boundThread(api: T3Api, rawThreadId: string): Promise<T3AppThread> {
  const thread = requireLiveThread(await new T3ThreadApi(api).inspect(requireThreadId(rawThreadId)));
  if (thread.archivedAt != null) {
    throw new CliError("THREAD_ARCHIVED", `Thread ${thread.id} is archived, so a scheduled task cannot send to it.`, {
      exitCode: 4,
      details: { threadId: thread.id },
    });
  }
  return thread;
}

/** T3's own default model, from its catalog: the Codex default, else the first enabled provider's. */
async function catalogDefaultModel(api: T3Api): Promise<ModelSelection> {
  const catalog = await fetchCatalog(api).catch(() => null);
  const providers = (catalog?.providers ?? []).filter((provider) => provider.enabled && provider.models.length > 0);
  const provider = providers.find((candidate) => candidate.instanceId === "codex") ?? providers[0];
  const model = provider?.models.find((candidate) => candidate.isDefault) ?? provider?.models[0];
  return provider && model ? { instanceId: provider.instanceId, model: model.slug } : FALLBACK_MODEL_SELECTION;
}

function modelOverrides(options: ScheduleOptions, defaults: Partial<CliConfig> = {}): ModelOverrides {
  return {
    provider: options.provider ?? defaults.provider,
    model: options.model ?? defaults.model,
    speedMode: options.speedMode ?? defaults.speedMode,
    thinkingEffort: options.thinkingEffort ?? defaults.thinkingEffort,
  };
}

function hasModelOverride(overrides: ModelOverrides): boolean {
  return [overrides.provider, overrides.model, overrides.speedMode, overrides.thinkingEffort].some((value) => value !== undefined);
}

/**
 * Applies model flags to a schedule's base selection. A bad model would only fail when the task runs
 * unattended, so the flags are checked against T3's catalog when it has one.
 */
async function scheduleModel(api: T3Api, base: ModelSelection, overrides: ModelOverrides): Promise<ModelSelection> {
  if (!hasModelOverride(overrides)) return base;
  const catalog = await fetchCatalog(api).catch(() => null);
  if (catalog) return resolveModelChange(base, overrides, catalog);
  const provider = overrides.provider?.trim();
  if (provider && provider !== base.instanceId && !overrides.model?.trim()) {
    throw usage("MODEL_REQUIRED_FOR_PROVIDER", `Provider instance ${provider} differs from ${base.instanceId}; select its model with --model.`, {
      provider,
      currentProvider: base.instanceId,
    });
  }
  return applyModelOverrides(base, overrides, "project default");
}

async function workspaceStrategyFor(
  options: Pick<ScheduleOptions, "checkout">,
  threadBound: boolean,
  branch: () => Promise<string | null>,
): Promise<WorkspaceStrategy> {
  if (threadBound) {
    if (options.checkout === "worktree") {
      throw usage("SCHEDULE_CHECKOUT_CONFLICT", "A task bound to a thread runs in that thread's checkout; drop --checkout worktree or --thread.");
    }
    return { type: "root" };
  }
  if (options.checkout !== "worktree") return { type: "root" };
  const baseRef = await branch();
  if (!baseRef) {
    throw usage("WORKTREE_REQUIRES_BRANCH", "A worktree schedule needs a Git repository with a current branch to start from.");
  }
  return { type: "worktree", baseRef };
}

async function branchOf(workspaceRoot: string): Promise<string | null> {
  return (await resolveWorkspace(workspaceRoot, "folder").catch(() => null))?.branch ?? null;
}

function requiredText(value: string | undefined, code: string, message: string): string {
  const text = value?.trim();
  if (!text) throw usage(code, message);
  return text;
}

export async function listSchedules(config: CliConfig, options: Pick<ScheduleOptions, "cwd" | "project"> = {}) {
  checkProjectFlags(options);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const project =
      options.cwd !== undefined
        ? (await projectForFolder(api, config, options.cwd)).project
        : options.project === undefined
          ? null
          : await projectWithId(api, options.project);
    const tasks = (await listTasks(api)).filter((task) => project === null || task.projectId === project.id);
    const projects = new Map((await api.projects().catch(() => [])).map((candidate) => [candidate.id, candidate.title]));
    return {
      ...connection(runtime, invocation),
      filter: { projectId: project?.id ?? null },
      tasks: tasks.map((task) => ({ ...task, projectTitle: projects.get(task.projectId) ?? null })),
    };
  });
}

export async function createSchedule(config: CliConfig, options: ScheduleOptions) {
  const title = requiredText(options.title, "TITLE_REQUIRED", "--title needs a non-empty title.");
  const prompt = requiredText(options.prompt, "PROMPT_REQUIRED", "A scheduled task needs a non-empty prompt.");
  const schedule = scheduleFrom(options, null);
  if (!schedule) throw usage("SCHEDULE_REQUIRED", "Say when the task runs with --every <duration> or --at <HH:MM>.");
  checkProjectFlags(options);
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const thread = options.thread === undefined ? null : await boundThread(api, options.thread);
    // Without --thread, the folder names the project; with it, the thread does unless a flag says otherwise.
    const located =
      options.project === undefined && (options.cwd !== undefined || thread === null) ? await projectForFolder(api, config, options.cwd) : null;
    const project = located?.project ?? (await projectWithId(api, options.project ?? thread!.projectId));
    if (thread && thread.projectId !== project.id) {
      throw usage("SCHEDULE_THREAD_PROJECT_MISMATCH", `Thread ${thread.id} belongs to another project than ${project.title}.`, {
        threadId: thread.id,
        threadProjectId: thread.projectId,
        projectId: project.id,
      });
    }
    // A bound task keeps the thread's model; a task that starts new threads picks one like a handover.
    const base = thread?.modelSelection ?? project.defaultModelSelection ?? (await catalogDefaultModel(api));
    const modelSelection = await scheduleModel(api, base, modelOverrides(options, thread ? {} : config));
    const workspaceStrategy = await workspaceStrategyFor(options, thread !== null, async () =>
      located ? located.branch : await branchOf(project.workspaceRoot),
    );
    const input = {
      title,
      prompt,
      enabled: options.disabled !== true,
      schedule,
      projectId: project.id,
      threadId: thread?.id ?? null,
      workspaceStrategy,
      modelSelection,
      runtimeMode: options.runtimeMode ?? config.runtimeMode,
      interactionMode: options.interactionMode ?? config.interactionMode,
      ...createdBy(),
    };
    const saved = taskOf(await scheduleRpc(api, "scheduledTasks.upsert", input), "scheduledTasks.upsert");
    const expected = savedFields(input);
    const task = await verifyTask(api, saved.id, (candidate) => includes(savedFields(candidate), expected), `T3 did not list scheduled task ${saved.id} as it was saved.`);
    return { ...connection(runtime, invocation), project, thread: thread ? threadRef(thread) : null, task };
  });
}

export async function updateSchedule(config: CliConfig, taskId: string, options: ScheduleOptions) {
  const title = options.title === undefined ? undefined : requiredText(options.title, "TITLE_REQUIRED", "--title needs a non-empty title.");
  const prompt = options.prompt === undefined ? undefined : requiredText(options.prompt, "PROMPT_REQUIRED", "A scheduled task needs a non-empty prompt.");
  const overrides = modelOverrides(options);
  const changes = [
    title, prompt, options.every, options.at, options.days, options.cwd, options.project, options.thread,
    options.checkout, options.runtimeMode, options.interactionMode, options.disabled ? true : undefined,
  ];
  if (changes.every((value) => value === undefined) && !hasModelOverride(overrides)) {
    throw usage("SCHEDULE_CHANGE_REQUIRED", "Name at least one setting to change.");
  }
  checkProjectFlags(options);
  // Checks the schedule flags before connecting; --days alone is valid against a fixed-time task.
  scheduleFrom(options, { type: "fixed_time", timeOfDay: "00:00" });
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const task = await findTask(api, taskId);
    const located = options.cwd === undefined ? null : await projectForFolder(api, config, options.cwd);
    const thread = options.thread === undefined ? null : await boundThread(api, options.thread);
    const project =
      located?.project ??
      (options.project !== undefined ? await projectWithId(api, options.project) : await projectWithId(api, thread?.projectId ?? task.projectId));
    const threadId = thread?.id ?? task.threadId;
    const threadProjectId = thread?.projectId ?? (task.threadId ? task.projectId : null);
    if (threadProjectId !== null && threadProjectId !== project.id) {
      throw usage("SCHEDULE_THREAD_PROJECT_MISMATCH", `Thread ${threadId} belongs to another project than ${project.title}.`, {
        threadId,
        threadProjectId,
        projectId: project.id,
      });
    }
    const schedule = scheduleFrom(options, task.schedule) ?? task.schedule;
    const workspaceStrategy =
      options.checkout === undefined && options.thread === undefined
        ? task.workspaceStrategy
        : await workspaceStrategyFor(options, threadId !== null, async () => (located ? located.branch : await branchOf(project.workspaceRoot)));
    const input = {
      id: task.id,
      requireExisting: true,
      title: title ?? task.title,
      prompt: prompt ?? task.prompt,
      enabled: options.disabled ? false : task.enabled,
      schedule,
      projectId: project.id,
      threadId,
      workspaceStrategy,
      modelSelection: await scheduleModel(api, task.modelSelection, overrides),
      runtimeMode: options.runtimeMode ?? task.runtimeMode,
      interactionMode: options.interactionMode ?? task.interactionMode,
      // T3 overwrites the creation source on every save, so keep the original.
      creationSource: task.creationSource,
    };
    taskOf(await scheduleRpc(api, "scheduledTasks.upsert", input), "scheduledTasks.upsert");
    const expected = savedFields(input);
    const updated = await verifyTask(api, task.id, (candidate) => includes(savedFields(candidate), expected), `T3 did not list scheduled task ${task.id} with the changes.`);
    return { ...connection(runtime, invocation), project, before: task, task: updated };
  });
}

export async function setScheduleEnabled(config: CliConfig, taskId: string, enabled: boolean) {
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const before = await findTask(api, taskId);
    taskOf(await scheduleRpc(api, "scheduledTasks.setEnabled", { id: before.id, enabled }), "scheduledTasks.setEnabled");
    const task = await verifyTask(
      api,
      before.id,
      (candidate) => candidate.enabled === enabled,
      `T3 did not list scheduled task ${before.id} as ${enabled ? "enabled" : "disabled"}.`,
    );
    return { ...connection(runtime, invocation), changed: before.enabled !== enabled, task };
  });
}

export async function deleteSchedule(config: CliConfig, taskId: string) {
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const task = await findTask(api, taskId);
    // T3 reports success for an unknown id too, so the list confirms the deletion.
    await scheduleRpc(api, "scheduledTasks.delete", { id: task.id });
    if ((await listTasks(api)).some((candidate) => candidate.id === task.id)) {
      throw new CliError("SCHEDULE_NOT_VERIFIED", `T3 still lists scheduled task ${task.id} after deleting it.`, {
        exitCode: 5,
        details: { taskId: task.id },
      });
    }
    return { ...connection(runtime, invocation), deleted: true, task };
  });
}

export async function runSchedule(config: CliConfig, taskId: string) {
  const runtime = await discoverRuntime(config, { startDesktopIfNeeded: true });
  return await withT3Api(runtime, config, async (api, invocation) => {
    const before = await findTask(api, taskId);
    const returned = taskOf(await scheduleRpc(api, "scheduledTasks.runNow", { id: before.id }, SCHEDULE_RUN_TIMEOUT_MS), "scheduledTasks.runNow");
    const failed = (task: ScheduledTask) =>
      new CliError("SCHEDULE_RUN_FAILED", `Scheduled task ${task.id} could not start: ${task.lastRunError ?? "T3 gave no reason."}`, {
        exitCode: 4,
        details: { taskId: task.id, lastRunError: task.lastRunError, runCount: task.runCount },
      });
    if (returned.lastRunStatus === "failed") throw failed(returned);
    // T3 records every manual run, so the list confirms it.
    const task = await verifyTask(
      api,
      before.id,
      (candidate) => candidate.runCount > before.runCount || (candidate.lastRunAt ?? null) !== (before.lastRunAt ?? null),
      `T3 did not record a run of scheduled task ${before.id}.`,
    );
    if (task.lastRunStatus === "failed") throw failed(task);
    return { ...connection(runtime, invocation), task };
  });
}
