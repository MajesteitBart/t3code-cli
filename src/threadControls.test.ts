import { describe, expect, it } from "vitest";

import type { T3Api } from "./api.js";
import { parseCatalog } from "./catalog.js";
import { T3ThreadApi } from "./threadApi.js";
import { changeSettingsWithApi, planThreadSettings, resolveAnswers } from "./threadControls.js";
import type { PendingRequest } from "./transcript.js";
import type { T3Thread } from "./types.js";

const catalog = parseCatalog({
  providers: [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      continuation: { groupKey: "claude:one" },
      showInteractionModeToggle: true,
      models: [
        {
          slug: "claude-opus-5-5",
          capabilities: { optionDescriptors: [{ id: "effort", type: "select", options: [{ id: "high" }, { id: "max" }] }] },
        },
      ],
    },
    {
      instanceId: "claudeAgent_two",
      driver: "claudeAgent",
      continuation: { groupKey: "claude:one" },
      showInteractionModeToggle: true,
      models: [{ slug: "claude-opus-5-5", capabilities: { optionDescriptors: [] } }],
    },
    {
      instanceId: "codex",
      driver: "codex",
      continuation: { groupKey: "codex" },
      showInteractionModeToggle: true,
      models: [{ slug: "gpt-6-astra", capabilities: { optionDescriptors: [] } }],
    },
    {
      instanceId: "opencode",
      driver: "opencode",
      showInteractionModeToggle: false,
      models: [{ slug: "openrouter/aion-3.5", capabilities: { optionDescriptors: [] } }],
    },
  ],
});

function thread(overrides: Partial<T3Thread> = {}): T3Thread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Work",
    archivedAt: null,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    latestTurn: null,
    ...overrides,
  };
}

const runningSession = {
  threadId: "thread-1",
  status: "running" as const,
  providerName: "claudeAgent",
  runtimeMode: "full-access" as const,
  activeTurnId: "turn-1",
  lastError: null,
  updatedAt: "2026-10-02T10:00:00.000Z",
};

describe("planThreadSettings", () => {
  it("orders commands like T3 Code's composer and skips unchanged values", () => {
    const plan = planThreadSettings(
      thread(),
      { thinkingEffort: "max", runtimeMode: "approval-required", interactionMode: "plan" },
      catalog,
    );

    expect(plan.commands.map((command) => command.type)).toEqual([
      "thread.meta.update",
      "thread.runtime-mode.set",
      "thread.interaction-mode.set",
    ]);
    expect(plan.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "max" }] });
    expect(plan.commands[0]).not.toHaveProperty("createdAt");

    const unchanged = planThreadSettings(thread(), { thinkingEffort: "high", runtimeMode: "full-access" }, catalog);
    expect(unchanged.commands).toEqual([]);
  });

  it("refuses to move a started conversation to another driver", () => {
    expect(() =>
      planThreadSettings(thread({ session: { ...runningSession, status: "ready" } }), { provider: "codex", model: "gpt-6-astra" }, catalog),
    ).toThrow(expect.objectContaining({ code: "PROVIDER_SWITCH_UNSUPPORTED", exitCode: 4 }));

    // The same driver with compatible resume state can take over the conversation.
    const sameDriver = planThreadSettings(
      thread({ session: { ...runningSession, status: "ready" } }),
      { provider: "claudeAgent_two", model: "claude-opus-5-5" },
      catalog,
    );
    expect(sameDriver.modelSelection?.instanceId).toBe("claudeAgent_two");

    // A thread without a session or history has not started a conversation yet.
    expect(planThreadSettings(thread(), { provider: "codex", model: "gpt-6-astra" }, catalog).modelSelection?.instanceId).toBe("codex");
    // History without a live session still binds the conversation to its provider.
    const withHistory = thread({
      latestTurn: { turnId: "turn-1", state: "completed", requestedAt: "2026-10-02T10:00:00.000Z", startedAt: "2026-10-02T10:00:00.000Z", completedAt: "2026-10-02T10:01:00.000Z", assistantMessageId: null },
    });
    expect(() => planThreadSettings(withHistory, { provider: "codex", model: "gpt-6-astra" }, catalog)).toThrow(
      expect.objectContaining({ code: "PROVIDER_SWITCH_UNSUPPORTED" }),
    );
  });

  it("refuses a permission change that would restart a running turn", () => {
    expect(() => planThreadSettings(thread({ session: runningSession }), { runtimeMode: "approval-required" }, catalog)).toThrow(
      expect.objectContaining({ code: "THREAD_BUSY", exitCode: 4 }),
    );
    // Plan mode and model changes apply to the next turn, so they do not need an idle thread.
    expect(planThreadSettings(thread({ session: runningSession }), { interactionMode: "plan" }, catalog).commands).toHaveLength(1);
    // A session that is restarting after an earlier permission change runs no turn.
    const restarting = { ...runningSession, status: "starting" as const, activeTurnId: null };
    expect(planThreadSettings(thread({ session: restarting }), { runtimeMode: "auto" }, catalog).runtimeMode).toBe("auto");
  });

  it("checks that a new provider supports the plan mode the thread keeps", () => {
    const planning = thread({ interactionMode: "plan" });

    expect(() => planThreadSettings(planning, { provider: "opencode", model: "openrouter/aion-3.5" }, catalog)).toThrow(
      expect.objectContaining({ code: "PLAN_MODE_UNSUPPORTED" }),
    );
  });

  it("points OpenCode threads at its plan agent", () => {
    expect(() =>
      planThreadSettings(thread({ modelSelection: { instanceId: "opencode", model: "openrouter/aion-3.5" } }), { interactionMode: "plan" }, catalog),
    ).toThrow(expect.objectContaining({ code: "PLAN_MODE_UNSUPPORTED", message: expect.stringContaining("--option agent=plan") }));
  });

  it("falls back to every effort alias, including OpenCode's variant, without a catalog", () => {
    const plan = planThreadSettings(thread(), { thinkingEffort: "max" }, null);

    expect(plan.catalogUsed).toBe(false);
    expect(plan.modelSelection?.options).toEqual([
      { id: "effort", value: "max" },
      { id: "reasoningEffort", value: "max" },
      { id: "reasoning", value: "max" },
      { id: "variant", value: "max" },
    ]);
  });

  it("refuses a provider switch when neither instance names its resume state", () => {
    const keyless = parseCatalog({
      providers: [
        { instanceId: "acp-one", driver: "acp", models: [{ slug: "m", capabilities: { optionDescriptors: [] } }] },
        { instanceId: "acp-two", driver: "acp", models: [{ slug: "m", capabilities: { optionDescriptors: [] } }] },
      ],
    });
    const started = thread({ modelSelection: { instanceId: "acp-one", model: "m" }, session: { ...runningSession, status: "ready" } });

    expect(() => planThreadSettings(started, { provider: "acp-two", model: "m" }, keyless)).toThrow(
      expect.objectContaining({ code: "PROVIDER_SWITCH_UNSUPPORTED" }),
    );
  });
});

function question(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    kind: "user-input",
    requestId: "request-1",
    turnId: "turn-1",
    responseMode: null,
    blocking: true,
    detail: null,
    requestKind: null,
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
    createdAt: "2026-10-02T10:00:00.000Z",
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
    expect(() => resolveAnswers(request, ["1=main", "2=build"])).toThrow(expect.objectContaining({ code: "INVALID_ANSWER" }));
  });

  it("sends one string per question in message mode", () => {
    const request = question({ responseMode: "message", blocking: false });

    expect(resolveAnswers(request, ["Reuse the existing apps"])).toEqual({ "Which branch?": "Reuse the existing apps" });
    expect(() => resolveAnswers(request, ["main", "dev"])).toThrow(expect.objectContaining({ code: "INVALID_ANSWER" }));
    expect(() => resolveAnswers(request, ["   "])).toThrow(expect.objectContaining({ code: "INVALID_ANSWER" }));
  });
});

describe("changeSettingsWithApi", () => {
  /** Serves thread reads in order, repeats the last one, and has no catalog. */
  function scriptedApi(reads: T3Thread[], dispatched: unknown[]): T3Api {
    let index = 0;
    return {
      rpc: async () => {
        throw new Error("no catalog");
      },
      request: async () => ({ snapshotSequence: 1, thread: reads[Math.min(index++, reads.length - 1)] }),
      dispatch: async (command: unknown) => {
        dispatched.push(command);
        return { sequence: 2 };
      },
    } as unknown as T3Api;
  }
  const liveSession = { ...runningSession, status: "ready" as const, activeTurnId: null };

  it("waits for the live session to restart with the new permission mode", async () => {
    const dispatched: unknown[] = [];
    const before = thread({ session: liveSession });
    const saved = thread({ runtimeMode: "approval-required", session: liveSession });
    const restarted = thread({ runtimeMode: "approval-required", session: { ...liveSession, runtimeMode: "approval-required" } });
    const api = scriptedApi([saved, saved, restarted], dispatched);

    const result = await changeSettingsWithApi(api, new T3ThreadApi(api, { verificationIntervalMs: 0 }), before, {
      runtimeMode: "approval-required",
    });

    expect(dispatched).toEqual([expect.objectContaining({ type: "thread.runtime-mode.set", runtimeMode: "approval-required" })]);
    expect(result.sessionRestarted).toBe(true);
  });

  it("fails when the live session keeps its old permission mode", async () => {
    const before = thread({ session: liveSession });
    const stuck = thread({ runtimeMode: "approval-required", session: { ...liveSession, lastError: "restart failed" } });
    const api = scriptedApi([stuck], []);
    const adapter = new T3ThreadApi(api, { verificationIntervalMs: 0, controlTimeoutMs: 20 });

    await expect(changeSettingsWithApi(api, adapter, before, { runtimeMode: "approval-required" })).rejects.toMatchObject({
      code: "THREAD_PERMISSION_NOT_APPLIED",
      exitCode: 5,
      details: { sessionRuntimeMode: "full-access", lastError: "restart failed" },
    });
  });

  it("fails at once when the restart stops the session with a new error", async () => {
    const before = thread({ session: liveSession });
    const failed = thread({
      runtimeMode: "approval-required",
      session: { ...liveSession, status: "stopped", lastError: "Provider failed to restart" },
    });
    const api = scriptedApi([failed], []);
    const adapter = new T3ThreadApi(api, { verificationIntervalMs: 0, controlTimeoutMs: 60_000 });

    await expect(changeSettingsWithApi(api, adapter, before, { runtimeMode: "approval-required" })).rejects.toMatchObject({
      code: "THREAD_PERMISSION_NOT_APPLIED",
      details: { sessionStatus: "stopped", lastError: "Provider failed to restart" },
    });
  });

  it("does not count an errored session with the new mode as restarted", async () => {
    const before = thread({ session: liveSession });
    const errored = thread({
      runtimeMode: "approval-required",
      session: { ...liveSession, status: "error", runtimeMode: "approval-required", lastError: "Provider crashed" },
    });
    const api = scriptedApi([errored], []);
    const adapter = new T3ThreadApi(api, { verificationIntervalMs: 0, controlTimeoutMs: 60_000 });

    await expect(changeSettingsWithApi(api, adapter, before, { runtimeMode: "approval-required" })).rejects.toMatchObject({
      code: "THREAD_PERMISSION_NOT_APPLIED",
      details: { sessionStatus: "error", lastError: "Provider crashed" },
    });
  });

  it("waits through a stopped session to the restarted one", async () => {
    const before = thread({ session: liveSession });
    const stopping = thread({ runtimeMode: "approval-required", session: { ...liveSession, status: "stopped" } });
    const restarted = thread({ runtimeMode: "approval-required", session: { ...liveSession, runtimeMode: "approval-required" } });
    const api = scriptedApi([stopping, stopping, restarted], []);

    const result = await changeSettingsWithApi(api, new T3ThreadApi(api, { verificationIntervalMs: 0 }), before, {
      runtimeMode: "approval-required",
    });

    expect(result.sessionRestarted).toBe(true);
  });

  it("accepts a session that stays stopped without an error", async () => {
    const before = thread({ session: liveSession });
    const stopped = thread({ runtimeMode: "approval-required", session: { ...liveSession, status: "stopped" } });
    const api = scriptedApi([stopped], []);
    const adapter = new T3ThreadApi(api, { verificationIntervalMs: 0, controlTimeoutMs: 20 });

    const result = await changeSettingsWithApi(api, adapter, before, { runtimeMode: "approval-required" });

    // The next session starts with the saved mode, but nothing restarted now.
    expect(result.sessionRestarted).toBe(false);
  });

  it("reapplies a permission mode the live session never took", () => {
    const drifted = thread({ runtimeMode: "approval-required", session: liveSession });

    expect(planThreadSettings(drifted, { runtimeMode: "approval-required" }, null).runtimeMode).toBe("approval-required");
    expect(planThreadSettings(thread({ runtimeMode: "approval-required" }), { runtimeMode: "approval-required" }, null).commands).toEqual([]);
  });
});
