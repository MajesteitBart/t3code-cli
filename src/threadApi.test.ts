import { describe, expect, it } from "vitest";

import type { T3Api } from "./api.js";
import { CliError } from "./errors.js";
import { T3ThreadApi } from "./threadApi.js";
import type { OrchestrationSnapshot, T3Thread, ThreadDetailSnapshot } from "./types.js";

function thread(overrides: Partial<T3Thread> = {}): T3Thread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Implementation",
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
    messages: [],
    deletedAt: null,
    ...overrides,
  };
}

function snapshot(threads: T3Thread[], snapshotSequence = 1): OrchestrationSnapshot {
  return {
    snapshotSequence,
    projects: [{
      id: "project-1",
      title: "Project",
      workspaceRoot: "/project",
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      deletedAt: null,
    }],
    threads,
    updatedAt: "2026-09-04T10:00:00.000Z",
  };
}

function mockApi(overrides: Partial<T3Api> = {}): T3Api {
  return {
    shellSnapshot: async () => snapshot([thread()]),
    snapshot: async () => snapshot([thread()]),
    request: async () => ({ snapshotSequence: 1, thread: thread() } satisfies ThreadDetailSnapshot),
    dispatch: async () => ({ sequence: 2 }),
    ...overrides,
  } as unknown as T3Api;
}

describe("T3ThreadApi", () => {
  it("uses the unwindowed detail endpoint for a complete read", async () => {
    const paths: string[] = [];
    const adapter = new T3ThreadApi(mockApi({
      request: async (_method, requestPath) => {
        paths.push(requestPath);
        return { snapshotSequence: 1, thread: thread() } satisfies ThreadDetailSnapshot;
      },
    }));

    await adapter.read("thread-1");

    expect(paths).toEqual(["/api/orchestration/threads/thread-1"]);
  });

  it("uses a one-turn window for a last-turn read", async () => {
    const paths: string[] = [];
    const adapter = new T3ThreadApi(mockApi({
      request: async (_method, requestPath) => {
        paths.push(requestPath);
        return { snapshotSequence: 1, thread: thread() } satisfies ThreadDetailSnapshot;
      },
    }));

    await adapter.read("thread-1", { lastTurn: true });

    expect(paths).toEqual(["/api/orchestration/threads/thread-1?turnLimit=1"]);
  });

  it("keeps inspect bounded to recent turns", async () => {
    const paths: string[] = [];
    const adapter = new T3ThreadApi(mockApi({
      request: async (_method, requestPath) => {
        paths.push(requestPath);
        return { snapshotSequence: 1, thread: thread() } satisfies ThreadDetailSnapshot;
      },
    }));

    await adapter.inspect("thread-1");

    expect(paths).toEqual(["/api/orchestration/threads/thread-1?turnLimit=10"]);
  });

  it("builds the exact existing-thread turn payload without creation fields", () => {
    const adapter = new T3ThreadApi(mockApi());
    const command = adapter.buildTurnStart(thread(), "Review findings");

    expect(command).toMatchObject({
      type: "thread.turn.start",
      threadId: "thread-1",
      message: { role: "user", text: "Review findings", attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    expect(command).not.toHaveProperty("bootstrap");
    expect(command).not.toHaveProperty("titleSeed");
    expect(command).not.toHaveProperty("modelSelection");
  });

  it("preserves a saved auto runtime mode", () => {
    const adapter = new T3ThreadApi(mockApi());

    const command = adapter.buildTurnStart(thread({ runtimeMode: "auto" }), "Review findings");

    expect(command.runtimeMode).toBe("auto");
  });

  it("builds the installed settlement command payloads", () => {
    const adapter = new T3ThreadApi(mockApi());

    expect(adapter.buildSettlement("thread-1", "settled")).toMatchObject({
      type: "thread.settle",
      threadId: "thread-1",
    });
    expect(adapter.buildSettlement("thread-1", "active")).toMatchObject({
      type: "thread.unsettle",
      threadId: "thread-1",
      reason: "user",
    });
  });

  it("verifies acceptance by the exact projected message id", async () => {
    let projected: T3Thread = thread();
    const api = mockApi({
      dispatch: async (value: unknown) => {
        const command = value as ReturnType<T3ThreadApi["buildTurnStart"]>;
        projected = thread({
          updatedAt: command.createdAt,
          messages: [{
            id: command.message.messageId,
            role: "user",
            text: command.message.text,
            turnId: null,
            streaming: false,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          }],
        });
        return { sequence: 2 };
      },
      request: async () => ({ snapshotSequence: 2, thread: projected }),
    });
    const adapter = new T3ThreadApi(api);
    const command = adapter.buildTurnStart(thread(), "Review findings");

    const result = await adapter.dispatchTurn(command);

    expect(result.verification).toEqual({
      accepted: true,
      method: "message-id",
      snapshotSequence: 2,
      messageId: command.message.messageId,
    });
  });

  it("does not report success when dispatch returns before the target projection changes", async () => {
    const adapter = new T3ThreadApi(mockApi({
      request: async () => ({ snapshotSequence: 2, thread: thread() }),
    }), {
      verificationTimeoutMs: 1,
      verificationIntervalMs: 0,
    });
    const command = adapter.buildTurnStart(thread(), "Review findings");

    await expect(adapter.dispatchTurn(command)).rejects.toMatchObject({
      code: "THREAD_TURN_NOT_VERIFIED",
      exitCode: 5,
      details: {
        threadId: "thread-1",
        messageId: command.message.messageId,
        dispatchSequence: 2,
      },
    } satisfies Partial<CliError>);
  });

  it("does not accept a projection watermark without the exact message id", async () => {
    let projected = thread();
    const adapter = new T3ThreadApi(mockApi({
      dispatch: async (value: unknown) => {
        const command = value as ReturnType<T3ThreadApi["buildTurnStart"]>;
        projected = thread({
          updatedAt: command.createdAt,
          latestUserMessageAt: command.createdAt,
          messages: [],
        });
        return { sequence: 2 };
      },
      request: async () => ({ snapshotSequence: 2, thread: projected }),
    }), {
      verificationTimeoutMs: 1,
      verificationIntervalMs: 0,
    });
    const command = adapter.buildTurnStart(thread(), "Review findings");

    await expect(adapter.dispatchTurn(command)).rejects.toMatchObject({
      code: "THREAD_TURN_NOT_VERIFIED",
      exitCode: 5,
      details: {
        threadId: "thread-1",
        messageId: command.message.messageId,
        dispatchSequence: 2,
      },
    } satisfies Partial<CliError>);
  });

  it("verifies settlement against the projected lifecycle state", async () => {
    let projected = thread();
    const adapter = new T3ThreadApi(mockApi({
      dispatch: async () => {
        projected = thread({
          settledOverride: "settled",
          settledAt: "2026-09-04T12:00:00.000Z",
          updatedAt: "2026-09-04T12:00:00.000Z",
        });
        return { sequence: 2 };
      },
      request: async () => ({ snapshotSequence: 2, thread: projected }),
    }));

    const result = await adapter.dispatchSettlement(
      adapter.buildSettlement("thread-1", "settled"),
      "2026-09-04T10:00:00.000Z",
    );

    expect(result.verification).toEqual({
      accepted: true,
      state: "settled",
      snapshotSequence: 2,
      settledAt: "2026-09-04T12:00:00.000Z",
      unsettledAt: null,
    });
  });

  it("falls back to the full snapshot when the detail endpoint is unavailable", async () => {
    const expected = thread();
    const adapter = new T3ThreadApi(mockApi({
      request: async () => {
        throw new CliError("T3_API_ERROR", "not found", { details: { status: 404 } });
      },
      snapshot: async () => snapshot([expected], 7),
    }));

    await expect(adapter.inspect("thread-1")).resolves.toEqual({
      snapshotSequence: 7,
      thread: expected,
    });
  });
});
