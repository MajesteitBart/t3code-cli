/**
 * An in-memory T3 server that speaks orchestration protocol 2, for tests. It serves the environment
 * descriptor, the HTTP reads, project mutations, WebSocket tickets, and the WebSocket RPCs the CLI
 * calls, and it applies the V2 commands the CLI dispatches to its own thread projections.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { WebSocketServer, type WebSocket } from "ws";

import { DEFAULT_CONFIG } from "../config.js";
import { runProcess } from "../process.js";
import type {
  CliConfig,
  ModelSelection,
  RunStatus,
  T3Message,
  T3Project,
  T3Run,
  T3RuntimeRequest,
  T3ThreadProjection,
  T3TurnItem,
} from "../types.js";

export type Command = { type: string; commandId: string; threadId?: string; [key: string]: unknown };
type RpcHandler = (payload: Record<string, unknown>, fake: FakeT3) => unknown | Promise<unknown>;

/** Thrown by an RPC handler to answer with this exact failure cause, such as a `Die` defect. */
export class FakeRpcFailure extends Error {
  constructor(readonly exitCause: unknown[]) {
    super("RPC failure");
  }
}

export interface FakeT3Options {
  serverVersion?: string;
  /** The orchestration protocol the server reports; 2 unless a test checks the refusal of 1. */
  protocol?: number;
  capabilities?: Record<string, unknown>;
  /** The `server.getConfig` providers; a Codex provider with two models by default. */
  providers?: unknown[];
  /**
   * `complete` (the default) finishes every started run at once with an assistant reply.
   * `hold` leaves started runs running until a test finishes them.
   */
  runBehavior?: "complete" | "hold";
  /** Limits `/bounded` reads to the last this many timeline items and messages. */
  boundedTurnItems?: number;
  /** Overrides or adds WebSocket RPC handlers by tag. */
  rpcHandlers?: Record<string, RpcHandler>;
  /** Runs before the built-in reducer; return a string to reject the command with that message. */
  onCommand?: (command: Command, fake: FakeT3) => string | void;
  /** Initialises the git repository the tests work in. */
  gitRepo?: boolean;
  /** Commit one dispatch, then drop its reply to model an ambiguous transport failure. */
  loseNextDispatchResponse?: boolean;
}

export interface FakeT3 {
  root: string;
  origin: string;
  config: CliConfig;
  projects: T3Project[];
  threads: Map<string, T3ThreadProjection>;
  commands: Command[];
  rpcCalls: Array<{ tag: string; payload: Record<string, unknown> }>;
  httpRequests: Array<{ method: string; url: string; protocolHeader: string | undefined }>;
  /** The path and query of every WebSocket upgrade request, accepted or not. */
  wsUpgrades: string[];
  scheduledTasks: Array<Record<string, unknown>>;
  options: FakeT3Options;
  sequence: number;
  /** Adds a project, defaulting its workspace root to the test folder. */
  addProject(project?: Partial<T3Project>): T3Project;
  /** Adds a thread projection; `turns` adds that many completed prompt/answer runs. */
  addThread(overrides?: Partial<T3ThreadProjection["thread"]> & { turns?: number }): T3ThreadProjection;
  projection(threadId: string): T3ThreadProjection;
  /** Starts a run for a user message, as `message.dispatch` with `start_immediately` does. */
  startRun(threadId: string, text: string, options?: { messageId?: string; status?: RunStatus }): T3Run;
  completeRun(threadId: string, runId: string, reply?: string, status?: RunStatus): void;
  addApproval(threadId: string, runId: string, options?: { prompt?: string; options?: string[]; capability?: T3RuntimeRequest["responseCapability"]["type"] }): T3RuntimeRequest;
  addQuestion(
    threadId: string,
    runId: string,
    questions: Array<{ id: string; header: string; question: string; options?: Array<{ label: string; description?: string; value?: string }>; multiSelect?: boolean }>,
    options?: { capability?: T3RuntimeRequest["responseCapability"]["type"] },
  ): T3RuntimeRequest;
  close(): Promise<void>;
}

const now = () => new Date().toISOString();

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk;
  return JSON.parse(body) as Record<string, unknown>;
}

export const DEFAULT_PROVIDERS = [
  {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    status: "ready",
    showInteractionModeToggle: true,
    models: [
      {
        slug: "gpt-6-astra",
        name: "GPT-6 Astra",
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              type: "select",
              options: [{ id: "low" }, { id: "medium", isDefault: true }, { id: "high" }, { id: "xhigh" }],
            },
            { id: "serviceTier", type: "select", options: [{ id: "default", isDefault: true }, { id: "priority" }] },
          ],
        },
      },
      {
        slug: "gpt-6-luna",
        name: "GPT-6 Luna",
        capabilities: {
          optionDescriptors: [
            { id: "reasoningEffort", type: "select", options: [{ id: "low" }, { id: "medium", isDefault: true }] },
          ],
        },
      },
    ],
  },
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    status: "ready",
    showInteractionModeToggle: true,
    models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", isDefault: true, capabilities: { optionDescriptors: [] } }],
  },
];

export async function startFakeT3(options: FakeT3Options = {}): Promise<FakeT3> {
  const root = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-fake-"));
  if (options.gitRepo !== false) await runProcess("git", ["init", "-b", "main"], { cwd: root });
  const mockT3 = path.join(root, "mock-t3.mjs");
  await writeFile(
    mockT3,
    `const args = process.argv.slice(2);\nif (args.includes("issue")) process.stdout.write(JSON.stringify({sessionId:"mock-session",token:"mock-token"}));\n`,
    "utf8",
  );

  const tickets = new Set<string>();
  const sockets = new Set<WebSocket>();
  const fake = {} as FakeT3;

  const bump = (projection: T3ThreadProjection) => {
    fake.sequence += 1;
    projection.thread.updatedAt = now();
  };

  const runOf = (projection: T3ThreadProjection, runId: string) => {
    const run = projection.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Target run ${runId} was not found.`);
    return run;
  };

  const startNextQueued = (projection: T3ThreadProjection) => {
    if (projection.runs.some((run) => ["preparing", "starting", "running", "waiting"].includes(run.status))) return;
    const next = projection.runs
      .filter((run) => run.status === "queued" && !run.queueHeld)
      .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))[0];
    if (!next) return;
    next.status = "running";
    next.startedAt = now();
    next.queuePosition = null;
    for (const run of projection.runs) if (run.status === "queued" && run.queuePosition) run.queuePosition -= 1;
    if ((options.runBehavior ?? "complete") === "complete") fake.completeRun(projection.thread.id, next.id);
  };

  fake.root = root;
  fake.projects = [];
  fake.threads = new Map();
  fake.commands = [];
  fake.rpcCalls = [];
  fake.httpRequests = [];
  fake.wsUpgrades = [];
  fake.scheduledTasks = [];
  fake.options = options;
  fake.sequence = 0;

  fake.addProject = (project = {}) => {
    const value: T3Project = {
      id: project.id ?? randomUUID(),
      title: project.title ?? path.basename(root),
      workspaceRoot: project.workspaceRoot ?? root,
      defaultModelSelection: project.defaultModelSelection ?? null,
      defaultThreadEnvMode: project.defaultThreadEnvMode ?? null,
      deletedAt: null,
      scripts: [],
      createdAt: now(),
      updatedAt: now(),
      ...project,
    };
    fake.projects.push(value);
    return value;
  };

  fake.addThread = (overrides = {}) => {
    const { turns = 0, ...threadOverrides } = overrides;
    const id = threadOverrides.id ?? randomUUID();
    const projection: T3ThreadProjection = {
      thread: {
        id,
        projectId: threadOverrides.projectId ?? fake.projects[0]?.id ?? "project-1",
        title: `Thread ${id.slice(0, 8)}`,
        modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: "2026-10-01T10:00:00.000Z",
        updatedAt: "2026-10-01T10:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        forkedFrom: null,
        ...threadOverrides,
      },
      runs: [],
      runtimeRequests: [],
      messages: [],
      turnItems: [],
      plans: [],
      checkpoints: [],
      updatedAt: now(),
    };
    fake.threads.set(id, projection);
    for (let index = 0; index < turns; index += 1) {
      const run = fake.startRun(id, `Prompt ${index + 1}`);
      if (run.status !== "completed") fake.completeRun(id, run.id, `Answer ${index + 1}`);
    }
    return projection;
  };

  fake.projection = (threadId) => {
    const projection = fake.threads.get(threadId);
    if (!projection) throw new Error(`Thread '${threadId}' does not exist.`);
    return projection;
  };

  fake.startRun = (threadId, text, runOptions = {}) => {
    const projection = fake.projection(threadId);
    const ordinal = projection.runs.length + 1;
    const messageId = runOptions.messageId ?? randomUUID();
    const status = runOptions.status ?? "running";
    const at = now();
    const queued = projection.runs.filter((run) => run.status === "queued").length;
    const run: T3Run = {
      id: `run:${threadId}:ordinal:${ordinal}`,
      threadId,
      ordinal,
      providerInstanceId: projection.thread.modelSelection?.instanceId ?? "codex",
      modelSelection: projection.thread.modelSelection!,
      userMessageId: messageId,
      rootNodeId: `node:${ordinal}`,
      status,
      queuePosition: status === "queued" ? queued + 1 : null,
      requestedAt: at,
      startedAt: status === "queued" ? null : at,
      completedAt: null,
      checkpointId: null,
    };
    projection.runs.push(run);
    const message: T3Message = { id: messageId, runId: run.id, role: "user", text, streaming: false, createdAt: at, updatedAt: at };
    projection.messages.push(message);
    projection.turnItems.push({ id: `item:${messageId}`, type: "user_message", runId: run.id, status: "completed", messageId, text, startedAt: at, updatedAt: at });
    bump(projection);
    if (status === "running" && (options.runBehavior ?? "complete") === "complete") fake.completeRun(threadId, run.id);
    return run;
  };

  fake.completeRun = (threadId, runId, reply, status = "completed") => {
    const projection = fake.projection(threadId);
    const run = runOf(projection, runId);
    const at = now();
    const userText = projection.messages.find((message) => message.id === run.userMessageId)?.text ?? "";
    const text = reply ?? `Reply to: ${userText}`;
    const messageId = randomUUID();
    projection.messages.push({ id: messageId, runId, role: "assistant", text, streaming: false, createdAt: at, updatedAt: at });
    projection.turnItems.push({ id: `item:${messageId}`, type: "assistant_message", runId, status: "completed", messageId, text, startedAt: at, updatedAt: at });
    run.status = status;
    run.completedAt = at;
    bump(projection);
    startNextQueued(projection);
  };

  const addRequest = (
    threadId: string,
    runId: string,
    kind: string,
    capability: T3RuntimeRequest["responseCapability"]["type"],
    item: Omit<T3TurnItem, "id" | "runId" | "requestId">,
  ) => {
    const projection = fake.projection(threadId);
    const at = now();
    const request: T3RuntimeRequest = {
      id: `runtime-request:${randomUUID()}`,
      nodeId: `node:${runId}`,
      kind,
      status: "pending",
      responseCapability: capability === "live" ? { type: "live", providerSessionId: "session-1" } : capability === "message" ? { type: "message" } : { type: "not_resumable", reason: "gone" },
      createdAt: at,
      resolvedAt: null,
    };
    projection.runtimeRequests.push(request);
    projection.turnItems.push({ ...item, id: `item:${request.id}`, runId, requestId: request.id, startedAt: at, updatedAt: at } as unknown as T3TurnItem);
    bump(projection);
    return request;
  };

  fake.addApproval = (threadId, runId, approval = {}) =>
    addRequest(threadId, runId, "command", approval.capability ?? "live", {
      type: "approval_request",
      status: "running",
      requestKind: "command",
      prompt: approval.prompt ?? "git status",
      options: (approval.options ?? ["accept", "acceptForSession", "decline", "cancel"]).map((decision) => ({ decision, label: decision })),
    });

  fake.addQuestion = (threadId, runId, questions, question = {}) =>
    addRequest(threadId, runId, "user_input", question.capability ?? "live", {
      type: "user_input_request",
      status: "running",
      questions: questions.map((entry) => ({
        ...entry,
        options: (entry.options ?? []).map((option) => ({ description: option.label, ...option })),
      })),
      ...(question.capability === "message" ? { responseMode: "message" } : {}),
    });

  const applyCommand = (command: Command): void => {
    const rejection = options.onCommand?.(command, fake);
    if (typeof rejection === "string") throw new Error(rejection);
    const projection = command.threadId ? fake.projection(command.threadId) : null;
    const thread = projection?.thread;
    switch (command.type) {
      case "message.dispatch": {
        const mode = command.dispatchMode as { type: string; targetRunId?: string };
        const messageId = command.messageId as string;
        const text = command.text as string;
        if (mode.type === "start_immediately") {
          fake.startRun(command.threadId!, text, { messageId });
        } else if (mode.type === "queue_after_active") {
          fake.startRun(command.threadId!, text, { messageId, status: "queued" });
        } else if (mode.type === "steer_active") {
          const run = runOf(projection!, mode.targetRunId!);
          const at = now();
          projection!.messages.push({ id: messageId, runId: run.id, role: "user", text, streaming: false, createdAt: at, updatedAt: at });
        } else if (mode.type === "restart_active") {
          const run = runOf(projection!, mode.targetRunId!);
          run.status = "interrupted";
          run.completedAt = now();
          fake.startRun(command.threadId!, text, { messageId });
        } else {
          throw new Error(`Unsupported dispatch mode ${mode.type}.`);
        }
        if (thread && thread.settledAt != null) {
          thread.settledAt = null;
          thread.settledOverride = null;
        }
        break;
      }
      case "run.interrupt": {
        const run = runOf(projection!, command.runId as string);
        run.status = "interrupted";
        run.completedAt = now();
        startNextQueued(projection!);
        break;
      }
      case "runtime-request.respond":
      case "thread.user-input.dismiss": {
        const request = projection!.runtimeRequests.find((candidate) => candidate.id === command.requestId);
        if (!request) throw new Error(`Runtime request ${String(command.requestId)} was not found.`);
        request.status = command.type === "thread.user-input.dismiss" ? "cancelled" : "resolved";
        request.resolvedAt = now();
        if (command.decision) request.decision = command.decision as string;
        if (command.answers) request.answers = command.answers as Record<string, unknown>;
        if (command.answers && request.responseCapability.type === "message") {
          fake.startRun(command.threadId!, `Answers: ${JSON.stringify(command.answers)}`);
        } else if (command.type === "runtime-request.respond" && (options.runBehavior ?? "complete") === "complete") {
          const item = projection!.turnItems.find((candidate) => candidate.requestId === request.id);
          const run = item?.runId ? projection!.runs.find((candidate) => candidate.id === item.runId) : null;
          if (run && ["running", "waiting"].includes(run.status)) fake.completeRun(command.threadId!, run.id);
        }
        break;
      }
      case "thread.settle":
        thread!.settledAt = now();
        thread!.settledOverride = "settled";
        break;
      case "thread.unsettle":
        thread!.settledAt = null;
        thread!.settledOverride = "active";
        thread!.unsettledAt = now();
        break;
      case "thread.model-selection.set":
      case "provider.switch":
        thread!.modelSelection = command.modelSelection as ModelSelection;
        break;
      case "thread.runtime-mode.set":
        thread!.runtimeMode = command.runtimeMode as NonNullable<T3ThreadProjection["thread"]["runtimeMode"]>;
        break;
      case "thread.interaction-mode.set":
        thread!.interactionMode = command.interactionMode as NonNullable<T3ThreadProjection["thread"]["interactionMode"]>;
        break;
      case "thread.metadata.update":
        if (typeof command.title === "string") thread!.title = command.title;
        break;
      case "thread.pin":
        thread!.pinnedAt = now();
        break;
      case "thread.unpin":
        thread!.pinnedAt = null;
        break;
      case "thread.snooze":
        thread!.snoozedUntil = command.snoozedUntil as string;
        break;
      case "thread.unsnooze":
        thread!.snoozedUntil = null;
        break;
      case "thread.archive":
        thread!.archivedAt = now();
        break;
      case "thread.unarchive":
        thread!.archivedAt = null;
        break;
      case "thread.delete":
        thread!.deletedAt = now();
        break;
      case "queue.resume":
        for (const run of projection!.runs) run.queueHeld = false;
        startNextQueued(projection!);
        break;
      case "queued-run.cancel": {
        const run = runOf(projection!, command.runId as string);
        run.status = "cancelled";
        run.queuePosition = null;
        break;
      }
      case "queued-run.edit": {
        const run = runOf(projection!, command.runId as string);
        const message = projection!.messages.find((candidate) => candidate.id === run.userMessageId);
        if (message) message.text = command.text as string;
        break;
      }
      case "queued-run.reorder": {
        const queued = projection!.runs.filter((run) => run.status === "queued").sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
        const moving = runOf(projection!, command.runId as string);
        const rest = queued.filter((run) => run.id !== moving.id);
        const before = command.beforeRunId === null ? rest.length : rest.findIndex((run) => run.id === command.beforeRunId);
        rest.splice(before < 0 ? rest.length : before, 0, moving);
        rest.forEach((run, index) => (run.queuePosition = index + 1));
        break;
      }
      case "queued-message.promote-to-steer": {
        const queued = runOf(projection!, command.queuedRunId as string);
        const target = runOf(projection!, command.targetRunId as string);
        queued.status = "cancelled";
        const message = projection!.messages.find((candidate) => candidate.id === queued.userMessageId);
        if (message) message.runId = target.id;
        break;
      }
      case "thread.fork": {
        const source = fake.projection(command.sourceThreadId as string);
        fake.addThread({
          id: command.targetThreadId as string,
          projectId: source.thread.projectId,
          title: (command.title as string | undefined) ?? `Fork of ${source.thread.title}`,
          modelSelection: source.thread.modelSelection!,
          forkedFrom: { type: "run", threadId: source.thread.id, runId: source.runs.at(-1)?.id ?? "" },
        });
        break;
      }
      case "thread.merge_back":
        fake.projection(command.sourceThreadId as string);
        fake.projection(command.targetThreadId as string);
        break;
      default:
        throw new Error(`The fake T3 server does not handle ${command.type}.`);
    }
    if (projection) bump(projection);
    else fake.sequence += 1;
  };

  const shellThread = (projection: T3ThreadProjection) => {
    const active = projection.runs.findLast((run) => ["preparing", "starting", "running", "waiting"].includes(run.status));
    const latest = projection.runs.at(-1);
    const pending = projection.runtimeRequests.find((request) => request.status === "pending");
    return {
      ...projection.thread,
      status: active?.status ?? latest?.status ?? "idle",
      activeRunId: active?.id ?? null,
      latestRunId: latest?.id ?? null,
      pendingRuntimeRequest: pending ? { id: pending.id, kind: pending.kind, createdAt: pending.createdAt } : null,
    };
  };

  const receipts = new Map<string, { threadId: string | undefined; status: "accepted" | "rejected"; sequence: number; error?: string }>();
  const builtInRpc: Record<string, RpcHandler> = {
    "orchestration.dispatchCommand": (payload) => {
      const command = payload as Command;
      const receipt = receipts.get(command.commandId);
      if (receipt) {
        if (receipt.threadId !== command.threadId) throw new Error("OrchestrationCommandIdConflictError");
        if (receipt.status === "rejected") throw new Error(`OrchestrationCommandPreviouslyRejectedError: ${receipt.error}`);
        return { sequence: receipt.sequence };
      }
      try {
        applyCommand(command);
      } catch (cause) {
        receipts.set(command.commandId, { threadId: command.threadId, status: "rejected", sequence: fake.sequence, error: String(cause) });
        throw cause;
      }
      receipts.set(command.commandId, { threadId: command.threadId, status: "accepted", sequence: fake.sequence });
      fake.commands.push(payload as Command);
      return { sequence: fake.sequence };
    },
    "orchestration.launchThread": (payload) => {
      const threadId = (payload.threadId as string | undefined) ?? `thread:project:${String(payload.projectId)}:${randomUUID()}`;
      fake.commands.push({ type: "launch", commandId: payload.commandId as string, ...payload });
      if (fake.threads.has(threadId)) return { threadId, resumed: true, projection: fake.projection(threadId) };
      const strategy = payload.workspaceStrategy as { type: string; worktreePath?: string; branch?: string };
      fake.addThread({
        id: threadId,
        projectId: payload.projectId as string,
        title: payload.title as string,
        modelSelection: payload.modelSelection as ModelSelection,
        runtimeMode: payload.runtimeMode as NonNullable<T3ThreadProjection["thread"]["runtimeMode"]>,
        interactionMode: payload.interactionMode as NonNullable<T3ThreadProjection["thread"]["interactionMode"]>,
        worktreePath: strategy.type === "existing_worktree" ? strategy.worktreePath! : strategy.type === "worktree" ? path.join(root, "worktree") : null,
        // T3 records the branch the launch names, or none.
        branch: strategy.branch ?? null,
      });
      const initial = payload.initialMessage as { messageId?: string; text: string } | undefined;
      if (initial) fake.startRun(threadId, initial.text, initial.messageId ? { messageId: initial.messageId } : {});
      return { threadId, resumed: false, projection: fake.projection(threadId) };
    },
    "server.getConfig": () => ({ providers: options.providers ?? DEFAULT_PROVIDERS }),
    "orchestration.searchThreads": (payload) => ({
      matches: [...fake.threads.values()].flatMap((projection) =>
        projection.messages
          .filter((message) => message.text.toLowerCase().includes(String(payload.query).toLowerCase()))
          .slice(0, 1)
          .map((message) => ({
            threadId: projection.thread.id,
            projectId: projection.thread.projectId,
            source: "message",
            snippet: message.text.slice(0, 240),
            messageCreatedAt: message.createdAt,
          })),
      ),
    }),
    "scheduledTasks.list": () => ({ tasks: fake.scheduledTasks }),
    "scheduledTasks.upsert": (payload) => {
      const existing = payload.id ? fake.scheduledTasks.find((task) => task.id === payload.id) : undefined;
      if (payload.requireExisting && !existing) throw new Error("Scheduled task not found.");
      const task = {
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: "never",
        lastRunError: null,
        runCount: 0,
        createdBy: "user",
        creationSource: "web",
        createdAt: now(),
        ...existing,
        ...payload,
        id: (payload.id as string | undefined) ?? `scheduled-task:${randomUUID()}`,
        threadId: payload.threadId ?? null,
        updatedAt: now(),
      };
      if (existing) fake.scheduledTasks.splice(fake.scheduledTasks.indexOf(existing), 1, task);
      else fake.scheduledTasks.push(task);
      return { task };
    },
    "scheduledTasks.setEnabled": (payload) => {
      const task = fake.scheduledTasks.find((candidate) => candidate.id === payload.id);
      if (!task) throw new Error("Scheduled task not found.");
      task.enabled = payload.enabled;
      return { task };
    },
    "scheduledTasks.delete": (payload) => {
      const index = fake.scheduledTasks.findIndex((candidate) => candidate.id === payload.id);
      if (index < 0) throw new Error("Scheduled task not found.");
      fake.scheduledTasks.splice(index, 1);
      return { id: payload.id };
    },
    "scheduledTasks.runNow": (payload) => {
      const task = fake.scheduledTasks.find((candidate) => candidate.id === payload.id);
      if (!task) throw new Error("Scheduled task not found.");
      task.runCount = (task.runCount as number) + 1;
      task.lastRunStatus = "succeeded";
      return { task };
    },
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const protocolHeader = request.headers["x-t3-orchestration-protocol"] as string | undefined;
    fake.httpRequests.push({ method: request.method ?? "GET", url: url.pathname + url.search, protocolHeader });
    if (url.pathname === "/.well-known/t3/environment") {
      json(response, 200, {
        environmentId: "environment-1",
        serverVersion: options.serverVersion ?? "0.0.46-nightly.20261003.2600",
        orchestrationProtocolVersion: options.protocol ?? 2,
        capabilities: options.capabilities ?? { threadSettlement: true },
      });
      return;
    }
    if (request.headers.authorization !== "Bearer mock-token") {
      json(response, 401, { _tag: "EnvironmentAuthInvalidError", code: "auth_invalid" });
      return;
    }
    if (url.pathname.startsWith("/api/orchestration/") && protocolHeader !== "2") {
      json(response, 400, { error: "missing orchestration protocol" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/orchestration/shell") {
      const visible = [...fake.threads.values()].filter((projection) => projection.thread.deletedAt == null);
      json(response, 200, {
        schemaVersion: 1,
        snapshotSequence: fake.sequence,
        projects: fake.projects.filter((project) => project.deletedAt == null),
        threads: visible.filter((projection) => projection.thread.archivedAt == null).map(shellThread),
        archivedThreads: visible.filter((projection) => projection.thread.archivedAt != null).map(shellThread),
      });
      return;
    }
    const detail = url.pathname.match(/^\/api\/orchestration\/threads\/([^/]+)(\/bounded)?$/u);
    if (request.method === "GET" && detail) {
      const projection = fake.threads.get(decodeURIComponent(detail[1]!));
      if (!projection || projection.thread.deletedAt != null) {
        json(response, 404, { _tag: "EnvironmentResourceNotFoundError" });
        return;
      }
      // Like T3, the bounded read keeps every run and request but only a recent window of the timeline.
      const limit = options.boundedTurnItems;
      const windowed =
        detail[2] && limit !== undefined
          ? { ...projection, turnItems: projection.turnItems.slice(-limit), messages: projection.messages.slice(-limit) }
          : projection;
      json(response, 200, { snapshotSequence: fake.sequence, projection: windowed });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      json(response, 200, { projects: fake.projects.filter((project) => project.deletedAt == null), updatedAt: now() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/projects/mutate") {
      const mutation = await bodyOf(request);
      fake.commands.push(mutation as Command);
      if (mutation.type !== "project.create") {
        json(response, 400, { error: `unsupported ${String(mutation.type)}` });
        return;
      }
      const project = fake.addProject({
        id: mutation.projectId as string,
        title: mutation.title as string,
        workspaceRoot: mutation.workspaceRoot as string,
        defaultModelSelection: (mutation.defaultModelSelection as ModelSelection | undefined) ?? null,
      });
      json(response, 200, project);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/websocket-ticket") {
      const ticket = randomUUID();
      tickets.add(ticket);
      json(response, 200, { ticket, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      return;
    }
    json(response, 404, { error: "not found" });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://fake");
    fake.wsUpgrades.push(url.pathname + url.search);
    if (url.searchParams.get("orchestrationProtocol") !== "2") {
      socket.end("HTTP/1.1 426 Upgrade Required\r\n\r\n");
      return;
    }
    const ticket = url.searchParams.get("wsTicket") ?? "";
    if (!tickets.delete(ticket)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.on("message", async (data) => {
        const message = JSON.parse(String(data)) as { _tag: string; id: string; tag: string; payload: Record<string, unknown> };
        if (message._tag !== "Request") return;
        fake.rpcCalls.push({ tag: message.tag, payload: message.payload });
        const handler = options.rpcHandlers?.[message.tag] ?? builtInRpc[message.tag];
        try {
          if (!handler) throw new Error(`Unknown RPC ${message.tag}.`);
          const value = await handler(message.payload, fake);
          if (message.tag === "orchestration.dispatchCommand" && options.loseNextDispatchResponse) {
            options.loseNextDispatchResponse = false;
            client.terminate();
            return;
          }
          client.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value } }));
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          const cause =
            error instanceof FakeRpcFailure
              ? error.exitCause
              : [{ _tag: "Fail", error: { _tag: "OrchestrationV2DispatchCommandError", message: text, detail: text } }];
          client.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit: { _tag: "Failure", cause } }));
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake T3 server has no port.");
  fake.origin = `http://127.0.0.1:${address.port}`;
  fake.config = {
    ...DEFAULT_CONFIG,
    origin: fake.origin,
    t3Home: path.join(root, "t3-home"),
    t3Command: [process.execPath, mockT3],
    openMode: "none",
  };
  fake.close = async () => {
    for (const socket of sockets) socket.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  return fake;
}
