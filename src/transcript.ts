import {
  ACTIVE_RUN_STATUSES,
  type RunStatus,
  type T3Message,
  type T3Run,
  type T3RuntimeRequest,
  type T3ThreadProjection,
  type T3TurnItem,
} from "./types.js";

export const READ_DETAILS = ["answers", "messages", "full"] as const;
/**
 * `answers`: each turn's user prompts and final assistant answer.
 * `messages`: user and assistant messages, without reasoning summaries or tool calls.
 * `full`: every message, plus reasoning, tool calls, and changed files.
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

/**
 * A turn's state. `pending` is a queued run that has not started; `rolled_back` is a run whose
 * checkpoint was restored. Imported V1 history has no recorded state, so its turns are null.
 */
export type TurnState = "running" | "interrupted" | "completed" | "error" | "pending" | "rolled_back" | null;

export interface TranscriptTurn {
  index: number;
  /** The run id. Null for history imported from orchestrator V1, which has no runs. */
  turnId: string | null;
  state: TurnState;
  /** The run's own status, which `state` simplifies. */
  runStatus: RunStatus | null;
  imported: boolean;
  /** True for a turn a fork inherited from its source thread; `turnId` is then that thread's run. */
  inherited: boolean;
  sourceThreadId: string | null;
  queuePosition: number | null;
  startedAt: string | null;
  completedAt: string | null;
  finalMessageId: string | null;
  messageCount: number;
  toolCallCount?: number;
  changedFiles?: ChangedFile[];
}

export interface TranscriptMessage {
  id: string;
  role: T3Message["role"];
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
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
/** Timeline items that are messages, plans, or checkpoints rather than tool activity. */
const NON_TOOL_ITEM_TYPES = new Set(["user_message", "assistant_message", "reasoning", "proposed_plan", "checkpoint"]);

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

export function isActiveRun(run: T3Run): boolean {
  return ACTIVE_RUN_STATUSES.includes(run.status);
}

export function turnStateOf(status: RunStatus): TurnState {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "failed":
      return "error";
    case "queued":
      return "pending";
    case "rolled_back":
      return "rolled_back";
    default:
      return "running";
  }
}

function sortedRuns(projection: T3ThreadProjection): T3Run[] {
  return [...projection.runs].sort((left, right) => left.ordinal - right.ordinal);
}

/** The run that is working right now, if any. T3 runs one root run per thread at a time. */
export function activeRun(projection: T3ThreadProjection): T3Run | null {
  return sortedRuns(projection).findLast(isActiveRun) ?? null;
}

/** Runs waiting behind the active one, in delivery order. */
export function queuedRuns(projection: T3ThreadProjection): T3Run[] {
  return sortedRuns(projection)
    .filter((run) => run.status === "queued")
    .sort((left, right) => (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal));
}

export interface BusyState {
  runRunning: boolean;
  activeRunId: string | null;
  queuedRuns: number;
  /** Restart recovery holds the queue until someone resumes it. */
  queueHeld: boolean;
}

/** What keeps a thread busy: a run that works, or queued runs that wait for their turn. */
export function busyState(projection: T3ThreadProjection): BusyState | null {
  const active = activeRun(projection);
  const queued = queuedRuns(projection);
  if (!active && queued.length === 0) return null;
  return {
    runRunning: active !== null,
    activeRunId: active?.id ?? null,
    queuedRuns: queued.length,
    queueHeld: queued.some((run) => run.queueHeld === true),
  };
}

function messageOrder(left: { createdAt: string }, right: { createdAt: string }): number {
  return left.createdAt.localeCompare(right.createdAt);
}

interface TurnGroup {
  run: T3Run | null;
  /** The source thread's run, for a turn a fork inherited. */
  inheritedRunId: string | null;
  inheritedFrom: string | null;
  sortKey: string;
  messages: T3Message[];
}

interface InheritedTimeline {
  items: T3TurnItem[];
  messages: T3Message[];
  /** Source thread of each inherited run. */
  sources: Map<string, string>;
}

/**
 * A fork starts with its source thread's history, which T3 lists among the fork's visible timeline
 * items rather than its own messages and items.
 */
function inheritedTimeline(projection: T3ThreadProjection): InheritedTimeline {
  const items: T3TurnItem[] = [];
  const sources = new Map<string, string>();
  for (const entry of list(projection.visibleTurnItems)) {
    const visible = record(entry);
    const item = record(visible?.item);
    if (visible?.visibility !== "inherited" || !item || typeof item.type !== "string" || typeof item.id !== "string") continue;
    const runId = typeof item.runId === "string" ? item.runId : null;
    if (runId && typeof visible.sourceThreadId === "string") sources.set(runId, visible.sourceThreadId);
    items.push({ ...item, runId } as T3TurnItem);
  }
  const messages = items.flatMap((item): T3Message[] =>
    (item.type === "user_message" || item.type === "assistant_message") && typeof item.text === "string"
      ? [{
          id: typeof item.messageId === "string" ? item.messageId : item.id,
          runId: item.runId,
          role: item.type === "user_message" ? "user" : "assistant",
          text: item.text,
          streaming: item.streaming === true,
          createdAt: itemTime(item),
          updatedAt: item.updatedAt ?? itemTime(item),
        }]
      : [],
  );
  return { items, messages, sources };
}

/**
 * Groups messages into turns. A V2 message names its run, so each run is a turn, and a fork's inherited
 * history keeps its source runs. History imported from orchestrator V1 has no runs: there, each user
 * message opens a turn and the replies after it join it.
 */
function groupTurns(projection: T3ThreadProjection, messages: readonly T3Message[], sources: ReadonlyMap<string, string>): TurnGroup[] {
  const runs = sortedRuns(projection);
  const byRun = new Map<string, TurnGroup>(
    runs.map((run) => [run.id, { run, inheritedRunId: null, inheritedFrom: null, sortKey: run.requestedAt, messages: [] }]),
  );
  const inherited = new Map<string, TurnGroup>();
  const imported: TurnGroup[] = [];
  for (const message of [...messages].sort(messageOrder)) {
    const owner = message.runId === null ? undefined : byRun.get(message.runId);
    if (owner) {
      owner.messages.push(message);
      continue;
    }
    const source = message.runId === null ? undefined : sources.get(message.runId);
    if (message.runId !== null && source !== undefined) {
      const group = inherited.get(message.runId);
      if (group) group.messages.push(message);
      else inherited.set(message.runId, { run: null, inheritedRunId: message.runId, inheritedFrom: source, sortKey: message.createdAt, messages: [message] });
      continue;
    }
    const current = imported.at(-1);
    if (message.role === "user" || !current) {
      imported.push({ run: null, inheritedRunId: null, inheritedFrom: null, sortKey: message.createdAt, messages: [message] });
    }
    else current.messages.push(message);
  }
  const queued = (group: TurnGroup) => group.run?.status === "queued";
  // A queued message promoted into the running turn leaves its own run cancelled, unstarted, and empty.
  const vacated = (group: TurnGroup) =>
    group.run?.status === "cancelled" && group.run.startedAt === null && group.messages.length === 0;
  const started = [...imported, ...byRun.values()].filter((group) => !queued(group) && !vacated(group));
  started.sort((left, right) => left.sortKey.localeCompare(right.sortKey) || (left.run?.ordinal ?? 0) - (right.run?.ordinal ?? 0));
  const waiting = queuedRuns(projection).map((run) => byRun.get(run.id)!);
  // A fork's inherited history comes before anything the fork did itself.
  const before = [...inherited.values()].sort((left, right) => left.sortKey.localeCompare(right.sortKey));
  return [...before, ...started, ...waiting];
}

/** Reasoning summaries are timeline items in V2; the full view shows them as `reasoning` messages. */
function reasoningMessages(items: readonly T3TurnItem[]): T3Message[] {
  return items.flatMap((item) => {
    if (item.type !== "reasoning" || typeof item.text !== "string" || item.text.length === 0) return [];
    const createdAt = item.startedAt ?? item.updatedAt ?? item.completedAt ?? "";
    return [{
      id: item.id,
      runId: item.runId,
      role: "reasoning" as const,
      text: item.text,
      streaming: item.streaming === true,
      createdAt,
      updatedAt: item.updatedAt ?? createdAt,
    }];
  });
}

function finalMessageId(group: TurnGroup): string | null {
  const assistants = group.messages.filter((message) => message.role === "assistant");
  return (assistants.findLast((message) => !message.streaming) ?? assistants.at(-1))?.id ?? null;
}

function keepMessage(message: T3Message, detail: ReadDetail, finalId: string | null): boolean {
  if (detail === "full") return true;
  if (message.role === "user") return true;
  if (detail === "messages") return message.role === "assistant";
  return message.id === finalId;
}

function itemTime(item: T3TurnItem): string {
  return item.startedAt ?? item.updatedAt ?? item.completedAt ?? "";
}

function joined(values: unknown, pick: (entry: Record<string, unknown>) => string | null): string | null {
  const parts = list(values).flatMap((entry) => {
    const value = record(entry);
    const picked = value ? pick(value) : null;
    return picked ? [picked] : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Describes a tool-like timeline item as a name, its input, and its output. */
function describeItem(item: T3TurnItem): { name: string; input: string | null; output: string | null } {
  switch (item.type) {
    case "command_execution":
      return { name: "command", input: text(item.input), output: text(item.output) };
    case "file_change": {
      const counts =
        typeof item.additions === "number" ? ` (+${item.additions} -${typeof item.deletions === "number" ? item.deletions : 0})` : "";
      return { name: "file change", input: `${text(item.fileName) ?? "file"}${counts}`, output: text(item.diffStr) };
    }
    case "file_search":
      return {
        name: "file search",
        input: text(item.pattern),
        output: joined(item.results, (result) => text(result.fileName)),
      };
    case "web_search":
      return {
        name: "web search",
        input: list(item.patterns).filter((pattern) => typeof pattern === "string").join(", ") || null,
        output: joined(item.results, (result) => text(result.url) ?? text(result.title)),
      };
    case "dynamic_tool":
      return { name: text(item.toolName) ?? "tool", input: text(item.input), output: text(item.output) };
    case "subagent":
      return { name: "subagent", input: text(item.prompt), output: text(item.result) ?? text(item.progress) };
    case "approval_request":
      return { name: "approval", input: text(item.prompt) ?? text(item.requestKind), output: null };
    case "user_input_request":
      return {
        name: "question",
        input: joined(item.questions, (question) => text(question.question)),
        output: text(record(item.questionAnswer)?.answers),
      };
    case "error":
      return { name: "error", input: null, output: text(record(item.failure)?.message) };
    case "todo_list":
      return { name: "todo list", input: text(item.explanation), output: joined(item.steps, (step) => `[${text(step.status) ?? "?"}] ${text(step.text) ?? ""}`) };
    case "notification":
      return { name: "notification", input: text(item.summary), output: text(item.detail) };
    case "thread_created":
      return { name: "thread created", input: text(item.targetThreadId), output: text(item.targetModel) };
    default:
      return {
        name: item.type.replaceAll("_", " "),
        input: text(item.title) ?? text(item.message),
        output: text(item.summary),
      };
  }
}

function changedFilesOf(allItems: readonly T3TurnItem[], runId: string): ChangedFile[] {
  const items = allItems.filter((item) => item.runId === runId);
  const checkpointFiles = items
    .filter((item) => item.type === "checkpoint")
    .flatMap((item) =>
      list(item.files).flatMap((entry) => {
        const file = record(entry);
        if (!file || typeof file.path !== "string") return [];
        return [{
          path: file.path,
          kind: typeof file.kind === "string" ? file.kind : null,
          additions: typeof file.additions === "number" ? file.additions : null,
          deletions: typeof file.deletions === "number" ? file.deletions : null,
        }];
      }),
    );
  if (checkpointFiles.length > 0) return checkpointFiles;
  return items.flatMap((item) =>
    item.type === "file_change" && typeof item.fileName === "string"
      ? [{
          path: item.fileName,
          kind: "changed",
          additions: typeof item.additions === "number" ? item.additions : null,
          deletions: typeof item.deletions === "number" ? item.deletions : null,
        }]
      : [],
  );
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
  requestId: string;
  /** The run that raised the request. */
  turnId: string | null;
  /** `message` questions outlive their run, and answering one starts a new run. */
  responseMode: "message" | null;
  /** Whether a live provider session waits on the answer, holding up its run. */
  blocking: boolean;
  /** False when the provider session that asked is gone, so only dismissing it is left. */
  answerable: boolean;
  /** The approval's subject, such as the command to run. */
  detail: string | null;
  requestKind: string | null;
  /** The decisions an approval offers, when it lists them. */
  decisions: string[];
  questions: PendingQuestion[];
  createdAt: string;
}

function pendingQuestions(item: T3TurnItem | undefined): PendingQuestion[] {
  return list(item?.questions).flatMap((entry) => {
    const question = record(entry);
    if (!question || typeof question.question !== "string") return [];
    const choices = list(question.options).flatMap((option) => {
      const choice = record(option);
      return typeof choice?.label === "string"
        ? [{ label: choice.label, value: text(choice.value), description: text(choice.description) }]
        : [];
    });
    return [{
      id: typeof question.id === "string" ? question.id : "",
      header: text(question.header),
      question: question.question,
      options: choices.map((choice) => choice.label),
      choices,
      multiSelect: question.multiSelect === true,
      allowCustomAnswer: question.allowCustomAnswer !== false,
    }];
  });
}

function requestItem(projection: T3ThreadProjection, request: T3RuntimeRequest): T3TurnItem | undefined {
  return projection.turnItems.find(
    (item) => (item.type === "approval_request" || item.type === "user_input_request") && item.requestId === request.id,
  );
}

/** Approvals and questions that wait for a person, from V2's runtime requests. */
export function pendingRequests(projection: T3ThreadProjection): PendingRequest[] {
  return projection.runtimeRequests
    .filter((request) => request.status === "pending")
    .map((request) => {
      const item = requestItem(projection, request);
      const kind = item?.type === "user_input_request" || request.kind === "user_input" ? "user-input" : "approval";
      const capability = request.responseCapability?.type ?? "live";
      return {
        kind,
        requestId: request.id,
        turnId: item?.runId ?? null,
        responseMode: kind === "user-input" && (capability === "message" || item?.responseMode === "message") ? "message" : null,
        blocking: capability === "live",
        answerable: capability !== "not_resumable",
        detail: text(item?.prompt) ?? text(item?.title) ?? text(item?.requestKind) ?? request.kind,
        requestKind: text(item?.requestKind) ?? request.kind,
        decisions: list(item?.options).flatMap((option) => {
          const decision = record(option)?.decision;
          return typeof decision === "string" ? [decision] : [];
        }),
        questions: pendingQuestions(item),
        createdAt: request.createdAt,
      } satisfies PendingRequest;
    });
}

export function renderPendingRequests(requests: readonly PendingRequest[]): string {
  return requests
    .map((request) => {
      const id = ` [${request.requestId}]`;
      const stale = request.answerable ? "" : " (its session is gone; dismiss it)";
      if (request.kind === "approval") {
        return `- Approval${id}: ${request.detail ?? request.requestKind ?? "no detail"}${stale}`;
      }
      const lines = [`- Question${id}${request.responseMode === "message" ? " (answer starts a new turn)" : ""}${stale}:`];
      request.questions.forEach((question, index) => {
        const options = question.options.length > 0 ? ` (options: ${question.options.join(" / ")})` : "";
        lines.push(`  ${index + 1}. ${question.question}${options}`);
      });
      return lines.join("\n");
    })
    .join("\n");
}

/** The user message that started each run, so a queued run can show what it will send. */
export function runMessage(projection: T3ThreadProjection, run: T3Run): T3Message | null {
  return projection.messages.find((message) => message.id === run.userMessageId) ?? null;
}

export function buildTranscript(projection: T3ThreadProjection, options: TranscriptOptions = {}): Transcript {
  const detail = options.detail ?? "messages";
  const maxChars = options.maxChars;
  const toolLimit = maxChars ?? DEFAULT_TOOL_TEXT_LIMIT;
  const inherited = inheritedTimeline(projection);
  const items = [...inherited.items, ...projection.turnItems];
  const ownMessages = [...inherited.messages, ...projection.messages];
  const messages = detail === "full" ? [...ownMessages, ...reasoningMessages(items)] : ownMessages;
  const grouped = groupTurns(projection, messages, inherited.sources);
  const started = grouped.filter((group) => group.run?.status !== "queued");
  const waiting = grouped.filter((group) => group.run?.status === "queued");
  const window = [...(options.turns === undefined ? started : started.slice(-options.turns)), ...waiting];
  const selected = options.firstTurn && started[0] && !window.includes(started[0]) ? [started[0], ...window] : window;
  const firstTurnIncluded = started[0] !== undefined && selected.includes(started[0]);

  const turns: TranscriptTurn[] = [];
  const kept: TranscriptMessage[] = [];
  const indexByRunId = new Map<string, number>();
  for (const group of selected) {
    const index = grouped.indexOf(group) + 1;
    const finalId = finalMessageId(group);
    const visible = group.messages.filter((message) => keepMessage(message, detail, finalId));
    const runId = group.run?.id ?? group.inheritedRunId;
    if (runId) indexByRunId.set(runId, index);
    for (const message of visible) {
      const clipped = clip(message.text, maxChars);
      kept.push({
        id: message.id,
        role: message.role,
        text: clipped.text,
        turnId: message.runId,
        streaming: message.streaming,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        turnIndex: index,
        textTruncated: clipped.truncated,
      });
    }
    const run = group.run;
    turns.push({
      index,
      turnId: runId,
      state: run ? turnStateOf(run.status) : null,
      runStatus: run?.status ?? null,
      imported: run === null && group.inheritedFrom === null,
      inherited: group.inheritedFrom !== null,
      sourceThreadId: group.inheritedFrom,
      queuePosition: run?.status === "queued" ? (run.queuePosition ?? null) : null,
      startedAt: run ? (run.startedAt ?? (run.status === "queued" ? null : run.requestedAt)) : (group.messages[0]?.createdAt ?? null),
      completedAt: run ? run.completedAt : null,
      finalMessageId: finalId,
      messageCount: visible.length,
      ...(detail === "full" ? { changedFiles: runId ? changedFilesOf(items, runId) : [] } : {}),
    });
  }
  kept.sort((left, right) => left.turnIndex - right.turnIndex || messageOrder(left, right));

  const transcript: Transcript = {
    view: {
      detail,
      totalTurns: started.length,
      returnedTurns: turns.filter((turn) => turn.state !== "pending").length,
      omittedTurns: started.length - turns.filter((turn) => turn.state !== "pending").length,
      firstTurnIncluded,
      maxChars: maxChars ?? null,
    },
    turns,
    messages: kept,
  };
  // In plan mode the proposed plan is the turn's answer, so every detail level keeps it.
  transcript.proposedPlans = items.flatMap((item) => {
    if (item.type !== "proposed_plan" || typeof item.markdown !== "string" || item.markdown.length === 0) return [];
    const turnIndex = item.runId === null ? null : (indexByRunId.get(item.runId) ?? null);
    if (item.runId !== null && turnIndex === null) return [];
    const clipped = clip(item.markdown, maxChars);
    return [{
      id: typeof item.planId === "string" ? item.planId : item.id,
      turnId: item.runId,
      turnIndex,
      text: clipped.text,
      textTruncated: clipped.truncated,
      createdAt: item.startedAt ?? item.updatedAt ?? null,
    }];
  });
  if (detail !== "full") return transcript;

  const toolCalls: ToolCall[] = items.flatMap((item) => {
    if (NON_TOOL_ITEM_TYPES.has(item.type) || item.runId === null) return [];
    const turnIndex = indexByRunId.get(item.runId);
    if (turnIndex === undefined) return [];
    const described = describeItem(item);
    const input = described.input === null ? null : clip(described.input, toolLimit);
    const output = described.output === null ? null : clip(described.output, toolLimit);
    return [{
      id: item.id,
      turnId: item.runId,
      turnIndex,
      kind: item.type,
      name: described.name,
      status: item.status ?? null,
      input: input?.text ?? null,
      inputTruncated: input?.truncated ?? false,
      output: output?.text ?? null,
      outputTruncated: output?.truncated ?? false,
      startedAt: itemTime(item),
      updatedAt: item.updatedAt ?? itemTime(item),
    }];
  });
  for (const turn of turns) turn.toolCallCount = toolCalls.filter((call) => call.turnIndex === turn.index).length;
  transcript.toolCalls = toolCalls;
  return transcript;
}

/** Narrows a transcript to one turn, optionally leaving out messages the caller already knows. */
export function selectTurn(transcript: Transcript, index: number | null, omitMessageIds: readonly string[] = []): Transcript {
  const turns = transcript.turns.filter((turn) => turn.index === index);
  const returnedTurns = turns.filter((turn) => turn.state !== "pending").length;
  return {
    view: {
      ...transcript.view,
      returnedTurns,
      omittedTurns: transcript.view.totalTurns - returnedTurns,
      firstTurnIncluded: turns.some((turn) => turn.index === 1 && turn.state !== "pending"),
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

function turnHeading(turn: TranscriptTurn): string {
  if (turn.state === "pending") return `## Queued${turn.queuePosition === null ? "" : ` · position ${turn.queuePosition}`}`;
  if (turn.imported) return `## Turn ${turn.index} · imported · ${time(turn.startedAt)}`;
  if (turn.inherited) return `## Turn ${turn.index} · inherited from ${turn.sourceThreadId} · ${time(turn.startedAt)}`;
  // `cancelled` is clearer than its `interrupted` state for a queued message that never ran.
  const state = turn.runStatus === "cancelled" ? "cancelled" : turn.state;
  return `## Turn ${turn.index}${state ? ` · ${state}` : ""} · ${time(turn.startedAt)}`;
}

/** Renders a transcript as compact Markdown that an agent can read directly. */
export function renderTranscript(transcript: Transcript): string {
  const sections: string[] = [];
  for (const turn of transcript.turns) {
    const parts = [turnHeading(turn)];
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
      const label =
        message.role === "reasoning" || message.role === "system"
          ? message.role
          : message.id === turn.finalMessageId
            ? turn.state === "running"
              ? "assistant (latest)"
              : "assistant (final)"
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
