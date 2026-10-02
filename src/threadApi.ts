import { randomUUID } from "node:crypto";

import { T3Api } from "./api.js";
import { CliError } from "./errors.js";
import { buildTranscript, pendingRequests, QUEUED_TURN_GRACE_MS } from "./transcript.js";
import type {
  InteractionMode,
  ModelSelection,
  OrchestrationSnapshot,
  RuntimeMode,
  T3Message,
  T3Project,
  T3Thread,
  ThreadDetailSnapshot,
} from "./types.js";

const DEFAULT_VERIFICATION_TIMEOUT_MS = 5_000;
const DEFAULT_VERIFICATION_INTERVAL_MS = 100;
const DEFAULT_WAIT_INTERVAL_MS = 2_000;
/** Claude needs up to three seconds to stop a turn, and a session restart takes a few more. */
const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;

export interface ThreadCatalog {
  snapshotSequence: number;
  projects: T3Project[];
  threads: T3Thread[];
  updatedAt: string;
}

export interface ExistingThreadTurnCommand {
  type: "thread.turn.start";
  commandId: string;
  threadId: string;
  message: {
    messageId: string;
    role: "user";
    text: string;
    attachments: [];
  };
  /**
   * T3 applies a thread's model, effort, and speed to a live session only through the turn, so every
   * turn carries the selection, as T3 Code's composer does.
   */
  modelSelection?: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  createdAt: string;
}

export interface ExistingThreadTurnVerification {
  accepted: true;
  method: "message-id";
  snapshotSequence: number;
  messageId: string;
}

export type ThreadSettlementState = "active" | "settled";

export type ThreadSettlementCommand =
  | {
      type: "thread.settle";
      commandId: string;
      threadId: string;
    }
  | {
      type: "thread.unsettle";
      commandId: string;
      threadId: string;
      reason: "user";
    };

export interface ThreadSettlementVerification {
  accepted: true;
  state: ThreadSettlementState;
  snapshotSequence: number;
  settledAt: string | null;
  unsettledAt: string | null;
}

export type TurnWaitOutcome = "completed" | "interrupted" | "error" | "needs-attention" | "idle";

export interface TurnWaitResult {
  outcome: TurnWaitOutcome;
  snapshotSequence: number;
  thread: T3Thread;
  /** The awaited turn's 1-based position in the whole thread; null when the thread has no turns. */
  turnIndex: number | null;
  waitedMs: number;
  /** Why the provider could not start the turn. */
  error?: string;
}

interface T3ThreadApiOptions {
  verificationTimeoutMs?: number;
  verificationIntervalMs?: number;
  waitIntervalMs?: number;
  queueGraceMs?: number;
  /** How long to wait for an interrupt or a session restart to show. */
  controlTimeoutMs?: number;
}

function asSnapshot(value: unknown): OrchestrationSnapshot {
  if (value === null || typeof value !== "object") {
    throw new CliError("T3_INVALID_SNAPSHOT", "T3 returned an invalid orchestration snapshot.");
  }
  const snapshot = value as Partial<OrchestrationSnapshot>;
  if (!Array.isArray(snapshot.projects) || !Array.isArray(snapshot.threads)) {
    throw new CliError("T3_INVALID_SNAPSHOT", "T3 returned a snapshot without projects or threads.");
  }
  return {
    snapshotSequence:
      typeof snapshot.snapshotSequence === "number" ? snapshot.snapshotSequence : 0,
    projects: snapshot.projects,
    threads: snapshot.threads,
    updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : "1970-01-01T00:00:00.000Z",
  };
}

function asThreadDetailSnapshot(value: unknown): ThreadDetailSnapshot | null {
  if (value === null || typeof value !== "object") return null;
  const snapshot = value as Partial<ThreadDetailSnapshot>;
  if (
    typeof snapshot.snapshotSequence !== "number" ||
    snapshot.thread === null ||
    typeof snapshot.thread !== "object" ||
    typeof snapshot.thread.id !== "string"
  ) {
    return null;
  }
  return snapshot as ThreadDetailSnapshot;
}

function activeThreads(snapshot: OrchestrationSnapshot): T3Thread[] {
  return snapshot.threads.filter((thread) => thread.deletedAt == null && thread.archivedAt == null);
}

function threadById(snapshot: OrchestrationSnapshot, threadId: string): T3Thread | null {
  return snapshot.threads.find((thread) => thread.id === threadId && thread.deletedAt == null) ?? null;
}

function requireTurnSettings(thread: T3Thread): {
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
} {
  const runtimeMode = thread.runtimeMode;
  const interactionMode = thread.interactionMode;
  if (
    !["approval-required", "auto", "auto-accept-edits", "full-access"].includes(runtimeMode ?? "") ||
    !["default", "plan"].includes(interactionMode ?? "")
  ) {
    throw new CliError(
      "T3_INVALID_THREAD",
      `T3 thread ${thread.id} is missing its runtime or interaction mode.`,
      { details: { threadId: thread.id } },
    );
  }
  return { runtimeMode: runtimeMode!, interactionMode: interactionMode! };
}

function dispatchSequence(value: unknown): number {
  if (value === null || typeof value !== "object") {
    throw new CliError("T3_INVALID_DISPATCH", "T3 returned an invalid dispatch result.");
  }
  const sequence = (value as { sequence?: unknown }).sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new CliError("T3_INVALID_DISPATCH", "T3 did not return a valid orchestration sequence.");
  }
  return sequence;
}

function messageWasProjected(messages: readonly T3Message[] | undefined, messageId: string): boolean {
  return messages?.some((message) => message.id === messageId && message.role === "user") ?? false;
}

function settlementWasProjected(
  thread: T3Thread,
  state: ThreadSettlementState,
  previousUpdatedAt: string | undefined,
): boolean {
  if (state === "settled") return thread.settledAt != null;
  if (thread.settledAt != null) return false;
  if (thread.settledOverride === "active") return true;
  return previousUpdatedAt !== undefined && (thread.updatedAt ?? "") > previousUpdatedAt;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface TurnObservation {
  outcome: TurnWaitOutcome;
  turnIndex: number | null;
  error?: string;
  /** The turn holds a message sent while it ran, which a queued turn may still claim. */
  mayBeQueued?: boolean;
  /** A request holds up the running turn, so nothing changes until a person answers. */
  blocked?: boolean;
}

/** T3 accepts a turn before the provider starts it; a start failure arrives later as an activity. */
function turnStartFailure(thread: T3Thread, messageId: string): string | null {
  const activities = Array.isArray(thread.activities) ? (thread.activities as Array<Record<string, unknown>>) : [];
  const failure = activities.find((activity) => {
    const payload = activity?.payload as Record<string, unknown> | undefined;
    return activity?.kind === "provider.turn.start.failed" && payload?.requestId === messageId;
  });
  if (!failure) return null;
  const detail = (failure.payload as Record<string, unknown>).detail;
  return typeof detail === "string" ? detail : "T3 could not start the turn.";
}

/**
 * Returns how the awaited turn ended, or null while it is still pending or running. With a message
 * id, the awaited turn is the one that handled that message; otherwise it is the latest turn.
 */
function observeTurn(thread: T3Thread, messageId: string | undefined): TurnObservation | null {
  const transcript = buildTranscript(thread, { detail: "answers" });
  const latest = transcript.turns.findLast((turn) => turn.turnId !== null) ?? null;
  if (messageId !== undefined) {
    const failure = turnStartFailure(thread, messageId);
    if (failure) return { outcome: "error", turnIndex: null, error: failure };
  }
  // A blocking approval or question holds up the running turn, whichever turn the caller awaits.
  const requests = pendingRequests(thread);
  if (requests.some((request) => request.blocking)) {
    return { outcome: "needs-attention", turnIndex: latest?.index ?? null, blocked: true };
  }
  let turn = latest;
  if (messageId !== undefined) {
    const owner = transcript.messages.find((message) => message.id === messageId);
    turn = owner ? (transcript.turns.find((candidate) => candidate.index === owner.turnIndex) ?? null) : null;
    if (turn?.turnId == null) return null;
  } else {
    const pendingTurn = transcript.turns.find((candidate) => candidate.turnId === null);
    if (pendingTurn) {
      // Queued messages will start another turn, unless the provider already refused every one of them.
      const failures = transcript.messages
        .filter((message) => message.turnIndex === pendingTurn.index && message.role === "user")
        .map((message) => turnStartFailure(thread, message.id));
      const latestFailure = failures.at(-1);
      if (latestFailure && failures.every((failure) => failure !== null)) {
        return { outcome: "error", turnIndex: null, error: latestFailure };
      }
      return null;
    }
  }
  // An awaited turn that a later turn followed has ended, even while that later turn runs.
  const session = thread.session?.status;
  const busy = thread.latestTurn?.state === "running" || session === "starting" || session === "running";
  if (busy && (messageId === undefined || thread.latestTurn?.turnId === turn?.turnId)) return null;
  if (!turn) return { outcome: "idle", turnIndex: null };
  // A turn that ended by asking a message-mode question waits for a person too.
  const askedBack = requests.some((request) => request.responseMode === "message" && request.turnId === turn.turnId);
  const outcome = askedBack
    ? "needs-attention"
    : turn.state === "interrupted" || turn.state === "error"
      ? turn.state
      : "completed";
  const turnStart = turn.startedAt;
  const mayBeQueued =
    turnStart !== null &&
    transcript.messages.some(
      (message) => message.turnIndex === turn.index && message.role === "user" && message.createdAt > turnStart,
    );
  return { outcome, turnIndex: turn.index, ...(mayBeQueued ? { mayBeQueued } : {}) };
}

export class T3ThreadApi {
  private readonly verificationTimeoutMs: number;
  private readonly verificationIntervalMs: number;

  private readonly waitIntervalMs: number;
  private readonly queueGraceMs: number;
  readonly controlTimeoutMs: number;

  constructor(
    private readonly api: T3Api,
    options: T3ThreadApiOptions = {},
  ) {
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
    this.verificationIntervalMs = options.verificationIntervalMs ?? DEFAULT_VERIFICATION_INTERVAL_MS;
    this.waitIntervalMs = options.waitIntervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
    this.queueGraceMs = options.queueGraceMs ?? QUEUED_TURN_GRACE_MS;
    this.controlTimeoutMs = options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  }

  /**
   * Polls until the awaited turn finishes or the thread needs a person. A finished state must hold on
   * two consecutive polls, and longer when the turn holds a message sent while it ran: a provider that
   * queued that message starts its own turn right after the running one completes.
   */
  async waitForTurn(threadId: string, options: { messageId?: string; timeoutMs: number }): Promise<TurnWaitResult> {
    const startedAt = Date.now();
    const deadline = startedAt + options.timeoutMs;
    let candidate: (TurnObservation & { since: number }) | null = null;
    let last: { snapshotSequence: number; thread: T3Thread } | null = null;
    for (;;) {
      // Polls read a bounded window of recent turns; the whole thread is read once the outcome is clear.
      const read = await this.inspect(threadId).catch((error: unknown) => {
        if (error instanceof CliError && error.code === "THREAD_NOT_FOUND") throw error;
        return null;
      });
      if (read) {
        last = read;
        const previous = candidate as (TurnObservation & { since: number }) | null;
        const observed = observeTurn(read.thread, options.messageId);
        // A blocking request or a failed start cannot change by itself. A question the turn ended with
        // still waits out a queue window, because a queued turn may yet claim the awaited message.
        const final = observed?.blocked === true || observed?.error !== undefined;
        const repeated: boolean =
          previous !== null &&
          observed !== null &&
          previous.outcome === observed.outcome &&
          previous.turnIndex === observed.turnIndex;
        const quiet = !observed?.mayBeQueued || (previous !== null && Date.now() - previous.since >= this.queueGraceMs);
        const confirmed: boolean = observed !== null && (final || (repeated && quiet));
        const full: { snapshotSequence: number; thread: T3Thread } | null =
          observed && confirmed ? await this.read(threadId).catch(() => null) : null;
        // Turn numbers and the reply come from the whole thread, which must still show the same outcome.
        const whole: TurnObservation | null = full ? observeTurn(full.thread, options.messageId) : null;
        if (full && whole && whole.outcome === observed?.outcome) {
          return {
            outcome: whole.outcome,
            snapshotSequence: full.snapshotSequence,
            thread: full.thread,
            turnIndex: whole.turnIndex,
            waitedMs: Date.now() - startedAt,
            ...(whole.error === undefined ? {} : { error: whole.error }),
          };
        }
        const since: number = repeated && previous ? previous.since : Date.now();
        candidate = observed && !full ? { ...observed, since } : null;
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(this.waitIntervalMs, Math.max(0, deadline - Date.now())));
    }
    throw new CliError(
      "THREAD_WAIT_TIMEOUT",
      `Thread ${threadId} did not finish within ${Math.round(options.timeoutMs / 1000)} seconds.`,
      {
        exitCode: 6,
        details: {
          threadId,
          ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
          latestTurn: last?.thread.latestTurn ?? null,
          sessionStatus: last?.thread.session?.status ?? null,
        },
      },
    );
  }

  async catalog(): Promise<ThreadCatalog> {
    const shell = await this.api.shellSnapshot().catch(() => null);
    const snapshot = asSnapshot(shell ?? (await this.api.snapshot()));
    return { ...snapshot, threads: activeThreads(snapshot) };
  }

  async inspect(threadId: string): Promise<{ snapshotSequence: number; thread: T3Thread }> {
    const requestPath = `/api/orchestration/threads/${encodeURIComponent(threadId)}?turnLimit=10`;
    return await this.readDetail(threadId, requestPath);
  }

  /** Reads the unwindowed thread, so callers can number turns and find the original request. */
  async read(threadId: string): Promise<{ snapshotSequence: number; thread: T3Thread }> {
    return await this.readDetail(threadId, `/api/orchestration/threads/${encodeURIComponent(threadId)}`);
  }

  private async readDetail(
    threadId: string,
    requestPath: string,
  ): Promise<{ snapshotSequence: number; thread: T3Thread }> {
    const detail = await this.api.request("GET", requestPath).catch(() => null);
    const parsedDetail = asThreadDetailSnapshot(detail);
    if (parsedDetail) {
      return { snapshotSequence: parsedDetail.snapshotSequence, thread: parsedDetail.thread };
    }

    const snapshot = asSnapshot(await this.api.snapshot());
    const thread = threadById(snapshot, threadId);
    if (!thread) {
      throw new CliError("THREAD_NOT_FOUND", `No T3 Code thread exists with id ${threadId}.`, {
        exitCode: 3,
        details: { threadId },
      });
    }
    return { snapshotSequence: snapshot.snapshotSequence, thread };
  }

  buildTurnStart(thread: T3Thread, prompt: string): ExistingThreadTurnCommand {
    const { runtimeMode, interactionMode } = requireTurnSettings(thread);
    const modelSelection = thread.modelSelection;
    return {
      type: "thread.turn.start",
      commandId: randomUUID(),
      threadId: thread.id,
      message: {
        messageId: randomUUID(),
        role: "user",
        text: prompt,
        attachments: [],
      },
      ...(modelSelection ? { modelSelection } : {}),
      runtimeMode,
      interactionMode,
      createdAt: new Date().toISOString(),
    };
  }

  /** Dispatches a control command. T3 reports a command its decider rejects only as an opaque HTTP 500. */
  async dispatchControl(command: { type: string; threadId: string }): Promise<unknown> {
    try {
      return await this.api.dispatch(command);
    } catch (cause) {
      const status = cause instanceof CliError ? (cause.details as { status?: unknown } | undefined)?.status : undefined;
      if (!(cause instanceof CliError) || cause.code !== "T3_API_ERROR" || status !== 500) throw cause;
      throw new CliError(
        "THREAD_COMMAND_REJECTED",
        `T3 rejected ${command.type} for thread ${command.threadId}. T3 logs the reason on the server.`,
        { exitCode: 4, cause, details: { type: command.type, threadId: command.threadId } },
      );
    }
  }

  /** Reads the thread until `check` returns a value; returns null with the last thread on timeout. */
  async poll<T>(
    threadId: string,
    check: (thread: T3Thread) => T | null,
    timeoutMs = this.verificationTimeoutMs,
  ): Promise<{ value: T | null; thread: T3Thread | null }> {
    const deadline = Date.now() + timeoutMs;
    let last: T3Thread | null = null;
    do {
      const read = await this.read(threadId).catch(() => null);
      if (read) {
        last = read.thread;
        const value = check(read.thread);
        if (value !== null) return { value, thread: read.thread };
      }
      await sleep(this.verificationIntervalMs);
    } while (Date.now() < deadline);
    return { value: null, thread: last };
  }

  buildSettlement(threadId: string, state: ThreadSettlementState): ThreadSettlementCommand {
    return state === "settled"
      ? { type: "thread.settle", commandId: randomUUID(), threadId }
      : { type: "thread.unsettle", commandId: randomUUID(), threadId, reason: "user" };
  }

  async dispatchTurn(
    command: ExistingThreadTurnCommand,
  ): Promise<{ dispatch: unknown; verification: ExistingThreadTurnVerification }> {
    const dispatch = await this.api.dispatch(command);
    const sequence = dispatchSequence(dispatch);
    const deadline = Date.now() + this.verificationTimeoutMs;

    do {
      const inspected = await this.inspect(command.threadId).catch(() => null);
      if (inspected && inspected.snapshotSequence >= sequence) {
        if (messageWasProjected(inspected.thread.messages, command.message.messageId)) {
          return {
            dispatch,
            verification: {
              accepted: true,
              method: "message-id",
              snapshotSequence: inspected.snapshotSequence,
              messageId: command.message.messageId,
            },
          };
        }
      }
      await sleep(this.verificationIntervalMs);
    } while (Date.now() < deadline);

    throw new CliError(
      "THREAD_TURN_NOT_VERIFIED",
      `T3 did not project the new turn for thread ${command.threadId} within ${this.verificationTimeoutMs}ms.`,
      {
        exitCode: 5,
        details: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          dispatchSequence: sequence,
        },
      },
    );
  }

  async dispatchSettlement(
    command: ThreadSettlementCommand,
    previousUpdatedAt: string | undefined,
  ): Promise<{
    dispatch: unknown;
    thread: T3Thread;
    verification: ThreadSettlementVerification;
  }> {
    const state: ThreadSettlementState = command.type === "thread.settle" ? "settled" : "active";
    const dispatch = await this.api.dispatch(command);
    const sequence = dispatchSequence(dispatch);
    const deadline = Date.now() + this.verificationTimeoutMs;

    do {
      const inspected = await this.inspect(command.threadId).catch(() => null);
      if (
        inspected &&
        inspected.snapshotSequence >= sequence &&
        settlementWasProjected(inspected.thread, state, previousUpdatedAt)
      ) {
        return {
          dispatch,
          thread: inspected.thread,
          verification: {
            accepted: true,
            state,
            snapshotSequence: inspected.snapshotSequence,
            settledAt: inspected.thread.settledAt ?? null,
            unsettledAt: inspected.thread.unsettledAt ?? null,
          },
        };
      }
      await sleep(this.verificationIntervalMs);
    } while (Date.now() < deadline);

    throw new CliError(
      "THREAD_SETTLEMENT_NOT_VERIFIED",
      `T3 did not project thread ${command.threadId} as ${state} within ${this.verificationTimeoutMs}ms.`,
      {
        exitCode: 5,
        details: { threadId: command.threadId, state, dispatchSequence: sequence },
      },
    );
  }
}
