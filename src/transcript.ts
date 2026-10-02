import type { T3Message, T3Thread } from "./types.js";

export const READ_DETAILS = ["answers", "messages", "full"] as const;
/**
 * `answers`: each turn's user prompts and final assistant answer.
 * `messages`: user and assistant messages, without reasoning summaries or tool calls.
 * `full`: every message, plus tool calls and changed files.
 * Proposed plans are a plan-mode turn's answer, so every level includes them.
 */
export type ReadDetail = (typeof READ_DETAILS)[number];

export interface TranscriptOptions {
  detail?: ReadDetail;
  /** Keep only the last N turns. */
  turns?: number;
  /** Also keep the first turn, which holds the original request, when the window would skip it. */
  firstTurn?: boolean;
  /** Clip message text, tool input, and tool output to this many characters. */
  maxChars?: number;
}

export type TurnState = "running" | "interrupted" | "completed" | "error" | "pending" | null;

export interface TranscriptTurn {
  index: number;
  /** Null for user messages that are still waiting for a turn. */
  turnId: string | null;
  state: TurnState;
  startedAt: string | null;
  completedAt: string | null;
  finalMessageId: string | null;
  messageCount: number;
  toolCallCount?: number;
  changedFiles?: ChangedFile[];
}

export interface TranscriptMessage extends T3Message {
  turnIndex: number;
  textTruncated: boolean;
}

export interface ToolCall {
  id: string;
  turnId: string | null;
  turnIndex: number;
  kind: string;
  name: string;
  status: string | null;
  input: string | null;
  inputTruncated: boolean;
  output: string | null;
  outputTruncated: boolean;
  startedAt: string;
  updatedAt: string;
}

export interface ChangedFile {
  path: string;
  kind: string | null;
  additions: number | null;
  deletions: number | null;
}

export interface ProposedPlan {
  id: string | null;
  turnId: string | null;
  turnIndex: number | null;
  text: string;
  textTruncated: boolean;
  createdAt: string | null;
}

export interface Transcript {
  view: {
    detail: ReadDetail;
    totalTurns: number;
    returnedTurns: number;
    omittedTurns: number;
    firstTurnIncluded: boolean;
    maxChars: number | null;
  };
  turns: TranscriptTurn[];
  messages: TranscriptMessage[];
  toolCalls?: ToolCall[];
  proposedPlans?: ProposedPlan[];
}

const DEFAULT_TOOL_TEXT_LIMIT = 600;

interface Activity {
  id?: unknown;
  kind?: unknown;
  summary?: unknown;
  payload?: unknown;
  turnId?: unknown;
  createdAt?: unknown;
}

interface Checkpoint {
  turnId?: unknown;
  files?: unknown;
  assistantMessageId?: unknown;
  completedAt?: unknown;
}

interface TurnBuilder {
  turnId: string | null;
  startedAt: string;
  /** Null while the turn runs. */
  endedAt: string | null;
  messages: T3Message[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Keeps the head and tail of long text, where requests, conclusions, and errors usually are. The
 * omission marker counts toward the limit, so clipped text never exceeds it.
 */
export function clip(value: string, limit: number | undefined): { text: string; truncated: boolean } {
  if (limit === undefined || value.length <= limit) return { text: value, truncated: false };
  // The marker states how much it replaces, and its own length decides that amount.
  let marker = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = `\n… [${value.length - (limit - marker.length)} characters omitted] …\n`;
    if (next.length === marker.length) break;
    marker = next;
  }
  const kept = limit - marker.length;
  if (kept <= 0) return { text: value.slice(0, limit), truncated: true };
  const head = Math.ceil(kept * 0.6);
  return { text: `${value.slice(0, head)}${marker}${value.slice(value.length - (kept - head))}`, truncated: true };
}

/**
 * T3 reports provider reasoning summaries as `system` messages unless a client opts into the
 * `reasoning` role. Their ids start with `reasoning:` either way.
 */
export function isReasoningMessage(message: T3Message): boolean {
  return message.role === "system" || message.role === "reasoning" || message.id.startsWith("reasoning:");
}

function byCreatedAt<T extends { createdAt: string }>(left: T, right: T): number {
  return left.createdAt.localeCompare(right.createdAt);
}

/**
 * How soon after a turn ends a queued message's own turn starts. A provider either folds a message
 * sent mid-turn into the running turn or queues it and starts a new turn right after; T3 does not
 * record which happened, so a turn that starts this soon without a prompt of its own took the message.
 */
export const QUEUED_TURN_GRACE_MS = 5_000;

/**
 * Groups messages into turns. T3 projects user messages without a turn id, so each one joins the
 * turn that handled it: a turn that started for it, or the turn it was sent into while that turn ran.
 * Messages that no turn has picked up yet form a pending turn.
 */
function groupTurns(thread: T3Thread, checkpoints: Map<string, Checkpoint>): TurnBuilder[] {
  const spans = new Map<string, { startedAt: string; lastSeenAt: string }>();
  const observe = (turnId: unknown, at: unknown) => {
    if (typeof turnId !== "string" || typeof at !== "string") return;
    const span = spans.get(turnId);
    if (!span) spans.set(turnId, { startedAt: at, lastSeenAt: at });
    else {
      if (at < span.startedAt) span.startedAt = at;
      if (at > span.lastSeenAt) span.lastSeenAt = at;
    }
  };
  if (thread.latestTurn) observe(thread.latestTurn.turnId, thread.latestTurn.requestedAt);
  for (const message of thread.messages ?? []) observe(message.turnId, message.createdAt);
  for (const activity of list(thread.activities) as Activity[]) observe(activity.turnId, activity.createdAt);

  const turns: TurnBuilder[] = [...spans]
    .map(([turnId, span]) => {
      const latest = thread.latestTurn?.turnId === turnId ? thread.latestTurn : null;
      const completedAt = checkpoints.get(turnId)?.completedAt;
      const endedAt = latest
        ? latest.state === "running" ? null : (latest.completedAt ?? span.lastSeenAt)
        : typeof completedAt === "string" ? completedAt : span.lastSeenAt;
      return { turnId, startedAt: span.startedAt, endedAt, messages: [] as T3Message[] };
    })
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const byId = new Map(turns.map((turn) => [turn.turnId, turn]));
  const sorted = [...(thread.messages ?? [])].sort(byCreatedAt);
  let pending: TurnBuilder | null = null;

  const ownerOf = (message: T3Message): TurnBuilder | undefined => {
    if (message.turnId !== null) return byId.get(message.turnId);
    const next = turns.find((turn) => turn.startedAt >= message.createdAt);
    // T3 records a turn's request time as its prompt's time, so an exact match is that turn's prompt.
    if (next?.startedAt === message.createdAt) return next;
    const running = turns.findLast(
      (turn) => turn.startedAt < message.createdAt && (turn.endedAt === null || turn.endedAt > message.createdAt),
    );
    if (!running) return next;
    if (!next || running.endedAt === null) return running;
    const queuedTurn =
      Date.parse(next.startedAt) - Date.parse(running.endedAt) <= QUEUED_TURN_GRACE_MS &&
      // Another message sent while the turn ran was queued too; only a prompt sent after it ended starts the next turn.
      !sorted.some(
        (other) =>
          other.role === "user" && other.createdAt > running.endedAt! && other.createdAt <= next.startedAt,
      );
    return queuedTurn ? next : running;
  };

  for (const message of sorted) {
    const owner = ownerOf(message);
    if (owner) {
      owner.messages.push(message);
      continue;
    }
    pending ??= { turnId: null, startedAt: message.createdAt, endedAt: null, messages: [] };
    pending.messages.push(message);
  }
  return pending ? [...turns, pending] : turns;
}

function checkpointsByTurn(thread: T3Thread): Map<string, Checkpoint> {
  const checkpoints = new Map<string, Checkpoint>();
  for (const checkpoint of list(thread.checkpoints) as Checkpoint[]) {
    if (typeof checkpoint?.turnId === "string") checkpoints.set(checkpoint.turnId, checkpoint);
  }
  return checkpoints;
}

function changedFiles(checkpoint: Checkpoint | undefined): ChangedFile[] {
  return list(checkpoint?.files).flatMap((entry) => {
    const file = record(entry);
    if (!file || typeof file.path !== "string") return [];
    return [{
      path: file.path,
      kind: typeof file.kind === "string" ? file.kind : null,
      additions: typeof file.additions === "number" ? file.additions : null,
      deletions: typeof file.deletions === "number" ? file.deletions : null,
    }];
  });
}

function finalMessageId(turn: TurnBuilder, thread: T3Thread, checkpoint: Checkpoint | undefined): string | null {
  const declared =
    thread.latestTurn?.turnId === turn.turnId ? thread.latestTurn.assistantMessageId : checkpoint?.assistantMessageId;
  if (typeof declared === "string" && turn.messages.some((message) => message.id === declared)) return declared;
  return turn.messages.findLast((message) => message.role === "assistant")?.id ?? null;
}

function turnState(turn: TurnBuilder, thread: T3Thread, checkpoint: Checkpoint | undefined): TurnState {
  if (turn.turnId === null) return "pending";
  if (thread.latestTurn?.turnId === turn.turnId) return thread.latestTurn.state;
  return checkpoint ? "completed" : null;
}

function keepMessage(message: T3Message, detail: ReadDetail, finalId: string | null): boolean {
  if (detail === "full") return true;
  if (message.role === "user") return true;
  if (detail === "messages") return !isReasoningMessage(message);
  return message.id === finalId;
}

/** Folds T3's started/updated/completed tool activities into one entry per tool call or background task. */
function collectToolCalls(thread: T3Thread): Array<Omit<ToolCall, "turnIndex" | "inputTruncated" | "outputTruncated">> {
  const calls = new Map<string, Omit<ToolCall, "turnIndex" | "inputTruncated" | "outputTruncated">>();
  for (const activity of list(thread.activities) as Activity[]) {
    const kind = typeof activity.kind === "string" ? activity.kind : "";
    const payload = record(activity.payload);
    if (!payload || typeof activity.createdAt !== "string") continue;
    const isTool = kind.startsWith("tool.") && typeof payload.toolCallId === "string";
    const isTask = kind.startsWith("task.") && typeof payload.taskId === "string";
    if (!isTool && !isTask) continue;

    const id = isTool ? (payload.toolCallId as string) : `task:${payload.taskId as string}`;
    const data = record(payload.data);
    const item = record(data?.item);
    const rawOutput = record(data?.rawOutput);
    const result = record(data?.result);
    const previous = calls.get(id);
    // Later activities can omit fields an earlier one carried, such as a task's type.
    const name =
      (isTool ? (text(data?.toolName) ?? text(payload.title)) : text(payload.taskType)) ??
      previous?.name ??
      (isTool ? (text(activity.summary) ?? "tool") : "task");
    // T3's display detail repeats the tool name ("Bash: git status"); the name is already shown.
    const rawDetail = text(payload.detail);
    const detail = rawDetail?.startsWith(`${name}: `) ? rawDetail.slice(name.length + 2) : rawDetail;
    const files = list(data?.files).flatMap((file) => {
      const filePath = record(file)?.path;
      return typeof filePath === "string" ? [filePath] : [];
    });
    const input = isTool
      ? (text(data?.command) ??
        text(item?.command) ??
        (files.length > 0 ? files.join(", ") : null) ??
        (detail === "{}" ? null : detail))
      : (text(payload.title) ?? detail);
    const output = isTool
      ? (text(item?.aggregatedOutput) ?? text(rawOutput?.content) ?? text(result?.content) ?? text(data?.output))
      : null;
    // An update can arrive after the completion with the same timestamp; keep the final status.
    const finished = previous?.status !== undefined && previous.status !== null && previous.status !== "inProgress";
    calls.set(id, {
      id,
      turnId: typeof activity.turnId === "string" ? activity.turnId : (previous?.turnId ?? null),
      kind: isTool ? (text(payload.itemType) ?? "tool") : "task",
      name,
      status: finished ? previous.status : (text(payload.status) ?? previous?.status ?? null),
      input: input ?? previous?.input ?? null,
      output: output ?? previous?.output ?? null,
      startedAt: previous?.startedAt ?? activity.createdAt,
      updatedAt: activity.createdAt,
    });
  }
  return [...calls.values()];
}

function collectPlans(thread: T3Thread): Array<Omit<ProposedPlan, "turnIndex" | "textTruncated">> {
  return list(thread.proposedPlans).flatMap((entry) => {
    const plan = record(entry);
    const body = text(plan?.planMarkdown) ?? text(plan?.text) ?? text(plan?.markdown);
    if (!plan || !body) return [];
    return [{
      id: typeof plan.id === "string" ? plan.id : null,
      turnId: typeof plan.turnId === "string" ? plan.turnId : null,
      text: body,
      createdAt: typeof plan.createdAt === "string" ? plan.createdAt : null,
    }];
  });
}

export interface PendingQuestion {
  id: string;
  header: string | null;
  question: string;
  /** Option labels. */
  options: string[];
  /** The options with the value T3 Code sends for each, when it differs from the label. */
  choices: Array<{ label: string; value: string | null; description: string | null }>;
  multiSelect: boolean;
  allowCustomAnswer: boolean;
}

export interface PendingRequest {
  kind: "approval" | "user-input";
  requestId: string | null;
  turnId: string | null;
  /** `message` questions outlive their turn, and answering one starts a new turn. */
  responseMode: "message" | null;
  /** Whether the request holds up a running turn until someone answers it. */
  blocking: boolean;
  /** The approval's subject, such as the command to run. */
  detail: string | null;
  requestKind: string | null;
  /** The decisions an approval offers, when it lists them. */
  decisions: string[];
  questions: PendingQuestion[];
  createdAt: string;
}

function describeChoices(options: unknown): Pick<PendingQuestion, "options" | "choices"> {
  const choices = list(options).flatMap((option) => {
    const choice = record(option);
    return typeof choice?.label === "string"
      ? [{ label: choice.label, value: text(choice.value), description: text(choice.description) }]
      : [];
  });
  return { options: choices.map((choice) => choice.label), choices };
}

function pendingQuestions(payload: Record<string, unknown>): PendingQuestion[] {
  return list(payload.questions).flatMap((entry) => {
    const question = record(entry);
    if (!question || typeof question.question !== "string") return [];
    return [{
      id: typeof question.id === "string" ? question.id : "",
      header: text(question.header),
      question: question.question,
      ...describeChoices(question.options),
      multiSelect: question.multiSelect === true,
      allowCustomAnswer: question.allowCustomAnswer !== false,
    }];
  });
}

/** T3 closes a request whose provider callback is gone after reporting it as stale. */
function closedByStaleFailure(activity: Activity, payload: Record<string, unknown>): boolean {
  const failed = activity.kind === "provider.approval.respond.failed" || activity.kind === "provider.user-input.respond.failed";
  return failed && typeof payload.detail === "string" && /stale|unknown pending/iu.test(payload.detail);
}

/**
 * Approvals and questions that wait for a person. The thread detail has no pending flags (only the
 * shell snapshot does), so requests come from the activity log, which always keeps pending ones.
 * T3 auto-closes ordinary questions when their turn ends but never cleans up approvals, so an
 * approval counts only while its turn runs. `message` questions stay open across turns.
 */
export function pendingRequests(thread: T3Thread): PendingRequest[] {
  const activities = list(thread.activities) as Activity[];
  const resolved = new Set(
    activities.flatMap((activity) => {
      const payload = record(activity.payload);
      const requestId = payload?.requestId;
      if (!payload || typeof requestId !== "string") return [];
      const done =
        activity.kind === "approval.resolved" ||
        activity.kind === "user-input.resolved" ||
        closedByStaleFailure(activity, payload);
      return done ? [requestId] : [];
    }),
  );
  const runningTurn = thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null;
  return activities.flatMap((activity) => {
    const payload = record(activity.payload);
    const kind =
      activity.kind === "approval.requested" ? "approval" : activity.kind === "user-input.requested" ? "user-input" : null;
    if (!kind || !payload || typeof activity.createdAt !== "string") return [];
    const flag = kind === "approval" ? thread.hasPendingApprovals : thread.hasPendingUserInput;
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    if (flag === false || (requestId !== null && resolved.has(requestId))) return [];
    const turnId = typeof activity.turnId === "string" ? activity.turnId : null;
    const responseMode = kind === "user-input" && payload.responseMode === "message" ? "message" : null;
    const inRunningTurn = runningTurn !== null && turnId === runningTurn;
    // T3 closes ordinary questions when their turn ends; message-mode questions stay open.
    if (responseMode === null && !inRunningTurn && flag !== true) return [];
    return [{
      kind,
      requestId,
      turnId,
      responseMode,
      blocking: responseMode === null && inRunningTurn,
      detail: text(payload.detail) ?? text(payload.requestKind) ?? text(activity.summary),
      requestKind: text(payload.requestKind),
      decisions: list(payload.options).flatMap((option) => {
        const decision = record(option)?.decision;
        return typeof decision === "string" ? [decision] : [];
      }),
      questions: pendingQuestions(payload),
      createdAt: activity.createdAt,
    }];
  });
}

export function renderPendingRequests(requests: readonly PendingRequest[]): string {
  return requests
    .map((request) => {
      const id = request.requestId ? ` [${request.requestId}]` : "";
      if (request.kind === "approval") {
        return `- Approval${id}: ${request.detail ?? request.requestKind ?? "no detail"}`;
      }
      const lines = [`- Question${id}${request.responseMode === "message" ? " (answer starts a new turn)" : ""}:`];
      request.questions.forEach((question, index) => {
        const options =
          question.options.length > 0 ? ` (options: ${question.options.join(" / ")})` : "";
        lines.push(`  ${index + 1}. ${question.question}${options}`);
      });
      return lines.join("\n");
    })
    .join("\n");
}

export function buildTranscript(thread: T3Thread, options: TranscriptOptions = {}): Transcript {
  const detail = options.detail ?? "messages";
  const maxChars = options.maxChars;
  const toolLimit = maxChars ?? DEFAULT_TOOL_TEXT_LIMIT;
  const checkpoints = checkpointsByTurn(thread);
  const grouped = groupTurns(thread, checkpoints);
  const started = grouped.filter((turn) => turn.turnId !== null);
  const pending = grouped.filter((turn) => turn.turnId === null);
  const window = [...(options.turns === undefined ? started : started.slice(-options.turns)), ...pending];
  const selected =
    options.firstTurn && started[0] && !window.includes(started[0]) ? [started[0], ...window] : window;
  const firstTurnIncluded = started[0] !== undefined && selected.includes(started[0]);

  const turns: TranscriptTurn[] = [];
  const messages: TranscriptMessage[] = [];
  const indexByTurnId = new Map<string, number>();
  for (const turn of selected) {
    const index = grouped.indexOf(turn) + 1;
    const checkpoint = turn.turnId === null ? undefined : checkpoints.get(turn.turnId);
    const finalId = finalMessageId(turn, thread, checkpoint);
    const kept = turn.messages.filter((message) => keepMessage(message, detail, finalId));
    if (turn.turnId !== null) indexByTurnId.set(turn.turnId, index);
    for (const message of kept) {
      const clipped = clip(message.text, maxChars);
      messages.push({ ...message, text: clipped.text, textTruncated: clipped.truncated, turnIndex: index });
    }
    const latest = thread.latestTurn?.turnId === turn.turnId ? thread.latestTurn : null;
    turns.push({
      index,
      turnId: turn.turnId,
      state: turnState(turn, thread, checkpoint),
      // Older turns have no recorded start; the prompt that started them is the best estimate.
      startedAt:
        turn.turnId === null
          ? null
          : (latest?.startedAt ??
            (turn.messages[0] && turn.messages[0].createdAt < turn.startedAt ? turn.messages[0].createdAt : turn.startedAt)),
      completedAt: latest ? latest.completedAt : typeof checkpoint?.completedAt === "string" ? checkpoint.completedAt : null,
      finalMessageId: finalId,
      messageCount: kept.length,
      ...(detail === "full" ? { changedFiles: changedFiles(checkpoint) } : {}),
    });
  }

  const transcript: Transcript = {
    view: {
      detail,
      totalTurns: started.length,
      returnedTurns: turns.filter((turn) => turn.turnId !== null).length,
      omittedTurns: started.length - turns.filter((turn) => turn.turnId !== null).length,
      firstTurnIncluded,
      maxChars: maxChars ?? null,
    },
    turns,
    messages,
  };
  // In plan mode the proposed plan is the turn's answer, so every detail level keeps it.
  transcript.proposedPlans = collectPlans(thread).flatMap((plan) => {
    const turnIndex = plan.turnId === null ? null : (indexByTurnId.get(plan.turnId) ?? null);
    if (plan.turnId !== null && turnIndex === null) return [];
    const clipped = clip(plan.text, maxChars);
    return [{ ...plan, turnIndex, text: clipped.text, textTruncated: clipped.truncated }];
  });
  if (detail !== "full") return transcript;

  const toolCalls: ToolCall[] = collectToolCalls(thread).flatMap((call) => {
    const turnIndex = call.turnId === null ? undefined : indexByTurnId.get(call.turnId);
    if (turnIndex === undefined) return [];
    const input = call.input === null ? null : clip(call.input, toolLimit);
    const output = call.output === null ? null : clip(call.output, toolLimit);
    return [{
      ...call,
      turnIndex,
      input: input?.text ?? null,
      inputTruncated: input?.truncated ?? false,
      output: output?.text ?? null,
      outputTruncated: output?.truncated ?? false,
    }];
  });
  for (const turn of turns) turn.toolCallCount = toolCalls.filter((call) => call.turnIndex === turn.index).length;
  transcript.toolCalls = toolCalls;
  return transcript;
}

/** Narrows a transcript to one turn, optionally leaving out messages the caller already knows. */
export function selectTurn(transcript: Transcript, index: number | null, omitMessageIds: readonly string[] = []): Transcript {
  const turns = transcript.turns.filter((turn) => turn.index === index);
  const returnedTurns = turns.filter((turn) => turn.turnId !== null).length;
  return {
    view: {
      ...transcript.view,
      returnedTurns,
      omittedTurns: transcript.view.totalTurns - returnedTurns,
      // Pending messages always come after the started turns, so turn 1 is the first started turn.
      firstTurnIncluded: turns.some((turn) => turn.index === 1 && turn.turnId !== null),
    },
    turns,
    messages: transcript.messages.filter((message) => message.turnIndex === index && !omitMessageIds.includes(message.id)),
    ...(transcript.toolCalls ? { toolCalls: transcript.toolCalls.filter((call) => call.turnIndex === index) } : {}),
    ...(transcript.proposedPlans
      ? { proposedPlans: transcript.proposedPlans.filter((plan) => plan.turnIndex === index) }
      : {}),
  };
}

function time(value: string | null | undefined): string {
  return value ? value.replace("T", " ").replace(/\.\d+Z$/u, "Z") : "unknown time";
}

function quote(value: string): string {
  return value.split(/\r?\n/u).map((line) => `> ${line}`).join("\n");
}

function toolLine(call: ToolCall): string {
  const status = call.status && call.status !== "completed" ? ` (${call.status})` : "";
  const input = call.input?.trim() ?? "";
  const inline = input.length > 0 && !input.includes("\n");
  const lines = [`- ${call.name}${status}${inline ? `: ${input}` : ""}`];
  if (input.length > 0 && !inline) lines.push(quote(input));
  const output = call.output?.trim();
  if (output) lines.push(quote(output));
  return lines.join("\n");
}

/** Renders a transcript as compact Markdown that an agent can read directly. */
export function renderTranscript(transcript: Transcript): string {
  const sections: string[] = [];
  for (const turn of transcript.turns) {
    const state = turn.state ? ` · ${turn.state}` : "";
    const heading =
      turn.turnId === null ? "## Pending messages" : `## Turn ${turn.index}${state} · ${time(turn.startedAt)}`;
    const parts = [heading];
    const files = turn.changedFiles ?? [];
    const entries = [
      ...transcript.messages
        .filter((message) => message.turnIndex === turn.index)
        .map((message) => ({ at: message.createdAt, message, call: null })),
      ...(transcript.toolCalls ?? [])
        .filter((call) => call.turnIndex === turn.index)
        .map((call) => ({ at: call.startedAt, message: null, call })),
    ].sort((left, right) => left.at.localeCompare(right.at));
    let toolRun: string[] | null = null;
    for (const entry of entries) {
      if (entry.call) {
        // Consecutive tool calls share one block between messages, which keeps the timeline readable.
        if (!toolRun) parts.push((toolRun = ["### tools"]).join(""));
        toolRun.push(toolLine(entry.call));
        parts[parts.length - 1] = toolRun.join("\n");
        continue;
      }
      toolRun = null;
      const message = entry.message!;
      const label = isReasoningMessage(message)
        ? "reasoning"
        : message.id === turn.finalMessageId
          ? turn.state === "completed" || turn.state === null
            ? "assistant (final)"
            : "assistant (latest)"
          : message.role;
      parts.push(`### ${label} · ${time(message.createdAt)}\n${message.text.trim()}`);
    }
    if (files.length > 0) {
      parts.push(
        `### changed files\n${files
          .map((file) => `- ${file.kind ?? "changed"} ${file.path}${file.additions === null ? "" : ` (+${file.additions} -${file.deletions ?? 0})`}`)
          .join("\n")}`,
      );
    }
    for (const plan of (transcript.proposedPlans ?? []).filter((candidate) => candidate.turnIndex === turn.index)) {
      parts.push(`### proposed plan\n${plan.text}`);
    }
    if (entries.length === 0 && files.length === 0) parts.push("_No messages in this view._");
    sections.push(parts.join("\n\n"));
  }
  return sections.join("\n\n");
}
