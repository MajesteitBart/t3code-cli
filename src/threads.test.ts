import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
  options: { omitCapabilities?: boolean; threadSettlement?: boolean } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-threads-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await runProcess("git", ["init", "-b", "main"], { cwd: root });

  const mockT3 = path.join(root, "mock-t3.mjs");
  await writeFile(
    mockT3,
    `const args = process.argv.slice(2);\nif (args.includes("issue")) process.stdout.write(JSON.stringify({sessionId:"mock-session",token:"mock-token"}));\n`,
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
    if (request.method === "GET" && request.url === "/api/orchestration/shell") {
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
  return { config, root, project, threads, commands };
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
    expect(result.thread.messages).toEqual(messages);
    expect(result.thread.messages[0]?.text).toHaveLength(2_503);
    expect(result.thread).not.toHaveProperty("activities");
    expect(result.thread).not.toHaveProperty("recentMessages");
    expect(result.project).toMatchObject({ id: "project-1", title: "Project One" });
  });

  it("filters a read to messages assigned to the latest turn", async () => {
    const messages: T3Message[] = [
      {
        id: "prompt-latest",
        role: "user",
        text: "Latest prompt",
        turnId: null,
        streaming: false,
        createdAt: "2026-09-04T10:00:00.000Z",
        updatedAt: "2026-09-04T10:00:00.000Z",
      },
      {
        id: "reply-previous",
        role: "assistant",
        text: "Previous reply",
        turnId: "turn-previous",
        streaming: false,
        createdAt: "2026-09-04T10:01:00.000Z",
        updatedAt: "2026-09-04T10:01:00.000Z",
      },
      {
        id: "reply-latest-1",
        role: "assistant",
        text: "A".repeat(2_500),
        turnId: "turn-latest",
        streaming: false,
        createdAt: "2026-09-04T10:02:00.000Z",
        updatedAt: "2026-09-04T10:02:00.000Z",
      },
      {
        id: "reply-latest-2",
        role: "assistant",
        text: "Latest final answer",
        turnId: "turn-latest",
        streaming: false,
        createdAt: "2026-09-04T10:03:00.000Z",
        updatedAt: "2026-09-04T10:03:00.000Z",
      },
    ];
    const harness = await testHarness([makeThread("target", {
      latestTurn: {
        turnId: "turn-latest",
        state: "completed",
        requestedAt: "2026-09-04T10:02:00.000Z",
        startedAt: "2026-09-04T10:02:00.000Z",
        completedAt: "2026-09-04T10:03:00.000Z",
        assistantMessageId: "reply-latest-2",
      },
      messages,
    })]);

    const result = await readThread(harness.config, "target", { lastTurn: true });

    expect(result.thread.messageFilter).toEqual({ scope: "last-turn", turnId: "turn-latest" });
    expect(result.thread.messageCount).toBe(2);
    expect(result.thread.messages.map((message) => message.id)).toEqual([
      "reply-latest-1",
      "reply-latest-2",
    ]);
    expect(result.thread.messages[0]?.text).toHaveLength(2_500);
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
