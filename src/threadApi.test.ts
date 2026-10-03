import { afterEach, describe, expect, it } from "vitest";

import { T3Api } from "./api.js";
import { CliError } from "./errors.js";
import { discoverRuntime } from "./runtime.js";
import { startFakeT3, type FakeT3, type FakeT3Options } from "./testing/fakeT3.js";
import { createdBy, observeRun, runForMessage, T3ThreadApi } from "./threadApi.js";
import {
  TERMINAL_RUN_STATUSES,
  type RunStatus,
  type T3Message,
  type T3Run,
  type T3RuntimeRequest,
  type T3ThreadProjection,
  type T3TurnItem,
} from "./types.js";

const fakes: FakeT3[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

function at(minute: number): string {
  return `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

function run(ordinal: number, status: RunStatus, overrides: Partial<T3Run> = {}): T3Run {
  return {
    id: `run-${ordinal}`,
    threadId: "thread-1",
    ordinal,
    userMessageId: `prompt-${ordinal}`,
    status,
    queuePosition: null,
    requestedAt: at(ordinal),
    startedAt: status === "queued" ? null : at(ordinal),
    completedAt: TERMINAL_RUN_STATUSES.includes(status) ? at(ordinal + 1) : null,
    ...overrides,
  };
}

function message(id: string, role: T3Message["role"], runId: string | null, minute = 0): T3Message {
  return { id, role, runId, text: id, streaming: false, createdAt: at(minute), updatedAt: at(minute) };
}

function projection(parts: Partial<T3ThreadProjection> = {}): T3ThreadProjection {
  return {
    thread: { id: "thread-1", projectId: "project-1", title: "Work", archivedAt: null },
    runs: [],
    runtimeRequests: [],
    messages: [],
    turnItems: [],
    ...parts,
  };
}

function pending(id: string, runId: string, capability: T3RuntimeRequest["responseCapability"]["type"]) {
  const request: T3RuntimeRequest = {
    id,
    kind: capability === "message" ? "user_input" : "command",
    status: "pending",
    responseCapability: { type: capability },
    createdAt: at(1),
    resolvedAt: null,
  };
  const item: T3TurnItem = {
    id: `item:${id}`,
    type: capability === "message" ? "user_input_request" : "approval_request",
    runId,
    requestId: id,
    questions: [],
  };
  return { request, item };
}

describe("observeRun", () => {
  it("reports an idle thread without runs", () => {
    expect(observeRun(projection())).toEqual({ outcome: "idle", run: null });
  });

  it.each([
    ["completed", "completed"],
    ["interrupted", "interrupted"],
    ["cancelled", "interrupted"],
    ["rolled_back", "ended"],
  ] as const)("reports a %s run as %s", (status, outcome) => {
    const source = projection({ runs: [run(1, status)], messages: [message("prompt-1", "user", "run-1")] });

    expect(observeRun(source)).toEqual({ outcome, run: source.runs[0] });
    expect(observeRun(source, "prompt-1")).toEqual({ outcome, run: source.runs[0] });
  });

  it("reports a failed run with the failure from its error item", () => {
    const source = projection({
      runs: [run(1, "failed")],
      turnItems: [
        { id: "early", type: "error", runId: "run-1", failure: { message: "Retrying" } },
        { id: "late", type: "error", runId: "run-1", failure: { message: "Usage limit reached" } },
      ],
    });

    expect(observeRun(source)).toMatchObject({ outcome: "error", error: "Usage limit reached" });
    // Without an error item the reason is unknown.
    expect(observeRun(projection({ runs: [run(1, "failed")] }))).toMatchObject({
      outcome: "error",
      error: "The provider could not complete the turn.",
    });
  });

  it.each(["preparing", "starting", "running", "waiting"] as const)("keeps waiting while a run is %s", (status) => {
    expect(observeRun(projection({ runs: [run(1, status)] }))).toBeNull();
  });

  it("stops for a request on the awaited run or one that holds up the active run", () => {
    const own = pending("approval", "run-1", "live");
    const onAwaited = projection({ runs: [run(1, "running")], runtimeRequests: [own.request], turnItems: [own.item] });
    expect(observeRun(onAwaited)).toMatchObject({ outcome: "needs-attention", run: { id: "run-1" } });

    // A blocking request without a timeline item still holds up the run that works.
    const bare = projection({ runs: [run(1, "running")], runtimeRequests: [own.request] });
    expect(observeRun(bare)).toMatchObject({ outcome: "needs-attention" });
  });

  it("ignores an earlier run's message-mode question once the awaited run finished", () => {
    const old = pending("question", "run-1", "message");
    const source = projection({
      runs: [run(1, "completed"), run(2, "completed")],
      runtimeRequests: [old.request],
      turnItems: [old.item],
      messages: [message("prompt-1", "user", "run-1"), message("prompt-2", "user", "run-2")],
    });

    expect(observeRun(source, "prompt-2")).toMatchObject({ outcome: "completed", run: { id: "run-2" } });
    // The run that asked does need a person.
    expect(observeRun(source, "prompt-1")).toMatchObject({ outcome: "needs-attention", run: { id: "run-1" } });
  });

  it("follows a queued message until its run starts and finishes, unless the queue is held", () => {
    const queued = projection({
      runs: [run(1, "running"), run(2, "queued", { queuePosition: 1 })],
      messages: [message("prompt-2", "user", "run-2")],
    });
    expect(observeRun(queued, "prompt-2")).toBeNull();

    const held = projection({ runs: [run(1, "completed"), run(2, "queued", { queuePosition: 1, queueHeld: true })] });
    expect(observeRun(held, "prompt-2")).toMatchObject({ outcome: "queue-held", run: { id: "run-2" } });
    expect(observeRun(held)).toMatchObject({ outcome: "queue-held", run: { id: "run-2" } });
  });

  it("stops for a queued message when the run ahead of it waits for a person", () => {
    const approval = pending("approval", "run-1", "live");
    const source = projection({
      runs: [run(1, "running"), run(2, "queued", { queuePosition: 1 })],
      runtimeRequests: [approval.request],
      turnItems: [approval.item],
      messages: [message("prompt-2", "user", "run-2")],
    });
    expect(observeRun(source, "prompt-2")).toMatchObject({ outcome: "needs-attention", run: { id: "run-2" } });
  });

  it("waits on the thread until its queue drains", () => {
    expect(observeRun(projection({ runs: [run(1, "completed"), run(2, "queued", { queuePosition: 1 })] }))).toBeNull();
    expect(observeRun(projection({ runs: [run(1, "completed"), run(2, "running")] }))).toBeNull();
    expect(observeRun(projection({ runs: [run(1, "completed"), run(2, "completed")] }))).toMatchObject({
      outcome: "completed",
      run: { id: "run-2" },
    });
  });

  it("finds the run of a steered message and waits for a message T3 has not recorded yet", () => {
    const source = projection({
      runs: [run(1, "completed")],
      messages: [message("prompt-1", "user", "run-1"), message("steer", "user", "run-1", 1)],
    });

    expect(runForMessage(source, "steer")?.id).toBe("run-1");
    expect(observeRun(source, "steer")).toMatchObject({ outcome: "completed", run: { id: "run-1" } });
    expect(observeRun(source, "unknown")).toBeNull();
    expect(runForMessage(source, "unknown")).toBeNull();
  });
});

async function connect(options: FakeT3Options = {}) {
  const fake = await startFakeT3({ runBehavior: "hold", gitRepo: false, ...options });
  fakes.push(fake);
  fake.addProject();
  const api = new T3Api(await discoverRuntime(fake.config, { startDesktopIfNeeded: false }), "mock-token");
  const adapter = new T3ThreadApi(api, {
    verificationTimeoutMs: 1_000,
    verificationIntervalMs: 5,
    waitIntervalMs: 5,
    controlTimeoutMs: 1_000,
  });
  return { fake, api, adapter };
}

/** Resolves once a waiter has polled the thread again, so it has seen the state the test set up. */
async function nextPoll(fake: FakeT3, threadId: string): Promise<void> {
  const polls = () => fake.httpRequests.filter((request) => request.url === `/api/orchestration/threads/${threadId}/bounded`).length;
  const before = polls();
  while (polls() <= before) await new Promise((resolve) => setTimeout(resolve, 2));
}

function stalledApi(): T3Api {
  return { threadDetail: () => new Promise(() => undefined) } as unknown as T3Api;
}

function dispatchMessage(threadId: string, messageId: string, dispatchMode: Record<string, unknown>) {
  return { type: "message.dispatch", threadId, messageId, text: messageId, attachments: [], ...createdBy(), dispatchMode };
}

describe("T3ThreadApi reads and commands", () => {
  it("reads the whole thread and polls a bounded window", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread({ turns: 1 });

    const read = await adapter.read(thread.id);
    const inspected = await adapter.inspect(thread.id);

    expect(read.projection.runs).toHaveLength(1);
    expect(read.snapshotSequence).toBe(fake.sequence);
    expect(inspected.projection.thread.id).toBe(thread.id);
    expect(fake.httpRequests.map((request) => request.url).filter((url) => url.startsWith("/api/orchestration/"))).toEqual([
      `/api/orchestration/threads/${thread.id}`,
      `/api/orchestration/threads/${thread.id}/bounded`,
    ]);
  });

  it("names the command T3 rejected", async () => {
    const { fake, adapter } = await connect({
      onCommand: (command) => (command.type === "thread.settle" ? "Thread has active work." : undefined),
    });
    const { thread } = fake.addThread();

    const failure = await adapter.dispatch({ type: "thread.settle", threadId: thread.id }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "THREAD_COMMAND_REJECTED",
      exitCode: 4,
      message: `T3 rejected thread.settle for thread ${thread.id}: Thread has active work.`,
      details: { type: "thread.settle", threadId: thread.id },
      cause: { code: "T3_RPC_FAILED" },
    });
    expect(fake.commands).toEqual([]);
  });

  it("gives each command an id unless the caller chose one", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread();

    const first = await adapter.dispatch({ type: "thread.pin", threadId: thread.id });
    await adapter.dispatch({ type: "thread.unpin", commandId: "chosen-id", threadId: thread.id });

    expect(first.sequence).toBe(fake.sequence - 1);
    expect(fake.commands[0]?.commandId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fake.commands[1]?.commandId).toBe("chosen-id");
  });

  it("passes on failures that are not command rejections", async () => {
    const timeout = new CliError("T3_RPC_TIMEOUT", "T3 did not answer.");
    const adapter = new T3ThreadApi({ dispatchCommand: async () => Promise.reject(timeout) } as unknown as T3Api);

    await expect(adapter.dispatch({ type: "thread.pin", threadId: "thread-1" })).rejects.toBe(timeout);
  });

  it("verifies a message by its id and names the run that handles it", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread();

    const started = await adapter.dispatch(dispatchMessage(thread.id, "message-1", { type: "start_immediately" }));
    const verified = await adapter.verifyMessage(thread.id, "message-1", started.sequence);
    const steered = await adapter.dispatch(dispatchMessage(thread.id, "steer-1", { type: "steer_active", targetRunId: verified.runId }));

    expect(verified).toEqual({
      accepted: true,
      method: "message-id",
      messageId: "message-1",
      dispatchSequence: started.sequence,
      runId: fake.projection(thread.id).runs[0]!.id,
      runStatus: "running",
    });
    expect(await adapter.verifyMessage(thread.id, "steer-1", steered.sequence)).toMatchObject({ runId: verified.runId, runStatus: "running" });
  });

  it("fails verification when T3 never records the message", async () => {
    const { fake, api } = await connect();
    const { thread } = fake.addThread();
    const adapter = new T3ThreadApi(api, { verificationTimeoutMs: 50, verificationIntervalMs: 5 });

    await expect(adapter.verifyMessage(thread.id, "missing", 7)).rejects.toMatchObject({
      code: "THREAD_TURN_NOT_VERIFIED",
      exitCode: 5,
      details: { threadId: thread.id, messageId: "missing", dispatchSequence: 7 },
    });
  });

  it("ends verification at its deadline when a read stalls", async () => {
    const adapter = new T3ThreadApi(stalledApi(), { verificationTimeoutMs: 50, verificationIntervalMs: 0 });
    const started = Date.now();

    await expect(adapter.verifyMessage("thread-1", "message-1", 1)).rejects.toMatchObject({ code: "THREAD_TURN_NOT_VERIFIED" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("polls until a check passes and returns the last projection when it never does", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread({ title: "Polled" });

    const found = await adapter.poll(thread.id, (candidate) => candidate.thread.title, 200);
    const missed = await adapter.poll(thread.id, () => null, 30);

    expect(found.value).toBe("Polled");
    expect(missed.value).toBeNull();
    expect(missed.projection?.thread.id).toBe(thread.id);
  });
});

describe("T3ThreadApi.waitForTurn", () => {
  it("waits for the run that handles a message and returns its turn", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread({ turns: 1 });
    const second = fake.startRun(thread.id, "Second", { messageId: "message-2" });

    const waiting = adapter.waitForTurn(thread.id, { messageId: "message-2", timeoutMs: 5_000 });
    await nextPoll(fake, thread.id);
    fake.completeRun(thread.id, second.id, "Second answer");
    const waited = await waiting;

    expect(waited).toMatchObject({ outcome: "completed", runId: second.id, turnIndex: 2, snapshotSequence: fake.sequence });
    expect(waited).not.toHaveProperty("error");
    expect(waited.waitedMs).toBeGreaterThanOrEqual(0);
    expect(waited.projection.messages.map((entry) => entry.text)).toContain("Second answer");
    // The wait ends with one read of the whole thread.
    expect(fake.httpRequests.at(-1)?.url).toBe(`/api/orchestration/threads/${thread.id}`);
  });

  it.each(["interrupted", "cancelled"] as const)("reports a %s run as interrupted", async (status) => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread();
    const running = fake.startRun(thread.id, "Go", { messageId: "message-1" });

    const waiting = adapter.waitForTurn(thread.id, { messageId: "message-1", timeoutMs: 5_000 });
    await nextPoll(fake, thread.id);
    fake.completeRun(thread.id, running.id, "Stopped", status);

    await expect(waiting).resolves.toMatchObject({ outcome: "interrupted", runId: running.id, turnIndex: 1 });
  });

  it("reports why the provider could not run the turn", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread();
    const running = fake.startRun(thread.id, "Go");

    const waiting = adapter.waitForTurn(thread.id, { timeoutMs: 5_000 });
    await nextPoll(fake, thread.id);
    fake.projection(thread.id).turnItems.push({ id: "error-1", type: "error", runId: running.id, failure: { message: "Usage limit reached" } });
    fake.completeRun(thread.id, running.id, "", "failed");

    await expect(waiting).resolves.toMatchObject({ outcome: "error", error: "Usage limit reached", runId: running.id });
  });

  it("stops when the running turn asks for an approval", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread();
    const running = fake.startRun(thread.id, "Go", { messageId: "message-1" });

    const waiting = adapter.waitForTurn(thread.id, { messageId: "message-1", timeoutMs: 5_000 });
    await nextPoll(fake, thread.id);
    fake.addApproval(thread.id, running.id);

    await expect(waiting).resolves.toMatchObject({ outcome: "needs-attention", runId: running.id });
  });

  it("reports a message that waits in a held queue", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread({ turns: 1 });
    fake.startRun(thread.id, "Next", { messageId: "message-2", status: "queued" }).queueHeld = true;

    await expect(adapter.waitForTurn(thread.id, { messageId: "message-2", timeoutMs: 5_000 })).resolves.toMatchObject({
      outcome: "queue-held",
      turnIndex: 2,
    });
    await expect(adapter.waitForTurn(thread.id, { timeoutMs: 5_000 })).resolves.toMatchObject({ outcome: "queue-held" });
  });

  it("reports a thread that has no turns", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread();

    await expect(adapter.waitForTurn(thread.id, { timeoutMs: 5_000 })).resolves.toMatchObject({
      outcome: "idle",
      runId: null,
      turnIndex: null,
    });
  });

  it("waits on the thread until its queue drains", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread();
    const first = fake.startRun(thread.id, "First");
    const second = fake.startRun(thread.id, "Second", { status: "queued" });

    const waiting = adapter.waitForTurn(thread.id, { timeoutMs: 5_000 });
    await nextPoll(fake, thread.id);
    // The queued run starts as soon as the first one ends.
    fake.completeRun(thread.id, first.id, "First answer");
    expect(fake.projection(thread.id).runs[1]?.status).toBe("running");
    await nextPoll(fake, thread.id);
    fake.completeRun(thread.id, second.id, "Second answer");

    await expect(waiting).resolves.toMatchObject({ outcome: "completed", runId: second.id, turnIndex: 2 });
  });

  it("waits for the run a steered message joined", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread();
    const running = fake.startRun(thread.id, "First");
    await adapter.dispatch(dispatchMessage(thread.id, "steer-1", { type: "steer_active", targetRunId: running.id }));

    const waiting = adapter.waitForTurn(thread.id, { messageId: "steer-1", timeoutMs: 5_000 });
    await nextPoll(fake, thread.id);
    fake.completeRun(thread.id, running.id, "Done, with the steer");

    await expect(waiting).resolves.toMatchObject({ outcome: "completed", runId: running.id, turnIndex: 1 });
  });

  it("times out with the state it saw last", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread();
    const running = fake.startRun(thread.id, "First", { messageId: "message-1" });
    fake.startRun(thread.id, "Second", { status: "queued" });

    const failure = await adapter.waitForTurn(thread.id, { messageId: "message-1", timeoutMs: 50 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      code: "THREAD_WAIT_TIMEOUT",
      exitCode: 6,
      details: { threadId: thread.id, messageId: "message-1", activeRunId: running.id, activeRunStatus: "running", queuedRuns: 1 },
    });
    await expect(adapter.waitForTurn(thread.id, { timeoutMs: 20 })).rejects.toSatisfy(
      (error: unknown) => error instanceof CliError && !Object.hasOwn(error.details as object, "messageId"),
    );
  });

  it("keeps to the timeout when a read stalls", async () => {
    const adapter = new T3ThreadApi(stalledApi(), { waitIntervalMs: 0 });
    const started = Date.now();

    await expect(adapter.waitForTurn("thread-1", { timeoutMs: 50 })).rejects.toMatchObject({
      code: "THREAD_WAIT_TIMEOUT",
      details: { activeRunId: null, activeRunStatus: null, queuedRuns: null },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("stops when the thread is deleted while it waits", async () => {
    const { fake, adapter } = await connect();
    const { thread } = fake.addThread();
    fake.startRun(thread.id, "Go");

    const waiting = adapter.waitForTurn(thread.id, { timeoutMs: 5_000 });
    await nextPoll(fake, thread.id);
    fake.projection(thread.id).thread.deletedAt = new Date().toISOString();

    await expect(waiting).rejects.toMatchObject({ code: "THREAD_NOT_FOUND", exitCode: 3 });

    const tombstone = projection({ thread: { id: "thread-1", projectId: "project-1", title: "Gone", archivedAt: null, deletedAt: at(9) } });
    const adapterForTombstone = new T3ThreadApi({ threadDetail: async () => ({ snapshotSequence: 1, projection: tombstone }) } as unknown as T3Api);
    await expect(adapterForTombstone.waitForTurn("thread-1", { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
      message: "Thread thread-1 was deleted while waiting.",
    });
  });
});
