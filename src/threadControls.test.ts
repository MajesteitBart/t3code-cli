import { afterEach, describe, expect, it } from "vitest";

import { T3Api } from "./api.js";
import { parseCatalog } from "./catalog.js";
import { discoverRuntime } from "./runtime.js";
import { startFakeT3, type Command, type FakeT3, type FakeT3Options } from "./testing/fakeT3.js";
import { T3ThreadApi } from "./threadApi.js";
import {
  answerThread,
  changeSettingsWithApi,
  interruptThread,
  listModels,
  planThreadSettings,
  resolveAnswers,
  respondToApproval,
  updateThreadSettings,
} from "./threadControls.js";
import type { PendingRequest } from "./transcript.js";
import type { T3Run, T3RuntimeRequest, T3ThreadProjection } from "./types.js";

const fakes: FakeT3[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function fakeT3(options: FakeT3Options = {}): Promise<FakeT3> {
  const fake = await startFakeT3({ gitRepo: false, ...options });
  fakes.push(fake);
  fake.addProject({ title: "Project One" });
  return fake;
}

const catalog = parseCatalog({
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      showInteractionModeToggle: true,
      models: [
        {
          slug: "gpt-6-astra",
          capabilities: {
            optionDescriptors: [{ id: "reasoningEffort", type: "select", options: [{ id: "medium", isDefault: true }, { id: "high" }] }],
          },
        },
        { slug: "gpt-6-luna", capabilities: { optionDescriptors: [] } },
      ],
    },
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      showInteractionModeToggle: true,
      models: [{ slug: "claude-opus-5-5", capabilities: { optionDescriptors: [] } }],
    },
    {
      instanceId: "opencode",
      driver: "opencode",
      enabled: true,
      showInteractionModeToggle: false,
      models: [{ slug: "openrouter/aion-3.5", capabilities: { optionDescriptors: [] } }],
    },
    { instanceId: "cursor", driver: "cursor", enabled: false, models: [{ slug: "auto", capabilities: { optionDescriptors: [] } }] },
  ],
});

function run(ordinal: number, status: T3Run["status"]): T3Run {
  return {
    id: `run-${ordinal}`,
    threadId: "thread-1",
    ordinal,
    userMessageId: `prompt-${ordinal}`,
    status,
    requestedAt: "2026-10-01T10:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-10-01T10:00:00.000Z",
    completedAt: null,
  };
}

function projection(thread: Partial<T3ThreadProjection["thread"]> = {}, runs: T3Run[] = []): T3ThreadProjection {
  return {
    thread: {
      id: "thread-1",
      projectId: "project-1",
      title: "Work",
      archivedAt: null,
      modelSelection: { instanceId: "codex", model: "gpt-6-astra", options: [{ id: "reasoningEffort", value: "medium" }] },
      runtimeMode: "full-access",
      interactionMode: "default",
      ...thread,
    },
    runs,
    runtimeRequests: [],
    messages: [],
    turnItems: [],
  };
}

describe("planThreadSettings", () => {
  it("orders commands like T3 Code's composer and skips unchanged values", () => {
    const plan = planThreadSettings(
      projection(),
      { thinkingEffort: "high", runtimeMode: "approval-required", interactionMode: "plan" },
      catalog,
    );

    expect(plan.commands.map(({ type, threadId }) => ({ type, threadId }))).toEqual([
      { type: "thread.model-selection.set", threadId: "thread-1" },
      { type: "thread.runtime-mode.set", threadId: "thread-1" },
      { type: "thread.interaction-mode.set", threadId: "thread-1" },
    ]);
    expect(new Set(plan.commands.map((command) => command.commandId)).size).toBe(3);
    expect(plan).toMatchObject({
      modelSelection: { instanceId: "codex", model: "gpt-6-astra", options: [{ id: "reasoningEffort", value: "high" }] },
      providerSwitch: false,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      catalogUsed: true,
    });
    expect(plan.commands[1]).toMatchObject({ runtimeMode: "approval-required" });
    expect(plan.commands[2]).toMatchObject({ interactionMode: "plan" });

    const unchanged = planThreadSettings(projection(), { thinkingEffort: "medium", runtimeMode: "full-access", interactionMode: "default" }, catalog);
    expect(unchanged).toMatchObject({ commands: [], modelSelection: null, runtimeMode: null, interactionMode: null });
  });

  it("switches to another provider instance through T3's provider switch", () => {
    const switched = planThreadSettings(projection(), { provider: "claudeAgent", model: "claude-opus-5-5" }, catalog);
    expect(switched.providerSwitch).toBe(true);
    expect(switched.commands).toEqual([
      expect.objectContaining({ type: "provider.switch", threadId: "thread-1", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }),
    ]);

    // Another model on the same instance only changes the thread's selection.
    const sameInstance = planThreadSettings(projection(), { model: "gpt-6-luna" }, catalog);
    expect(sameInstance.providerSwitch).toBe(false);
    expect(sameInstance.commands).toEqual([
      expect.objectContaining({ type: "thread.model-selection.set", modelSelection: { instanceId: "codex", model: "gpt-6-luna" } }),
    ]);

    expect(() => planThreadSettings(projection(), { provider: "claudeAgent" }, catalog)).toThrow(
      expect.objectContaining({ code: "MODEL_REQUIRED_FOR_PROVIDER", exitCode: 2 }),
    );
    expect(() => planThreadSettings(projection(), { provider: "cursor", model: "auto" }, catalog)).toThrow(
      expect.objectContaining({ code: "PROVIDER_DISABLED", exitCode: 4 }),
    );
  });

  it("refuses permission and provider changes that would stop a running turn", () => {
    const running = projection({}, [run(1, "running")]);

    expect(() => planThreadSettings(running, { runtimeMode: "approval-required" }, catalog)).toThrow(
      expect.objectContaining({
        code: "THREAD_BUSY",
        exitCode: 4,
        message: expect.stringContaining("Changing the permission mode"),
        details: { threadId: "thread-1", activeRunId: "run-1" },
      }),
    );
    expect(() => planThreadSettings(running, { provider: "claudeAgent", model: "claude-opus-5-5" }, catalog)).toThrow(
      expect.objectContaining({ code: "THREAD_BUSY", message: expect.stringContaining("Switching the provider") }),
    );
    // A model on the same instance and plan mode apply to the next turn, so a running turn does not block them.
    expect(planThreadSettings(running, { model: "gpt-6-luna", interactionMode: "plan" }, catalog).commands).toHaveLength(2);
    // Queued runs alone have no provider session to restart.
    const queuedOnly = projection({}, [run(1, "completed"), run(2, "queued")]);
    expect(planThreadSettings(queuedOnly, { runtimeMode: "auto" }, catalog).runtimeMode).toBe("auto");
  });

  it("checks plan mode against the catalog", () => {
    const openCode = projection({ modelSelection: { instanceId: "opencode", model: "openrouter/aion-3.5" } });
    expect(() => planThreadSettings(openCode, { interactionMode: "plan" }, catalog)).toThrow(
      expect.objectContaining({ code: "PLAN_MODE_UNSUPPORTED", exitCode: 2, message: expect.stringContaining("--option agent=plan") }),
    );

    // A thread in plan mode keeps it, so the new provider must support it too.
    const planning = projection({ interactionMode: "plan" });
    expect(() => planThreadSettings(planning, { provider: "opencode", model: "openrouter/aion-3.5" }, catalog)).toThrow(
      expect.objectContaining({ code: "PLAN_MODE_UNSUPPORTED", details: { provider: "opencode" } }),
    );
    expect(planThreadSettings(planning, { provider: "claudeAgent", model: "claude-opus-5-5" }, catalog).providerSwitch).toBe(true);
    // Without a catalog there is nothing to check against.
    expect(planThreadSettings(openCode, { interactionMode: "plan" }, null).interactionMode).toBe("plan");
  });

  it("falls back to every effort alias, including OpenCode's variant, without a catalog", () => {
    const plan = planThreadSettings(projection({ modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }), { thinkingEffort: "max" }, null);

    expect(plan.catalogUsed).toBe(false);
    expect(plan.modelSelection?.options).toEqual([
      { id: "reasoningEffort", value: "max" },
      { id: "effort", value: "max" },
      { id: "reasoning", value: "max" },
      { id: "variant", value: "max" },
    ]);
  });

  it("needs a saved model selection to change the model", () => {
    const { modelSelection: _omitted, ...withoutModel } = projection().thread;
    const source = { ...projection(), thread: withoutModel };

    expect(() => planThreadSettings(source, { model: "gpt-6-luna" }, catalog)).toThrow(expect.objectContaining({ code: "T3_INVALID_THREAD" }));
    expect(planThreadSettings(source, { interactionMode: "plan" }, catalog).commands).toHaveLength(1);
  });
});

/** Accepts every command without applying it, so T3 never shows the change. */
function acceptWithoutApplying(): NonNullable<FakeT3Options["rpcHandlers"]> {
  return {
    "orchestration.dispatchCommand": (payload, fake) => {
      fake.commands.push(payload as Command);
      return { sequence: fake.sequence };
    },
  };
}

async function adapterFor(fake: FakeT3, controlTimeoutMs = 1_000) {
  const api = new T3Api(await discoverRuntime(fake.config, { startDesktopIfNeeded: false }), "mock-token");
  return { api, adapter: new T3ThreadApi(api, { verificationIntervalMs: 5, controlTimeoutMs }) };
}

describe("changeSettingsWithApi", () => {
  it("applies the plan and returns the thread with its new settings", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread();
    const { api, adapter } = await adapterFor(fake);

    const result = await changeSettingsWithApi(api, adapter, fake.projection(thread.id), { model: "gpt-6-luna", runtimeMode: "approval-required" });

    expect(fake.commands.map((command) => command.type)).toEqual(["thread.model-selection.set", "thread.runtime-mode.set"]);
    expect(result.dispatches).toHaveLength(2);
    expect(result.projection.thread).toMatchObject({ modelSelection: { model: "gpt-6-luna" }, runtimeMode: "approval-required" });
  });

  it("refuses while a turn runs, because the message would join it with the old settings", async () => {
    const fake = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread();
    fake.startRun(thread.id, "Working");
    const { api, adapter } = await adapterFor(fake);

    await expect(changeSettingsWithApi(api, adapter, fake.projection(thread.id), { model: "gpt-6-luna" })).rejects.toMatchObject({
      code: "THREAD_BUSY",
      exitCode: 4,
    });
    expect(fake.commands).toEqual([]);
  });

  it("fails when T3 accepts the change but never shows it", async () => {
    const fake = await fakeT3({ rpcHandlers: acceptWithoutApplying() });
    const { thread } = fake.addThread();
    const { api, adapter } = await adapterFor(fake, 50);

    await expect(changeSettingsWithApi(api, adapter, fake.projection(thread.id), { interactionMode: "plan" })).rejects.toMatchObject({
      code: "THREAD_SETTINGS_NOT_VERIFIED",
      exitCode: 5,
      details: { threadId: thread.id, commands: ["thread.interaction-mode.set"] },
    });
  });
});

describe("updateThreadSettings", () => {
  it("changes effort, fast mode, and plan mode with the provider catalog", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread();

    const result = await updateThreadSettings(fake.config, {
      threadId: thread.id,
      change: { thinkingEffort: "xhigh", speedMode: "fast", interactionMode: "plan" },
    });

    expect(fake.commands.map((command) => command.type)).toEqual(["thread.model-selection.set", "thread.interaction-mode.set"]);
    expect(fake.commands[0]).toMatchObject({
      modelSelection: {
        instanceId: "codex",
        model: "gpt-6-astra",
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "serviceTier", value: "priority" },
        ],
      },
    });
    expect(result).toMatchObject({
      dryRun: false,
      changed: true,
      project: { title: "Project One" },
      before: { interactionMode: "default" },
      after: { interactionMode: "plan", modelSelection: { model: "gpt-6-astra" } },
      changes: { catalogUsed: true, providerSwitch: false },
    });
    expect(result.dispatches).toHaveLength(2);
  });

  it("switches the provider through a handoff", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread();

    const result = await updateThreadSettings(fake.config, { threadId: thread.id, change: { provider: "claudeAgent", model: "claude-opus-5-5" } });

    expect(fake.commands).toEqual([expect.objectContaining({ type: "provider.switch", threadId: thread.id })]);
    expect(result).toMatchObject({ changes: { providerSwitch: true }, after: { modelSelection: { instanceId: "claudeAgent" } } });
  });

  it("checks a change without dispatching it on a dry run", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread();

    const result = await updateThreadSettings(fake.config, { threadId: thread.id, change: { model: "gpt-6-luna" }, dryRun: true });

    expect(fake.commands).toEqual([]);
    expect(result).toMatchObject({ dryRun: true, changed: true, after: null, dispatches: [], changes: { modelSelection: { model: "gpt-6-luna" } } });
    expect(result.commands.map((command) => command.type)).toEqual(["thread.model-selection.set"]);
  });

  it("sets effort aliases unchecked when T3 does not serve its catalog", async () => {
    const fake = await fakeT3({
      rpcHandlers: {
        "server.getConfig": () => {
          throw new Error("catalog unavailable");
        },
      },
    });
    const { thread } = fake.addThread();

    const result = await updateThreadSettings(fake.config, { threadId: thread.id, change: { thinkingEffort: "high" } });

    expect(result.changes.catalogUsed).toBe(false);
    expect(fake.commands[0]).toMatchObject({
      type: "thread.model-selection.set",
      modelSelection: { options: expect.arrayContaining([{ id: "reasoningEffort", value: "high" }, { id: "variant", value: "high" }]) },
    });
  });

  it("reports settings that are already in place without dispatching", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread();

    const result = await updateThreadSettings(fake.config, { threadId: thread.id, change: { runtimeMode: "full-access" } });

    expect(result).toMatchObject({ changed: false, commands: [], dispatches: [] });
    expect(fake.commands).toEqual([]);
  });

  it("refuses empty changes, archived threads, and permission changes during a turn", async () => {
    const fake = await fakeT3({ runBehavior: "hold" });
    const archived = fake.addThread({ archivedAt: "2026-10-01T11:00:00.000Z" }).thread;
    const running = fake.addThread().thread;
    fake.startRun(running.id, "Working");

    await expect(updateThreadSettings(fake.config, { threadId: running.id, change: {} })).rejects.toMatchObject({
      code: "THREAD_SETTINGS_REQUIRED",
      exitCode: 2,
    });
    await expect(updateThreadSettings(fake.config, { threadId: archived.id, change: { interactionMode: "plan" } })).rejects.toMatchObject({
      code: "THREAD_ARCHIVED",
      exitCode: 4,
    });
    await expect(updateThreadSettings(fake.config, { threadId: running.id, change: { runtimeMode: "approval-required" } })).rejects.toMatchObject({
      code: "THREAD_BUSY",
    });
    expect(fake.commands).toEqual([]);
  });
});

describe("interruptThread", () => {
  it("interrupts the running turn and verifies that it stopped", async () => {
    const fake = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread();
    const running = fake.startRun(thread.id, "Working");
    const queued = fake.startRun(thread.id, "Next", { status: "queued" });

    const result = await interruptThread(fake.config, thread.id);

    expect(fake.commands).toEqual([expect.objectContaining({ type: "run.interrupt", threadId: thread.id, runId: running.id })]);
    // The queued run starts next; the result still describes the run that was interrupted.
    expect(fake.projection(thread.id).runs.find((candidate) => candidate.id === queued.id)?.status).toBe("running");
    expect(result).toMatchObject({ turnId: running.id, runStatus: "interrupted", thread: { id: thread.id } });
  });

  it("refuses a thread without a running turn", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread({ turns: 1 });

    await expect(interruptThread(fake.config, thread.id)).rejects.toMatchObject({ code: "THREAD_NOT_RUNNING", exitCode: 4 });
    expect(fake.commands).toEqual([]);
  });
});

/** A run that waits for a person; the fake's `complete` mode finishes it once someone responds. */
function waitingRun(fake: FakeT3, threadId: string): T3Run {
  return fake.startRun(threadId, "Needs a decision", { status: "waiting" });
}

/** Closes each runtime request another way than the one the CLI asked for. */
function closeRequestsAs(status: T3RuntimeRequest["status"]): NonNullable<FakeT3Options["rpcHandlers"]> {
  return {
    "orchestration.dispatchCommand": (payload, fake) => {
      const command = payload as Command;
      const request = fake.projection(command.threadId!).runtimeRequests.find((candidate) => candidate.id === command.requestId);
      if (request) request.status = status;
      fake.commands.push(command);
      return { sequence: fake.sequence };
    },
  };
}

describe("respondToApproval", () => {
  it("approves the pending approval and confirms that T3 resolved it", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread();
    const approval = fake.addApproval(thread.id, waitingRun(fake, thread.id).id, { prompt: "git push" });

    const result = await respondToApproval(fake.config, { threadId: thread.id, decision: "accept" });

    expect(fake.commands).toEqual([
      expect.objectContaining({ type: "runtime-request.respond", threadId: thread.id, requestId: approval.id, decision: "accept" }),
    ]);
    expect(result).toMatchObject({
      decision: "accept",
      request: { requestId: approval.id, detail: "git push", decisions: ["accept", "acceptForSession", "decline", "cancel"] },
      verification: { resolved: true, resolvedAt: expect.any(String) },
    });
    expect(result).not.toHaveProperty("wait");
  });

  it("accepts only the decisions an approval offers", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread();
    const runId = waitingRun(fake, thread.id).id;
    const approval = fake.addApproval(thread.id, runId, { options: ["accept", "decline"] });

    await expect(respondToApproval(fake.config, { threadId: thread.id, decision: "acceptForSession" })).rejects.toMatchObject({
      code: "DECISION_NOT_OFFERED",
      exitCode: 2,
      message: "This approval does not offer acceptForSession. It offers accept, decline.",
      details: { requestId: approval.id, offered: ["accept", "decline"] },
    });
    expect(fake.commands).toEqual([]);

    await respondToApproval(fake.config, { threadId: thread.id, decision: "decline" });
    expect(fake.commands).toEqual([expect.objectContaining({ decision: "decline" })]);
  });

  it("sends acceptAlways only when the approval offers it", async () => {
    const fake = await fakeT3();
    const silent = fake.addThread().thread;
    fake.addApproval(silent.id, waitingRun(fake, silent.id).id, { options: [] });
    const offering = fake.addThread().thread;
    fake.addApproval(offering.id, waitingRun(fake, offering.id).id, { options: ["accept", "acceptAlways"] });

    // An approval that lists no decisions takes any decision except acceptAlways.
    await expect(respondToApproval(fake.config, { threadId: silent.id, decision: "acceptAlways" })).rejects.toMatchObject({
      code: "DECISION_NOT_OFFERED",
      message: "This approval does not offer acceptAlways.",
    });
    await respondToApproval(fake.config, { threadId: silent.id, decision: "accept" });
    await respondToApproval(fake.config, { threadId: offering.id, decision: "acceptAlways" });

    expect(fake.commands.map((command) => command.decision)).toEqual(["accept", "acceptAlways"]);
  });

  it("refuses an approval whose provider session is gone", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread({ turns: 1 });
    fake.addApproval(thread.id, fake.projection(thread.id).runs[0]!.id, { capability: "not_resumable" });

    const failure = await respondToApproval(fake.config, { threadId: thread.id, decision: "accept" }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "REQUEST_NOT_ANSWERABLE", exitCode: 4 });
    expect((failure as Error).message).not.toContain("--dismiss");
    expect(fake.commands).toEqual([]);
  });

  it.each(["cancelled", "expired"] as const)("fails when T3 closes the request as %s", async (status) => {
    const fake = await fakeT3({ rpcHandlers: closeRequestsAs(status) });
    const { thread } = fake.addThread();
    const approval = fake.addApproval(thread.id, waitingRun(fake, thread.id).id);

    await expect(respondToApproval(fake.config, { threadId: thread.id, decision: "accept" })).rejects.toMatchObject({
      code: "THREAD_RESPONSE_FAILED",
      exitCode: 4,
      details: { threadId: thread.id, requestId: approval.id, status },
    });
  });

  it("picks the approval to answer and refuses a missing or ambiguous one", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread();
    const runId = waitingRun(fake, thread.id).id;

    await expect(respondToApproval(fake.config, { threadId: thread.id, decision: "accept" })).rejects.toMatchObject({
      code: "THREAD_REQUEST_NOT_FOUND",
      exitCode: 3,
    });
    const first = fake.addApproval(thread.id, runId, { prompt: "git push" });
    const second = fake.addApproval(thread.id, runId, { prompt: "rm -rf build" });

    await expect(respondToApproval(fake.config, { threadId: thread.id, decision: "accept" })).rejects.toMatchObject({
      code: "THREAD_REQUEST_AMBIGUOUS",
      exitCode: 2,
      details: { pending: [first.id, second.id] },
    });
    await expect(respondToApproval(fake.config, { threadId: thread.id, requestId: "unknown", decision: "accept" })).rejects.toMatchObject({
      code: "THREAD_REQUEST_NOT_FOUND",
      details: { requestId: "unknown", pending: [first.id, second.id] },
    });
    const result = await respondToApproval(fake.config, { threadId: thread.id, requestId: second.id, decision: "decline" });
    expect(result.request.detail).toBe("rm -rf build");
  });

  it("waits for the turn to continue after the approval", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread();
    fake.addApproval(thread.id, waitingRun(fake, thread.id).id);

    const result = await respondToApproval(fake.config, { threadId: thread.id, decision: "accept", wait: { timeoutMs: 10_000 } });

    expect(result.wait).toMatchObject({ outcome: "completed", turnIndex: 1, statusAfter: "active" });
    expect(result.reply?.messages.map((message) => message.text)).toEqual(["Needs a decision", "Reply to: Needs a decision"]);
  });

  it("reports a response T3 accepted when the wait after it times out", async () => {
    const fake = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread();
    const approval = fake.addApproval(thread.id, fake.startRun(thread.id, "Working").id);

    await expect(
      respondToApproval(fake.config, { threadId: thread.id, decision: "accept", wait: { timeoutMs: 50 } }),
    ).rejects.toMatchObject({ code: "THREAD_WAIT_TIMEOUT", exitCode: 6, details: { responded: true, requestId: approval.id } });
    expect(fake.commands).toEqual([expect.objectContaining({ type: "runtime-request.respond", requestId: approval.id })]);
  });
});

const branchQuestion = [
  { id: "q1", header: "Branch", question: "Which branch?", options: [{ label: "Main", value: "main" }, { label: "Dev" }] },
];

describe("answerThread", () => {
  it("answers a live question with the option's value", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread();
    const question = fake.addQuestion(thread.id, waitingRun(fake, thread.id).id, branchQuestion);

    const result = await answerThread(fake.config, { threadId: thread.id, answers: ["Main"] });

    expect(fake.commands).toEqual([
      expect.objectContaining({ type: "runtime-request.respond", requestId: question.id, answers: { q1: "main" } }),
    ]);
    expect(result).toMatchObject({
      dismissed: false,
      answers: { q1: "main" },
      startsTurn: false,
      thread: { id: thread.id, status: "active" },
      verification: { resolved: true, status: "resolved" },
    });
  });

  it("answers a message-mode question and waits for the turn that continues with it", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread({ turns: 1 });
    const question = fake.addQuestion(
      thread.id,
      fake.projection(thread.id).runs[0]!.id,
      [{ id: "0", header: "Question", question: "Which apps?", options: [{ label: "Reuse the existing apps" }] }],
      { capability: "message" },
    );

    const result = await answerThread(fake.config, { threadId: thread.id, answers: ["reuse the existing apps"], wait: { timeoutMs: 10_000 } });

    expect(fake.commands).toEqual([
      expect.objectContaining({ type: "runtime-request.respond", requestId: question.id, answers: { "0": "Reuse the existing apps" } }),
    ]);
    expect(result).toMatchObject({ startsTurn: true, request: { responseMode: "message", blocking: false }, wait: { outcome: "completed", turnIndex: 2 } });
  });

  it("answers an older question that the recent window of the thread leaves out", async () => {
    const fake = await fakeT3({ boundedTurnItems: 2 });
    const { thread } = fake.addThread({ turns: 1 });
    const question = fake.addQuestion(
      thread.id,
      fake.projection(thread.id).runs[0]!.id,
      [{ id: "0", header: "Question", question: "Which apps?", options: [{ label: "Reuse the existing apps" }] }],
      { capability: "message" },
    );
    // Later turns push the question's timeline item out of the bounded window.
    for (const prompt of ["Next", "And next"]) {
      const run = fake.startRun(thread.id, prompt);
      if (run.status !== "completed") fake.completeRun(thread.id, run.id);
    }

    const result = await answerThread(fake.config, { threadId: thread.id, answers: ["reuse the existing apps"] });

    expect(result.request.questions.map((entry) => entry.question)).toEqual(["Which apps?"]);
    expect(fake.commands).toContainEqual(
      expect.objectContaining({ type: "runtime-request.respond", requestId: question.id, answers: { "0": "Reuse the existing apps" } }),
    );
  });

  it("dismisses only questions that no live turn waits on", async () => {
    const fake = await fakeT3();
    const live = fake.addThread().thread;
    fake.addQuestion(live.id, waitingRun(fake, live.id).id, branchQuestion);
    const later = fake.addThread({ turns: 1 }).thread;
    const messageQuestion = fake.addQuestion(later.id, fake.projection(later.id).runs[0]!.id, branchQuestion, { capability: "message" });
    const stale = fake.addThread({ turns: 1 }).thread;
    const staleQuestion = fake.addQuestion(stale.id, fake.projection(stale.id).runs[0]!.id, branchQuestion, { capability: "not_resumable" });

    await expect(answerThread(fake.config, { threadId: live.id, dismiss: true })).rejects.toMatchObject({
      code: "DISMISS_UNSUPPORTED",
      exitCode: 2,
    });
    const dismissed = await answerThread(fake.config, { threadId: later.id, dismiss: true });
    await answerThread(fake.config, { threadId: stale.id, dismiss: true });

    expect(dismissed).toMatchObject({ dismissed: true, answers: null, startsTurn: false, verification: { status: "cancelled" } });
    expect(fake.commands).toEqual([
      expect.objectContaining({ type: "thread.user-input.dismiss", threadId: later.id, requestId: messageQuestion.id }),
      expect.objectContaining({ type: "thread.user-input.dismiss", threadId: stale.id, requestId: staleQuestion.id }),
    ]);
  });

  it("refuses to answer a question whose session is gone and points at dismissing it", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread({ turns: 1 });
    fake.addQuestion(thread.id, fake.projection(thread.id).runs[0]!.id, branchQuestion, { capability: "not_resumable" });

    await expect(answerThread(fake.config, { threadId: thread.id, answers: ["main"] })).rejects.toMatchObject({
      code: "REQUEST_NOT_ANSWERABLE",
      exitCode: 4,
      message: expect.stringContaining("Dismiss it with --dismiss."),
    });
    expect(fake.commands).toEqual([]);
  });

  it("needs either answers or --dismiss, and a pending question", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread();
    fake.addApproval(thread.id, waitingRun(fake, thread.id).id);

    await expect(answerThread(fake.config, { threadId: thread.id })).rejects.toMatchObject({ code: "ANSWER_REQUIRED", exitCode: 2 });
    await expect(answerThread(fake.config, { threadId: thread.id, answers: ["x"], dismiss: true })).rejects.toMatchObject({
      code: "ANSWER_REQUIRED",
    });
    // An approval is not a question.
    await expect(answerThread(fake.config, { threadId: thread.id, answers: ["x"] })).rejects.toMatchObject({
      code: "THREAD_REQUEST_NOT_FOUND",
      message: `Thread ${thread.id} has no pending question.`,
    });
  });

  it("reports an answer T3 accepted when the wait after it times out", async () => {
    const fake = await fakeT3({ runBehavior: "hold" });
    const { thread } = fake.addThread();
    const question = fake.addQuestion(thread.id, fake.startRun(thread.id, "Working").id, branchQuestion);

    await expect(answerThread(fake.config, { threadId: thread.id, answers: ["dev"], wait: { timeoutMs: 50 } })).rejects.toMatchObject({
      code: "THREAD_WAIT_TIMEOUT",
      details: { responded: true, requestId: question.id },
    });
    expect(fake.commands).toEqual([expect.objectContaining({ answers: { q1: "Dev" } })]);
  });
});

function question(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    kind: "user-input",
    requestId: "request-1",
    turnId: "run-1",
    responseMode: null,
    blocking: true,
    answerable: true,
    detail: null,
    requestKind: "user_input",
    decisions: [],
    questions: [
      {
        id: "Which branch?",
        header: "Branch",
        question: "Which branch?",
        options: ["Main", "Dev"],
        choices: [
          { label: "Main", value: "main", description: null },
          { label: "Dev", value: null, description: null },
        ],
        multiSelect: false,
        allowCustomAnswer: true,
      },
    ],
    createdAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("resolveAnswers", () => {
  it("takes a bare answer for a single question and sends option values", () => {
    expect(resolveAnswers(question(), ["main"])).toEqual({ "Which branch?": "main" });
    expect(resolveAnswers(question(), ["Main"])).toEqual({ "Which branch?": "main" });
    expect(resolveAnswers(question(), ["dev"])).toEqual({ "Which branch?": "Dev" });
    expect(resolveAnswers(question(), ["release/1.0"])).toEqual({ "Which branch?": "release/1.0" });
    // A single question also takes an answer that contains "=".
    expect(resolveAnswers(question(), ["a=b"])).toEqual({ "Which branch?": "a=b" });
  });

  it("addresses several questions by number, id, or header", () => {
    const request = question({
      questions: [
        { id: "q1", header: "Branch", question: "Which branch?", options: [], choices: [], multiSelect: false, allowCustomAnswer: true },
        {
          id: "q2",
          header: "Checks",
          question: "Which checks?",
          options: ["Lint", "Test"],
          choices: [
            { label: "Lint", value: "lint", description: null },
            { label: "Test", value: "test", description: null },
          ],
          multiSelect: true,
          allowCustomAnswer: false,
        },
      ],
    });

    expect(resolveAnswers(request, ["1=main", "checks=Lint", "q2=test"])).toEqual({ q1: "main", q2: ["lint", "test"] });
    expect(() => resolveAnswers(request, ["main"])).toThrow(expect.objectContaining({ code: "ANSWER_QUESTION_REQUIRED" }));
    expect(() => resolveAnswers(request, ["1=main"])).toThrow(expect.objectContaining({ code: "ANSWER_MISSING" }));
    // The second question allows only its options.
    expect(() => resolveAnswers(request, ["1=main", "2=build"])).toThrow(
      expect.objectContaining({ code: "INVALID_ANSWER", message: "Question 2 takes one of: Lint, Test." }),
    );
    expect(() => resolveAnswers(request, ["1=main", "1=dev", "2=lint"])).toThrow(
      expect.objectContaining({ code: "INVALID_ANSWER", message: "Question 1 takes a single answer." }),
    );
  });

  it("sends one string per question in message mode", () => {
    const request = question({ responseMode: "message", blocking: false });
    const multi = question({ responseMode: "message", questions: [{ ...question().questions[0]!, multiSelect: true }] });

    expect(resolveAnswers(request, ["Reuse the existing apps"])).toEqual({ "Which branch?": "Reuse the existing apps" });
    expect(resolveAnswers(multi, ["main"])).toEqual({ "Which branch?": "main" });
    expect(() => resolveAnswers(multi, ["main", "dev"])).toThrow(expect.objectContaining({ code: "INVALID_ANSWER" }));
    expect(() => resolveAnswers(request, ["   "])).toThrow(expect.objectContaining({ code: "INVALID_ANSWER" }));
  });

  it("refuses a request without questions", () => {
    expect(() => resolveAnswers(question({ questions: [] }), ["yes"])).toThrow(expect.objectContaining({ code: "ANSWER_UNSUPPORTED" }));
  });
});

describe("listModels", () => {
  it("lists the catalog's providers and models", async () => {
    const fake = await fakeT3();

    const result = await listModels(fake.config);
    const codex = await listModels(fake.config, { provider: "codex" });

    expect(result.providers.map((provider) => [provider.instanceId, provider.models.map((model) => model.slug)])).toEqual([
      ["codex", ["gpt-6-astra", "gpt-6-luna"]],
      ["claudeAgent", ["claude-opus-5-5"]],
    ]);
    expect(codex.providers.map((provider) => provider.instanceId)).toEqual(["codex"]);
    await expect(listModels(fake.config, { provider: "cursor" })).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
      exitCode: 3,
      details: { available: ["codex", "claudeAgent"] },
    });
  });
});
