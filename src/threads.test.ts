import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runProcess } from "./process.js";
import {
  inspectThread,
  listThreads,
  readThread,
  sendThreadMessage,
  settleThread,
  unsettleThread,
  waitForThread,
  type IfBusy,
} from "./service.js";
import { startFakeT3, type FakeT3, type FakeT3Options } from "./testing/fakeT3.js";
import type { T3Project } from "./types.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function fakeT3(options: FakeT3Options = {}): Promise<{ fake: FakeT3; project: T3Project }> {
  const fake = await startFakeT3(options);
  cleanup.push(() => fake.close());
  const project = fake.addProject({ id: "project-1", title: "Project One", workspaceRoot: await realpath(fake.root) });
  return { fake, project };
}

const orchestrationReads = (fake: FakeT3) =>
  fake.httpRequests.map((request) => request.url).filter((url) => url.startsWith("/api/orchestration/threads/"));

function messageDispatches(fake: FakeT3) {
  return fake.commands.filter((command) => command.type === "message.dispatch");
}

describe("listThreads", () => {
  it("lists threads by project and lifecycle status, newest first, without archived ones", async () => {
    const { fake, project } = await fakeT3({ runBehavior: "hold" });
    const other = fake.addProject({ id: "project-2", title: "Other" });
    const active = fake.addThread({ id: "active", title: "Active" }).thread;
    fake.startRun(active.id, "Working");
    active.updatedAt = "2026-10-01T12:00:00.000Z";
    fake.addThread({ id: "settled", settledAt: "2026-10-01T11:30:00.000Z", settledOverride: "settled", updatedAt: "2026-10-01T11:00:00.000Z" });
    fake.addThread({ id: "archived", archivedAt: "2026-10-01T11:00:00.000Z" });
    fake.addThread({ id: "elsewhere", projectId: other.id, updatedAt: "2026-10-01T13:00:00.000Z" });

    const activeOnly = await listThreads(fake.config, { project: project.id, status: "active" });
    const settled = await listThreads(fake.config, { cwd: fake.root, status: "settled" });
    const everything = await listThreads(fake.config);

    expect(activeOnly.threads.map(({ id, status, runStatus }) => ({ id, status, runStatus }))).toEqual([
      { id: "active", status: "active", runStatus: "running" },
    ]);
    expect(settled.threads.map(({ id, status, runStatus }) => ({ id, status, runStatus }))).toEqual([
      { id: "settled", status: "settled", runStatus: "idle" },
    ]);
    expect(settled.filter).toEqual({ status: "settled", projectId: project.id, workspaceRoot: await realpath(fake.root) });
    expect(everything.threads.map((thread) => thread.id)).toEqual(["elsewhere", "active", "settled"]);
    expect(everything.filter).toEqual({ status: "all", projectId: null, workspaceRoot: null });
    expect(everything.snapshotSequence).toBe(fake.sequence);
    expect(fake.httpRequests.find((request) => request.url === "/api/orchestration/shell")?.protocolHeader).toBe("2");
  });

  it("filters by the current folder when --cwd is empty", async () => {
    const { fake } = await fakeT3();
    fake.addThread();

    // The tests run outside the fake's project, so filtering finds no project instead of listing everything.
    await expect(listThreads(fake.config, { cwd: "" })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND", exitCode: 3 });
  });

  it("refuses conflicting or empty filters and unknown projects", async () => {
    const { fake } = await fakeT3();

    await expect(listThreads(fake.config, { project: "project-1", cwd: fake.root })).rejects.toMatchObject({
      code: "THREAD_FILTER_CONFLICT",
      exitCode: 2,
    });
    await expect(listThreads(fake.config, { project: "  " })).rejects.toMatchObject({ code: "PROJECT_ID_REQUIRED", exitCode: 2 });
    await expect(listThreads(fake.config, { project: "missing" })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
      message: "No active T3 Code project exists with id missing.",
    });
  });

  it("lists the main checkout's threads from a linked worktree", async () => {
    const { fake, project } = await fakeT3();
    fake.addThread({ id: "target" });
    await runProcess("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"], {
      cwd: fake.root,
    });
    const parent = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-worktree-"));
    cleanup.push(() => rm(parent, { recursive: true, force: true }));
    const worktree = path.join(parent, "linked");
    await runProcess("git", ["worktree", "add", "-b", "feature/linked", worktree], { cwd: fake.root });

    const result = await listThreads(fake.config, { cwd: worktree });

    expect(result.filter.projectId).toBe(project.id);
    expect(result.threads.map((thread) => thread.id)).toEqual(["target"]);
    expect(fake.commands).toEqual([]);
  });
});

describe("inspectThread", () => {
  it("summarizes the thread's runs, queue, requests, and recent messages", async () => {
    const { fake } = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread({ id: "target", turns: 1 });
    const running = fake.startRun(thread.id, "A".repeat(2_001));
    const queued = fake.startRun(thread.id, `Queued ${"q".repeat(300)}`, { status: "queued" });
    const approval = fake.addApproval(thread.id, running.id, { prompt: "git push" });

    const result = await inspectThread(fake.config, "target");

    expect(result.project).toMatchObject({ id: "project-1", title: "Project One" });
    expect(result.thread).toMatchObject({
      id: "target",
      status: "active",
      runStatus: "running",
      activeRun: { runId: running.id, ordinal: 2, status: "running", completedAt: null },
      latestRun: { runId: queued.id, ordinal: 3, status: "queued", startedAt: null },
      turnCount: 2,
      messageCount: 4,
      pendingRequests: [{ kind: "approval", requestId: approval.id, detail: "git push", blocking: true }],
    });
    expect(result.thread.queue).toEqual([
      { runId: queued.id, position: 1, held: false, text: expect.stringMatching(/^Queued q+/u), textTruncated: true, requestedAt: queued.requestedAt },
    ]);
    expect(result.thread.queue[0]?.text).toHaveLength(200);
    const long = result.thread.recentMessages.find((entry) => entry.turnId === running.id && entry.role === "user");
    expect(long).toMatchObject({ textTruncated: true });
    expect(long?.text).toHaveLength(2_000);
    expect(long?.text.endsWith("…")).toBe(true);
    expect(result.thread).not.toHaveProperty("messages");
    expect(result.thread).not.toHaveProperty("turnItems");
    // Counts must cover the whole thread, so inspect reads it without a window.
    expect(orchestrationReads(fake)).toEqual(["/api/orchestration/threads/target"]);
  });

  it("refuses an unknown or blank thread id", async () => {
    const { fake } = await fakeT3();

    await expect(inspectThread(fake.config, "missing")).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
      exitCode: 3,
      details: { threadId: "missing" },
    });
    await expect(inspectThread(fake.config, "  ")).rejects.toMatchObject({ code: "THREAD_ID_REQUIRED", exitCode: 2 });
  });
});

describe("readThread", () => {
  it("reads a window of turns from the whole thread", async () => {
    const { fake } = await fakeT3();
    const { thread } = fake.addThread({ id: "target", turns: 3 });

    const latest = await readThread(fake.config, thread.id, { turns: 1, firstTurn: true, detail: "answers" });

    expect(latest.thread.view).toMatchObject({ detail: "answers", totalTurns: 3, returnedTurns: 2, omittedTurns: 1, firstTurnIncluded: true });
    expect(latest.thread.turns.map((turn) => turn.index)).toEqual([1, 3]);
    expect(latest.thread.messages.map((message) => message.text)).toEqual(["Prompt 1", "Reply to: Prompt 1", "Prompt 3", "Reply to: Prompt 3"]);
    expect(latest.thread).toMatchObject({ messageCount: 4, status: "active", runStatus: "completed", queue: [], proposedPlans: [] });
    expect(latest.project).toMatchObject({ id: "project-1" });
    expect(orchestrationReads(fake)).toEqual(["/api/orchestration/threads/target"]);
  });
});

describe("sendThreadMessage", () => {
  it("starts a turn on an idle thread and verifies it", async () => {
    const { fake } = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread({ turns: 1 });

    const result = await sendThreadMessage(fake.config, { threadId: thread.id, prompt: "  Review findings \n" });

    expect(fake.commands).toEqual([
      {
        type: "message.dispatch",
        commandId: result.command.commandId,
        threadId: thread.id,
        messageId: result.message.messageId,
        text: "Review findings",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      },
    ]);
    const run = fake.projection(thread.id).runs[1]!;
    expect(result).toMatchObject({
      project: { id: "project-1" },
      thread: { id: thread.id, statusBeforeSend: "active" },
      message: { textLength: 15, delivery: "start_immediately" },
      command: { type: "message.dispatch", threadId: thread.id, dispatchMode: { type: "start_immediately" } },
      verification: { accepted: true, method: "message-id", messageId: result.message.messageId, runId: run.id, runStatus: "running" },
    });
    expect(result).not.toHaveProperty("settings");
    expect(result).not.toHaveProperty("wait");
  });

  it("refuses a busy thread and says what keeps it busy", async () => {
    const { fake } = await fakeT3({ runBehavior: "hold" });
    const running = fake.addThread().thread;
    const active = fake.startRun(running.id, "Working");
    const queuedOnly = fake.addThread({ turns: 1 }).thread;
    fake.startRun(queuedOnly.id, "Waiting", { status: "queued" });

    for (const ifBusy of [undefined, "refuse", "reject"] as const) {
      await expect(sendThreadMessage(fake.config, { threadId: running.id, prompt: "More", ...(ifBusy ? { ifBusy } : {}) })).rejects.toMatchObject({
        code: "THREAD_BUSY",
        exitCode: 4,
        message: expect.stringContaining("is running a turn"),
        details: { threadId: running.id, runRunning: true, activeRunId: active.id, queuedRuns: 0, queueHeld: false },
      });
    }
    await expect(sendThreadMessage(fake.config, { threadId: queuedOnly.id, prompt: "More" })).rejects.toMatchObject({
      code: "THREAD_BUSY",
      message: expect.stringContaining("has queued messages waiting for their turn"),
      details: { runRunning: false, activeRunId: null, queuedRuns: 1 },
    });
    expect(fake.commands).toEqual([]);
  });

  it.each([
    ["queue", "queue_after_active", false],
    ["steer", "steer_active", true],
    ["inject", "steer_active", true],
    ["restart", "restart_active", true],
  ] as const)("sends into a busy thread with --if-busy %s as %s", async (ifBusy: IfBusy, delivery, targetsActiveRun) => {
    const { fake } = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread();
    const active = fake.startRun(thread.id, "Working");

    const result = await sendThreadMessage(fake.config, { threadId: thread.id, prompt: "Also check the docs", ifBusy });

    const expectedMode = targetsActiveRun ? { type: delivery, targetRunId: active.id } : { type: delivery };
    expect(messageDispatches(fake)).toEqual([expect.objectContaining({ dispatchMode: expectedMode })]);
    expect(result.message.delivery).toBe(delivery);
    expect(result.command.dispatchMode).toEqual(expectedMode);
    const handledBy = fake.projection(thread.id).runs.find((candidate) => candidate.id === result.verification.runId);
    if (delivery === "queue_after_active") expect(handledBy).toMatchObject({ status: "queued", ordinal: 2 });
    if (delivery === "steer_active") expect(handledBy?.id).toBe(active.id);
    if (delivery === "restart_active") {
      expect(active.status).toBe("interrupted");
      expect(handledBy).toMatchObject({ status: "running", ordinal: 2 });
    }
  });

  it("queues a steer or restart when only queued runs keep the thread busy", async () => {
    const { fake } = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread({ turns: 1 });
    fake.startRun(thread.id, "Held", { status: "queued" }).queueHeld = true;

    const steered = await sendThreadMessage(fake.config, { threadId: thread.id, prompt: "Steer", ifBusy: "steer" });
    const restarted = await sendThreadMessage(fake.config, { threadId: thread.id, prompt: "Restart", ifBusy: "restart" });

    expect(steered.message.delivery).toBe("queue_after_active");
    expect(restarted.message.delivery).toBe("queue_after_active");
    expect(messageDispatches(fake).map((command) => command.dispatchMode)).toEqual([{ type: "queue_after_active" }, { type: "queue_after_active" }]);
  });

  it("changes no settings when it refuses a busy thread", async () => {
    const { fake } = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread({ turns: 1, runtimeMode: "approval-required" });
    fake.startRun(thread.id, "Held", { status: "queued" }).queueHeld = true;

    await expect(
      sendThreadMessage(fake.config, {
        threadId: thread.id,
        prompt: "Go",
        settings: { runtimeMode: "full-access" },
        ifBusy: "refuse",
      }),
    ).rejects.toMatchObject({ code: "THREAD_BUSY" });

    expect(fake.commands).toEqual([]);
    expect(fake.projection(thread.id).thread.runtimeMode).toBe("approval-required");
  });

  it("asks before waking a settled thread", async () => {
    const { fake, project } = await fakeT3();
    const settledAt = "2026-10-01T11:00:00.000Z";
    const settled = () => fake.addThread({ settledAt, settledOverride: "settled" }).thread;

    const refused = settled();
    await expect(sendThreadMessage(fake.config, { threadId: refused.id, prompt: "New findings" })).rejects.toMatchObject({
      code: "SETTLED_THREAD_CONFIRMATION_REQUIRED",
      exitCode: 4,
      details: { threadId: refused.id, settledAt },
    });

    const declined = settled();
    await expect(
      sendThreadMessage(fake.config, { threadId: declined.id, prompt: "New findings", confirmSettled: async () => false }),
    ).rejects.toMatchObject({ code: "SETTLED_THREAD_DECLINED", exitCode: 4 });
    expect(fake.commands).toEqual([]);

    const confirmed = settled();
    const asked: Array<[string, string | null]> = [];
    const result = await sendThreadMessage(fake.config, {
      threadId: confirmed.id,
      prompt: "Confirmed findings",
      confirmSettled: async (thread, owner) => {
        asked.push([thread.id, owner?.id ?? null]);
        return true;
      },
    });
    expect(asked).toEqual([[confirmed.id, project.id]]);
    expect(result.thread.statusBeforeSend).toBe("settled");

    const woken = settled();
    const forced = await sendThreadMessage(fake.config, {
      threadId: woken.id,
      prompt: "Explicit",
      wakeSettled: true,
      confirmSettled: async () => {
        throw new Error("--wake-settled skips the question");
      },
    });
    expect(forced.verification.accepted).toBe(true);
    // T3 wakes a settled thread when a message arrives.
    expect(fake.projection(woken.id).thread.settledAt).toBeNull();
    expect(messageDispatches(fake).map((command) => command.threadId)).toEqual([confirmed.id, woken.id]);
  });

  it("refuses archived and deleted threads", async () => {
    const { fake } = await fakeT3();
    const archived = fake.addThread({ archivedAt: "2026-10-01T11:00:00.000Z" }).thread;
    const deleted = fake.addThread({ deletedAt: "2026-10-01T11:00:00.000Z" }).thread;

    await expect(sendThreadMessage(fake.config, { threadId: archived.id, prompt: "New findings", wakeSettled: true })).rejects.toMatchObject({
      code: "THREAD_ARCHIVED",
      exitCode: 4,
    });
    await expect(sendThreadMessage(fake.config, { threadId: deleted.id, prompt: "New findings" })).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
      exitCode: 3,
    });
    expect(fake.commands).toEqual([]);
  });

  it("changes the thread's settings before the message starts its turn", async () => {
    const { fake } = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread({ turns: 1 });

    const result = await sendThreadMessage(fake.config, {
      threadId: thread.id,
      prompt: "Continue on Luna in plan mode",
      settings: { model: "gpt-6-luna", interactionMode: "plan" },
    });

    expect(fake.commands.map((command) => command.type)).toEqual(["thread.model-selection.set", "thread.interaction-mode.set", "message.dispatch"]);
    expect(result.settings).toMatchObject({
      modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
      providerSwitch: false,
      runtimeMode: null,
      interactionMode: "plan",
      catalogUsed: true,
    });
    expect(result.settings?.commands.map((command) => command.type)).toEqual(["thread.model-selection.set", "thread.interaction-mode.set"]);
    expect(result.settings?.dispatches).toHaveLength(2);
    // The new run starts with the new model.
    expect(fake.projection(thread.id).runs[1]?.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6-luna" });

    const other = fake.addThread({ turns: 1 }).thread;
    await sendThreadMessage(fake.config, { threadId: other.id, prompt: "Over to Claude", settings: { provider: "claudeAgent", model: "claude-opus-5-5" } });
    expect(fake.commands.filter((command) => command.threadId === other.id).map((command) => command.type)).toEqual([
      "provider.switch",
      "message.dispatch",
    ]);
  });

  it("refuses new settings while a turn runs, whatever --if-busy says", async () => {
    const { fake } = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread();
    fake.startRun(thread.id, "Working");

    await expect(
      sendThreadMessage(fake.config, { threadId: thread.id, prompt: "Switch now", settings: { model: "gpt-6-luna" }, ifBusy: "queue" }),
    ).rejects.toMatchObject({ code: "THREAD_BUSY", exitCode: 4 });
    expect(fake.commands).toEqual([]);
  });

  it("waits for the reply and leaves the sent message out of it", async () => {
    const { fake } = await fakeT3();
    const { thread } = fake.addThread({ turns: 1 });

    const result = await sendThreadMessage(fake.config, { threadId: thread.id, prompt: "Which tests fail?", wait: { timeoutMs: 10_000 } });

    expect(result.wait).toMatchObject({ outcome: "completed", turnIndex: 2, runId: fake.projection(thread.id).runs[1]!.id, statusAfter: "active" });
    expect(result.reply?.messages.map((message) => [message.role, message.text])).toEqual([["assistant", "Reply to: Which tests fail?"]]);
    expect(result.reply?.turns.map((turn) => turn.index)).toEqual([2]);
    expect(result.pendingRequests).toEqual([]);
  });

  it("tells the caller not to resend when the reply outlasts the wait", async () => {
    const { fake } = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread();

    const failure = await sendThreadMessage(fake.config, { threadId: thread.id, prompt: "Slow work", wait: { timeoutMs: 50 } }).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: "THREAD_WAIT_TIMEOUT",
      exitCode: 6,
      details: { threadId: thread.id, messageId: messageDispatches(fake)[0]?.messageId, sent: true },
    });
    expect((failure as Error).message).toContain("Do not resend it");
  });

  it("needs a message and a thread id", async () => {
    const { fake } = await fakeT3();

    await expect(sendThreadMessage(fake.config, { threadId: "thread-1", prompt: " \n " })).rejects.toMatchObject({
      code: "PROMPT_REQUIRED",
      exitCode: 2,
    });
    await expect(sendThreadMessage(fake.config, { threadId: " ", prompt: "Hi" })).rejects.toMatchObject({ code: "THREAD_ID_REQUIRED" });
  });
});

describe("waitForThread", () => {
  it("returns the latest turn once the thread finished", async () => {
    const { fake } = await fakeT3();
    const { thread } = fake.addThread({ turns: 2 });

    const result = await waitForThread(fake.config, thread.id, { timeoutMs: 10_000, detail: "messages", maxChars: 5 });

    expect(result).toMatchObject({
      thread: { id: thread.id, title: thread.title },
      project: { id: "project-1" },
      wait: { outcome: "completed", turnIndex: 2, statusAfter: "active" },
    });
    expect(result.reply.view).toMatchObject({ detail: "messages", maxChars: 5 });
    expect(result.reply.messages.map((message) => message.text)).toEqual(["Promp", "Reply"]);
  });

  it("returns the requests a thread waits on", async () => {
    const { fake } = await fakeT3();
    const { thread } = fake.addThread();
    const run = fake.startRun(thread.id, "Needs a decision", { status: "waiting" });
    const approval = fake.addApproval(thread.id, run.id, { prompt: "git push" });

    const result = await waitForThread(fake.config, thread.id, { timeoutMs: 10_000 });

    expect(result.wait).toMatchObject({ outcome: "needs-attention", runId: run.id });
    expect(result.pendingRequests).toEqual([expect.objectContaining({ requestId: approval.id, detail: "git push" })]);
  });

  it("reports a thread without turns", async () => {
    const { fake } = await fakeT3();
    const { thread } = fake.addThread();

    const result = await waitForThread(fake.config, thread.id, { timeoutMs: 10_000 });

    expect(result.wait).toMatchObject({ outcome: "idle", turnIndex: null, runId: null });
    expect(result.reply.turns).toEqual([]);
  });
});

describe("settleThread and unsettleThread", () => {
  it("settles an idle thread and verifies it", async () => {
    const { fake } = await fakeT3();
    const { thread } = fake.addThread({ turns: 1 });

    const result = await settleThread(fake.config, thread.id);

    expect(fake.commands).toEqual([{ type: "thread.settle", commandId: result.command.commandId, threadId: thread.id }]);
    expect(result).toMatchObject({
      project: { id: "project-1" },
      thread: { id: thread.id, statusBefore: "active", statusAfter: "settled" },
      verification: { accepted: true, state: "settled", settledAt: expect.any(String), dispatchSequence: result.dispatch.sequence },
    });
  });

  it("unsettles a settled thread and verifies it", async () => {
    const { fake } = await fakeT3();
    const { thread } = fake.addThread({ settledAt: "2026-10-01T11:00:00.000Z", settledOverride: "settled" });

    const result = await unsettleThread(fake.config, thread.id);

    expect(fake.commands).toEqual([expect.objectContaining({ type: "thread.unsettle", threadId: thread.id, reason: "user" })]);
    expect(result).toMatchObject({
      thread: { statusBefore: "settled", statusAfter: "active" },
      verification: { accepted: true, state: "active", settledAt: null, unsettledAt: expect.any(String) },
    });
  });

  it("refuses to settle a thread with a running turn, queued runs, or open requests", async () => {
    const { fake } = await fakeT3({ runBehavior: "hold" });
    const running = fake.addThread().thread;
    const active = fake.startRun(running.id, "Working");
    const queued = fake.addThread({ turns: 1 }).thread;
    fake.startRun(queued.id, "Next", { status: "queued" });
    const asking = fake.addThread({ turns: 1 }).thread;
    const question = fake.addQuestion(asking.id, fake.projection(asking.id).runs[0]!.id, [{ id: "0", header: "Q", question: "Which?" }], {
      capability: "message",
    });

    await expect(settleThread(fake.config, running.id)).rejects.toMatchObject({
      code: "THREAD_SETTLE_BLOCKED",
      exitCode: 4,
      details: { threadId: running.id, activeRunId: active.id, queuedRuns: 0, pendingRequests: [] },
    });
    await expect(settleThread(fake.config, queued.id)).rejects.toMatchObject({
      code: "THREAD_SETTLE_BLOCKED",
      details: { activeRunId: null, queuedRuns: 1, pendingRequests: [] },
    });
    await expect(settleThread(fake.config, asking.id)).rejects.toMatchObject({
      code: "THREAD_SETTLE_BLOCKED",
      details: { activeRunId: null, queuedRuns: 0, pendingRequests: [question.id] },
    });
    expect(fake.commands).toEqual([]);
  });

  it.each([
    ["settle", settleThread, {}],
    ["unsettle", unsettleThread, { threadSettlement: false }],
  ] as const)("refuses to %s when T3 does not advertise settlement", async (_name, change, capabilities) => {
    const { fake } = await fakeT3({ capabilities, serverVersion: "0.0.46-nightly.20261001.1" });
    const { thread } = fake.addThread();

    await expect(change(fake.config, thread.id)).rejects.toMatchObject({
      code: "THREAD_SETTLEMENT_UNSUPPORTED",
      exitCode: 4,
      details: { capability: "threadSettlement", serverVersion: "0.0.46-nightly.20261001.1" },
    });
    // The capability check comes before any session or request.
    expect(fake.httpRequests.map((request) => request.url)).toEqual(["/.well-known/t3/environment"]);
  });

  it("refuses to change an archived thread's settlement", async () => {
    const { fake } = await fakeT3();
    const { thread } = fake.addThread({ archivedAt: "2026-10-01T11:00:00.000Z" });

    await expect(settleThread(fake.config, thread.id)).rejects.toMatchObject({ code: "THREAD_ARCHIVED", exitCode: 4 });
    expect(fake.commands).toEqual([]);
  });
});
