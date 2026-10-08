import { randomUUID } from "node:crypto";

import type { T3Api } from "./api.js";
import { CliError } from "./errors.js";
import { activeRun, buildTranscript, isActiveRun, pendingRequests, queuedRuns } from "./transcript.js";
import { TERMINAL_RUN_STATUSES, type T3Run, type T3ThreadProjection } from "./types.js";

const DEFAULT_VERIFICATION_TIMEOUT_MS = 10_000;
const DEFAULT_VERIFICATION_INTERVAL_MS = 150;
const DEFAULT_WAIT_INTERVAL_MS = 2_000;
/** Some providers need a few seconds to stop a turn, and a session restart takes a few more. */
const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;

/**
 * How the awaited run ended. `ended` covers a rolled-back run; `queue-held` means the message waits
 * in a queue that T3 holds after a restart until someone resumes it.
 */
export type TurnWaitOutcome = "completed" | "interrupted" | "error" | "ended" | "needs-attention" | "queue-held" | "idle";

export interface TurnWaitResult {
  outcome: TurnWaitOutcome;
  snapshotSequence: number;
  projection: T3ThreadProjection;
  /** The awaited run's 1-based position among the thread's turns; null when the thread has no turns. */
  turnIndex: number | null;
  runId: string | null;
  waitedMs: number;
  /** Why the provider could not run the turn. */
  error?: string;
}

export interface ThreadRead {
  snapshotSequence: number;
  projection: T3ThreadProjection;
}

interface T3ThreadApiOptions {
  verificationTimeoutMs?: number;
  verificationIntervalMs?: number;
  waitIntervalMs?: number;
  /** How long to wait for an interrupt or a settings change to show. */
  controlTimeoutMs?: number;
}

export function createdBy(): { createdBy: "user"; creationSource: "web" } {
  // T3 records client commands as the user's; it has no source value for a CLI.
  return { createdBy: "user", creationSource: "web" };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Resolves null once the deadline passes, so one slow request cannot outlast a wait's timeout. */
async function beforeDeadline<T>(request: Promise<T>, deadline: number): Promise<T | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), remaining);
  });
  try {
    return await Promise.race([request, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function runById(projection: T3ThreadProjection, runId: string): T3Run | null {
  return projection.runs.find((run) => run.id === runId) ?? null;
}

/** The run that handles a message: the one it started, or the active run it was steered into. */
export function runForMessage(projection: T3ThreadProjection, messageId: string): T3Run | null {
  const started = projection.runs.find((run) => run.userMessageId === messageId);
  if (started) return started;
  const message = projection.messages.find((candidate) => candidate.id === messageId);
  return message?.runId ? runById(projection, message.runId) : null;
}

/** Why a failed run failed, from its error item. */
function runError(projection: T3ThreadProjection, run: T3Run): string {
  const item = projection.turnItems.findLast((candidate) => candidate.type === "error" && candidate.runId === run.id);
  const failure = item?.failure as { message?: unknown } | undefined;
  return typeof failure?.message === "string" ? failure.message : "The provider could not complete the turn.";
}

function outcomeOf(run: T3Run): TurnWaitOutcome {
  switch (run.status) {
    case "completed":
      return "completed";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "failed":
      return "error";
    default:
      return "ended";
  }
}

interface RunObservation {
  outcome: TurnWaitOutcome;
  run: T3Run | null;
  error?: string;
}

/**
 * Returns how the awaited run ended, or null while it is still queued or working. With a message id,
 * the awaited run is the one that handles that message; otherwise it is whatever the thread is doing.
 */
export function observeRun(projection: T3ThreadProjection, messageId?: string): RunObservation | null {
  const requests = pendingRequests(projection);
  let run: T3Run | null;
  if (messageId !== undefined) {
    run = runForMessage(projection, messageId);
    if (!run) return null;
  } else {
    const queued = queuedRuns(projection);
    run = activeRun(projection) ?? queued[0] ?? projection.runs.reduce<T3Run | null>(
      (latest, candidate) => (latest === null || candidate.ordinal > latest.ordinal ? candidate : latest),
      null,
    );
    if (!run) return { outcome: "idle", run: null };
  }
  // A request on the awaited run, or one that holds up the live session the awaited run works or waits behind,
  // needs a person before the run can finish.
  const heldUp = isActiveRun(run) || run.status === "queued";
  if (requests.some((request) => request.turnId === run.id || (request.blocking && heldUp))) {
    return { outcome: "needs-attention", run };
  }
  if (run.status === "queued") return run.queueHeld ? { outcome: "queue-held", run } : null;
  if (!TERMINAL_RUN_STATUSES.includes(run.status)) return null;
  const outcome = outcomeOf(run);
  return outcome === "error" ? { outcome, run, error: runError(projection, run) } : { outcome, run };
}

export class T3ThreadApi {
  private readonly verificationTimeoutMs: number;
  private readonly verificationIntervalMs: number;
  private readonly waitIntervalMs: number;
  readonly controlTimeoutMs: number;

  constructor(
    readonly api: T3Api,
    options: T3ThreadApiOptions = {},
  ) {
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
    this.verificationIntervalMs = options.verificationIntervalMs ?? DEFAULT_VERIFICATION_INTERVAL_MS;
    this.waitIntervalMs = options.waitIntervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
    this.controlTimeoutMs = options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  }

  /** The whole thread, so callers can number turns and find the original request. */
  async read(threadId: string): Promise<ThreadRead> {
    return await this.api.threadDetail(threadId);
  }

  /** A recent window of the thread. Runs and runtime requests are always complete. */
  async inspect(threadId: string): Promise<ThreadRead> {
    return await this.api.threadDetail(threadId, { bounded: true });
  }

  /** Dispatches a command and names it when T3 rejects it. */
  async dispatch(command: { type: string; commandId?: string; threadId?: string; [key: string]: unknown }): Promise<{ sequence: number }> {
    const full = { ...command, commandId: command.commandId ?? randomUUID() };
    try {
      return await this.api.dispatchCommand(full);
    } catch (cause) {
      if (!(cause instanceof CliError) || cause.code !== "T3_RPC_FAILED") throw cause;
      throw new CliError(
        "THREAD_COMMAND_REJECTED",
        `T3 rejected ${command.type}${command.threadId ? ` for thread ${command.threadId}` : ""}: ${cause.message}`,
        { exitCode: 4, cause, details: {
          type: command.type,
          ...(command.threadId ? { threadId: command.threadId } : {}),
          ...(cause.details !== null && typeof cause.details === "object" ? cause.details : {}),
        } },
      );
    }
  }

  /** Reads the thread until `check` returns a value; returns null with the last projection on timeout. */
  async poll<T>(
    threadId: string,
    check: (projection: T3ThreadProjection) => T | null,
    timeoutMs = this.verificationTimeoutMs,
  ): Promise<{ value: T | null; projection: T3ThreadProjection | null }> {
    const deadline = Date.now() + timeoutMs;
    let last: T3ThreadProjection | null = null;
    do {
      const read = await beforeDeadline(this.inspect(threadId).catch(() => null), deadline);
      if (read) {
        last = read.projection;
        const value = check(read.projection);
        if (value !== null) return { value, projection: read.projection };
      }
      await sleep(this.verificationIntervalMs);
    } while (Date.now() < deadline);
    return { value: null, projection: last };
  }

  /** Confirms that T3 recorded a message it accepted. */
  async verifyMessage(threadId: string, messageId: string, sequence: number) {
    const seen = await this.poll(threadId, (projection) =>
      projection.messages.some((message) => message.id === messageId) || runForMessage(projection, messageId) ? projection : null,
    );
    if (!seen.value) {
      throw new CliError("THREAD_TURN_NOT_VERIFIED", `T3 did not record message ${messageId} on thread ${threadId}.`, {
        exitCode: 5,
        details: { threadId, messageId, dispatchSequence: sequence },
      });
    }
    const run = runForMessage(seen.value, messageId);
    return {
      accepted: true as const,
      method: "message-id" as const,
      messageId,
      dispatchSequence: sequence,
      runId: run?.id ?? null,
      runStatus: run?.status ?? null,
    };
  }

  /**
   * Polls until the awaited run finishes or the thread needs a person. T3 owns run state, so one
   * observation is final; polls read a bounded window and the reply comes from one whole read.
   */
  async waitForTurn(threadId: string, options: { messageId?: string; timeoutMs: number }): Promise<TurnWaitResult> {
    const startedAt = Date.now();
    const deadline = startedAt + options.timeoutMs;
    let last: T3ThreadProjection | null = null;
    for (;;) {
      const read = await beforeDeadline(
        this.inspect(threadId).catch((error: unknown) => {
          if (error instanceof CliError && error.code === "THREAD_NOT_FOUND") throw error;
          return null;
        }),
        deadline,
      );
      if (read) {
        last = read.projection;
        if (read.projection.thread.deletedAt != null) {
          throw new CliError("THREAD_NOT_FOUND", `Thread ${threadId} was deleted while waiting.`, { exitCode: 3, details: { threadId } });
        }
        if (observeRun(read.projection, options.messageId)) {
          const whole = await beforeDeadline(this.read(threadId).catch(() => null), deadline);
          const final = whole ? observeRun(whole.projection, options.messageId) : null;
          if (whole && final) {
            const transcript = buildTranscript(whole.projection, { detail: "answers" });
            const turn = final.run ? transcript.turns.find((candidate) => candidate.turnId === final.run!.id) : undefined;
            return {
              outcome: final.outcome,
              snapshotSequence: whole.snapshotSequence,
              projection: whole.projection,
              turnIndex: turn?.index ?? null,
              runId: final.run?.id ?? null,
              waitedMs: Date.now() - startedAt,
              ...(final.error === undefined ? {} : { error: final.error }),
            };
          }
        }
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(this.waitIntervalMs, Math.max(0, deadline - Date.now())));
    }
    const active = last ? activeRun(last) : null;
    throw new CliError(
      "THREAD_WAIT_TIMEOUT",
      `Thread ${threadId} did not finish within ${Math.round(options.timeoutMs / 1000)} seconds.`,
      {
        exitCode: 6,
        details: {
          threadId,
          ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
          activeRunId: active?.id ?? null,
          activeRunStatus: active?.status ?? null,
          queuedRuns: last ? queuedRuns(last).length : null,
        },
      },
    );
  }
}
