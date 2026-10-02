import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "./config.js";
import { CliError } from "./errors.js";
import { runProcess } from "./process.js";
import {
  inspectThread,
  listThreads,
  readThread,
  sendThreadMessage,
  settleThread,
  unsettleThread,
} from "./service.js";
import type { CliConfig, T3Message, T3Project, T3Thread } from "./types.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk;
  return JSON.parse(body) as unknown;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function makeThread(id: string, overrides: Partial<T3Thread> = {}): T3Thread {
  return {
    id,
    projectId: "project-1",
    title: `Thread ${id}`,
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    session: null,
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
    archivedAt: null,
    settledAt: null,
    latestUserMessageAt: null,
    messages: [],
    deletedAt: null,
    ...overrides,
  };
}

async function testHarness(
  initialThreads: T3Thread[],
  options: { omitCapabilities?: boolean; threadSettlement?: boolean; respond?: boolean; omitShell?: boolean } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-threads-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await runProcess("git", ["init", "-b", "main"], { cwd: root });

  const mockT3 = path.join(root, "mock-t3.mjs");
  const authLog = path.join(root, "auth.log");
  await writeFile(
    mockT3,
    [
      `import { appendFileSync } from "node:fs";`,
      `const args = process.argv.slice(2);`,
      `appendFileSync(${JSON.stringify(authLog)}, JSON.stringify(args) + "\\n");`,
      `if (args.includes("issue")) process.stdout.write(JSON.stringify({sessionId:"mock-session",token:"mock-token"}));`,
      "",
    ].join("\n"),
    "utf8",
  );

  const project: T3Project = {
    id: "project-1",
    title: "Project One",
    workspaceRoot: await realpath(root),
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    deletedAt: null,
  };
  const projects = [project];
  const threads = initialThreads;
  const commands: Array<Record<string, unknown>> = [];
  const requests: string[] = [];
  let sequence = 10;
  const shell = () => ({
    snapshotSequence: sequence,
    projects,
    threads: threads.filter((thread) => thread.archivedAt == null && thread.deletedAt == null),
    updatedAt: new Date().toISOString(),
  });
  const full = () => ({
    snapshotSequence: sequence,
    projects,
    threads,
    updatedAt: new Date().toISOString(),
  });

  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/.well-known/t3/environment") {
      json(response, 200, {
        environmentId: "environment-1",
        serverVersion: "0.0.38",
        ...(options.omitCapabilities
          ? {}
          : { capabilities: { threadSettlement: options.threadSettlement ?? true } }),
      });
      return;
    }
    if (request.headers.authorization !== "Bearer mock-token") {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && request.url === "/api/orchestration/shell" && !options.omitShell) {
      json(response, 200, shell());
      return;
    }
    if (request.method === "GET" && request.url === "/api/orchestration/snapshot") {
      json(response, 200, full());
      return;
    }
    const detailMatch = request.url?.match(/^\/api\/orchestration\/threads\/([^?]+)/u);
    if (request.method === "GET" && detailMatch) {
      const threadId = decodeURIComponent(detailMatch[1]!);
      const thread = threads.find((candidate) => candidate.id === threadId && candidate.deletedAt == null);
      if (!thread) json(response, 404, { error: "not found" });
      else json(response, 200, { snapshotSequence: sequence, thread });
      return;
    }
    if (request.method === "POST" && request.url === "/api/orchestration/dispatch") {
      const command = (await bodyOf(request)) as Record<string, unknown>;
      commands.push(command);
      sequence += 2;
      if (command.type === "thread.turn.start") {
        const target = threads.find((thread) => thread.id === command.threadId)!;
        const message = command.message as T3Message & { messageId: string };
        const projectedMessage: T3Message = {
          id: message.messageId,
          role: "user",
          text: message.text,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt as string,
          updatedAt: command.createdAt as string,
        };
        target.messages = [...(target.messages ?? []), projectedMessage];
        target.updatedAt = command.createdAt as string;
        target.latestUserMessageAt = command.createdAt as string;
        target.settledAt = null;
        if (options.respond) {
          // An instant provider: the turn starts and completes with one reply.
          const turnId = `turn-${commands.length}`;
          const replyId = `reply-${commands.length}`;
          const repliedAt = new Date(Date.parse(command.createdAt as string) + 1_000).toISOString();
          target.messages.push({
            id: replyId,
            role: "assistant",
            text: `Reply to: ${message.text}`,
            turnId,
            streaming: false,
            createdAt: repliedAt,
            updatedAt: repliedAt,
          });
          target.latestTurn = {
            turnId,
            state: "completed",
            requestedAt: command.createdAt as string,
            startedAt: command.createdAt as string,
            completedAt: repliedAt,
            assistantMessageId: replyId,
          };
        }
      }
      if (command.type === "thread.settle") {
        const target = threads.find((thread) => thread.id === command.threadId)!;
        const updatedAt = new Date().toISOString();
        target.settledOverride = "settled";
        target.settledAt = updatedAt;
        target.unsettledAt = null;
        target.updatedAt = updatedAt;
      }
      if (command.type === "thread.unsettle") {
        const target = threads.find((thread) => thread.id === command.threadId)!;
        const updatedAt = new Date().toISOString();
        target.settledOverride = "active";
        target.settledAt = null;
        target.unsettledAt = updatedAt;
        target.updatedAt = updatedAt;
      }
      json(response, 200, { sequence });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");

  const origin = `http://127.0.0.1:${address.port}`;
  const stateDir = path.join(root, ".t3", "userdata");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "server-runtime.json"), JSON.stringify({
    version: 1,
    pid: process.pid,
    port: address.port,
    origin,
    startedAt: new Date().toISOString(),
  }), "utf8");

  const config: CliConfig = {
    ...DEFAULT_CONFIG,
    origin,
    t3Home: path.join(root, ".t3"),
    t3Command: [process.execPath, mockT3],
  };
  return { config, root, project, threads, commands, requests, authLog };
}

describe("thread discovery and messaging", () => {
  it("lists threads by project and active/settled status", async () => {
    const harness = await testHarness([
      makeThread("active", { updatedAt: "2026-09-04T12:00:00.000Z" }),
      makeThread("settled", { settledAt: "2026-09-04T11:00:00.000Z" }),
    ]);

    const active = await listThreads(harness.config, { project: "project-1", status: "active" });
    const settled = await listThreads(harness.config, { cwd: harness.root, status: "settled" });

    expect(active.threads.map((thread) => thread.id)).toEqual(["active"]);
    expect(settled.threads.map((thread) => thread.id)).toEqual(["settled"]);
    expect(settled.filter).toMatchObject({ projectId: "project-1", status: "settled" });
  });

  it("lists thread summaries when only the full snapshot is available", async () => {
    const harness = await testHarness(
      [makeThread("active", { messages: [{ id: "m", role: "user", text: "secret plan", turnId: null, streaming: false, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T10:00:00.000Z" }], activities: [{ kind: "tool.completed" }] })],
      { omitShell: true },
    );

    const result = await listThreads(harness.config);

    expect(result.threads.map((thread) => thread.id)).toEqual(["active"]);
    expect(result.threads[0]).not.toHaveProperty("messages");
    expect(result.threads[0]).not.toHaveProperty("activities");
  });

  it("filters by the current folder when --cwd is empty", async () => {
    const harness = await testHarness([makeThread("active")]);

    // The test runs outside the harness project, so filtering finds no project instead of listing everything.
    await expect(listThreads(harness.config, { cwd: "" })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("lists the main checkout's threads from a linked worktree", async () => {
    const harness = await testHarness([makeThread("target")]);
    await runProcess("git", [
      "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "--allow-empty", "-m", "Initial commit",
    ], { cwd: harness.root });
    const worktree = path.join(harness.root, "linked");
    await runProcess("git", ["worktree", "add", "-b", "feature/linked", worktree], { cwd: harness.root });

    const result = await listThreads(harness.config, { cwd: worktree });

    expect(result.filter.projectId).toBe(harness.project.id);
    expect(result.threads.map((thread) => thread.id)).toEqual(["target"]);
    expect(harness.commands).toHaveLength(0);
  });

  it("inspects an exact thread with its project", async () => {
    const harness = await testHarness([makeThread("target", {
      messages: [{
        id: "message-1",
        role: "user",
        text: "A".repeat(2_001),
        turnId: null,
        streaming: false,
        createdAt: "2026-09-04T10:00:00.000Z",
        updatedAt: "2026-09-04T10:00:00.000Z",
      }],
      activities: [{ large: "internal detail" }],
    })]);

    const result = await inspectThread(harness.config, "target");

    expect(result.thread).toMatchObject({
      id: "target",
      status: "active",
      messageCount: 1,
      recentMessages: [{ id: "message-1", textTruncated: true }],
    });
    expect(result.thread.recentMessages[0]?.text).toHaveLength(2_000);
    expect(result.thread).not.toHaveProperty("messages");
    expect(result.thread).not.toHaveProperty("activities");
    expect(result.project).toMatchObject({ id: "project-1", title: "Project One" });
    // Counts must cover the whole thread, so inspect reads it without a turn window.
    expect(harness.requests).toContain("GET /api/orchestration/threads/target");
  });

  it("reads every message with full text", async () => {
    const messages: T3Message[] = Array.from({ length: 8 }, (_, index) => ({
      id: `message-${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `${index + 1}: ${"A".repeat(2_500)}`,
      turnId: index % 2 === 0 ? null : `turn-${Math.ceil((index + 1) / 2)}`,
      streaming: false,
      createdAt: `2026-09-04T10:0${index}:00.000Z`,
      updatedAt: `2026-09-04T10:0${index}:00.000Z`,
    }));
    const harness = await testHarness([makeThread("target", {
      messages,
      activities: [{ large: "internal detail" }],
    })]);

    const result = await readThread(harness.config, "target");

    expect(result.thread.messageCount).toBe(8);
    expect(result.thread.messages).toEqual(
      messages.map((message, index) => ({ ...message, turnIndex: Math.floor(index / 2) + 1, textTruncated: false })),
    );
    expect(result.thread.view).toMatchObject({ detail: "messages", totalTurns: 4, returnedTurns: 4 });
    expect(result.thread.messages[0]?.text).toHaveLength(2_503);
    expect(result.thread).not.toHaveProperty("activities");
    expect(result.thread).not.toHaveProperty("recentMessages");
    expect(result.project).toMatchObject({ id: "project-1", title: "Project One" });
  });

  it("reads the latest turn with the prompt that started it", async () => {
    const message = (id: string, role: T3Message["role"], turnId: string | null, minute: number, text = id): T3Message => ({
      id,
      role,
      text,
      turnId,
      streaming: false,
      createdAt: `2026-09-04T10:0${minute}:00.000Z`,
      updatedAt: `2026-09-04T10:0${minute}:00.000Z`,
    });
    const harness = await testHarness([makeThread("target", {
      latestTurn: {
        turnId: "turn-latest",
        state: "completed",
        requestedAt: "2026-09-04T10:03:00.000Z",
        startedAt: "2026-09-04T10:03:00.000Z",
        completedAt: "2026-09-04T10:06:00.000Z",
        assistantMessageId: "answer-latest",
      },
      messages: [
        message("prompt-first", "user", null, 0),
        message("answer-first", "assistant", "turn-first", 1),
        message("prompt-latest", "user", null, 3),
        message("reasoning-latest", "system", "turn-latest", 4),
        message("progress-latest", "assistant", "turn-latest", 4, "A".repeat(2_500)),
        message("answer-latest", "assistant", "turn-latest", 6),
      ],
    })]);

    const latest = await readThread(harness.config, "target", { turns: 1 });
    expect(latest.thread.view).toMatchObject({ totalTurns: 2, returnedTurns: 1, omittedTurns: 1 });
    expect(latest.thread.turns).toMatchObject([
      { index: 2, turnId: "turn-latest", state: "completed", finalMessageId: "answer-latest" },
    ]);
    expect(latest.thread.messages.map((entry) => entry.id)).toEqual([
      "prompt-latest",
      "progress-latest",
      "answer-latest",
    ]);
    expect(latest.thread.messages[1]?.text).toHaveLength(2_500);

    const answers = await readThread(harness.config, "target", { turns: 1, firstTurn: true, detail: "answers" });
    expect(answers.thread.view.firstTurnIncluded).toBe(true);
    expect(answers.thread.messages.map((entry) => entry.id)).toEqual([
      "prompt-first",
      "answer-first",
      "prompt-latest",
      "answer-latest",
    ]);
  });

  it("sends and verifies a turn on an active thread", async () => {
    const harness = await testHarness([makeThread("target")]);

    const result = await sendThreadMessage(harness.config, {
      threadId: "target",
      prompt: "Review findings",
    });

    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: "target",
      message: { role: "user", text: "Review findings", attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    expect(result.verification).toMatchObject({ accepted: true, method: "message-id" });
  });

  it("sends a message and returns the reply turn", async () => {
    const harness = await testHarness([makeThread("target")], { respond: true });

    const result = await sendThreadMessage(harness.config, {
      threadId: "target",
      prompt: "Which tests fail?",
      wait: { timeoutMs: 600_000 },
    });

    expect(result.wait).toMatchObject({ outcome: "completed", turnIndex: 1, statusAfter: "active" });
    expect(result.reply?.messages.map((entry) => entry.text)).toEqual(["Reply to: Which tests fail?"]);
    expect(result.pendingRequests).toEqual([]);
    const authCalls = (await readFile(harness.authLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const issued = authCalls.find((args) => args.includes("issue"))!;
    // The session must outlive the wait; it is still revoked afterwards.
    expect(issued[issued.indexOf("--ttl") + 1]).toBe("12m");
    expect(authCalls.some((args) => args.includes("revoke"))).toBe(true);
  });

  it("requires confirmation before waking a settled thread", async () => {
    const harness = await testHarness([
      makeThread("settled", { settledAt: "2026-09-04T11:00:00.000Z" }),
    ]);

    await expect(sendThreadMessage(harness.config, {
      threadId: "settled",
      prompt: "New findings",
    })).rejects.toMatchObject({
      code: "SETTLED_THREAD_CONFIRMATION_REQUIRED",
      exitCode: 4,
    } satisfies Partial<CliError>);
    expect(harness.commands).toHaveLength(0);
  });

  it("allows an explicit settled-thread override", async () => {
    const harness = await testHarness([
      makeThread("settled", { settledAt: "2026-09-04T11:00:00.000Z" }),
    ]);

    const result = await sendThreadMessage(harness.config, {
      threadId: "settled",
      prompt: "New findings",
      wakeSettled: true,
    });

    expect(result.thread.statusBeforeSend).toBe("settled");
    expect(result.verification.accepted).toBe(true);
    expect(harness.commands).toHaveLength(1);
  });

  it("allows an approved settled-thread confirmation", async () => {
    const harness = await testHarness([
      makeThread("settled", { settledAt: "2026-09-04T11:00:00.000Z" }),
    ]);
    let confirmedProject: T3Project | null = null;

    const result = await sendThreadMessage(harness.config, {
      threadId: "settled",
      prompt: "Confirmed findings",
      confirmSettled: async (_thread, project) => {
        confirmedProject = project;
        return true;
      },
    });

    expect(confirmedProject).toMatchObject({ id: "project-1" });
    expect(result.verification.accepted).toBe(true);
    expect(harness.commands).toHaveLength(1);
  });

  it("rejects an archived thread", async () => {
    const harness = await testHarness([
      makeThread("archived", { archivedAt: "2026-09-04T11:00:00.000Z" }),
    ]);

    await expect(sendThreadMessage(harness.config, {
      threadId: "archived",
      prompt: "New findings",
      wakeSettled: true,
    })).rejects.toMatchObject({ code: "THREAD_ARCHIVED", exitCode: 4 } satisfies Partial<CliError>);
    expect(harness.commands).toHaveLength(0);
  });

  it("settles and verifies an active thread", async () => {
    const harness = await testHarness([makeThread("target")]);

    const result = await settleThread(harness.config, "target");

    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({ type: "thread.settle", threadId: "target" });
    expect(result.thread).toMatchObject({ statusBefore: "active", statusAfter: "settled" });
    expect(result.verification).toMatchObject({ accepted: true, state: "settled" });
  });

  it("unsettles and verifies a settled thread", async () => {
    const harness = await testHarness([
      makeThread("target", {
        settledOverride: "settled",
        settledAt: "2026-09-04T11:00:00.000Z",
      }),
    ]);

    const result = await unsettleThread(harness.config, "target");

    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.unsettle",
      threadId: "target",
      reason: "user",
    });
    expect(result.thread).toMatchObject({ statusBefore: "settled", statusAfter: "active" });
    expect(result.verification).toMatchObject({ accepted: true, state: "active" });
  });

  it.each([
    ["settle", settleThread, { omitCapabilities: true }],
    ["unsettle", unsettleThread, { threadSettlement: false }],
  ] as const)("refuses to %s when the capability is not explicitly supported", async (_name, change, options) => {
    const harness = await testHarness([
      makeThread("target", { settledAt: change === unsettleThread ? "2026-09-04T11:00:00.000Z" : null }),
    ], options);

    await expect(change(harness.config, "target")).rejects.toMatchObject({
      code: "THREAD_SETTLEMENT_UNSUPPORTED",
      exitCode: 4,
      details: { capability: "threadSettlement", serverVersion: "0.0.38" },
    } satisfies Partial<CliError>);
    expect(harness.commands).toHaveLength(0);
  });

  it("refuses to settle a thread while a message waits for its turn", async () => {
    const harness = await testHarness([makeThread("target", {
      latestTurn: {
        turnId: "turn-1",
        state: "completed",
        requestedAt: "2026-09-04T10:00:00.000Z",
        startedAt: "2026-09-04T10:00:00.000Z",
        completedAt: "2026-09-04T10:01:00.000Z",
        assistantMessageId: "answer",
      },
      session: { threadId: "target", status: "ready", providerName: "codex", runtimeMode: "full-access", activeTurnId: null, lastError: null, updatedAt: "2026-09-04T10:01:00.000Z" },
      messages: [
        { id: "prompt", role: "user", text: "Go", turnId: null, streaming: false, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T10:00:00.000Z" },
        { id: "answer", role: "assistant", text: "Done", turnId: "turn-1", streaming: false, createdAt: "2026-09-04T10:00:30.000Z", updatedAt: "2026-09-04T10:00:30.000Z" },
        { id: "queued", role: "user", text: "Next", turnId: null, streaming: false, createdAt: "2026-09-04T10:02:00.000Z", updatedAt: "2026-09-04T10:02:00.000Z" },
      ],
    })]);

    await expect(settleThread(harness.config, "target")).rejects.toMatchObject({
      code: "THREAD_SETTLE_BLOCKED",
      details: { queuedMessages: 1 },
    });
    expect(harness.commands).toEqual([]);
  });

  it("refuses to settle a thread with an active turn", async () => {
    const harness = await testHarness([
      makeThread("running", {
        session: {
          threadId: "running",
          status: "running",
          providerName: "codex",
          providerInstanceId: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1",
          lastError: null,
          updatedAt: "2026-09-04T11:00:00.000Z",
        },
      }),
    ]);

    await expect(settleThread(harness.config, "running")).rejects.toMatchObject({
      code: "THREAD_SETTLE_BLOCKED",
      exitCode: 4,
    } satisfies Partial<CliError>);
    expect(harness.commands).toHaveLength(0);
  });
});
