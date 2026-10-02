import { describe, expect, it } from "vitest";

import type { T3Api } from "./api.js";
import { CliError } from "./errors.js";
import { T3ThreadApi } from "./threadApi.js";
import type { OrchestrationSnapshot, T3Message, T3Thread, ThreadDetailSnapshot } from "./types.js";

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

describe("T3ThreadApi.waitForTurn", () => {
  const at = (minute: number) => `2026-09-04T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const message = (id: string, role: T3Message["role"], turnId: string | null, minute: number): T3Message => ({
    id,
    role,
    text: id,
    turnId,
    streaming: false,
    createdAt: at(minute),
    updatedAt: at(minute),
  });
  const turn = (turnId: string, state: "running" | "completed", requested: number, completed: number | null) => ({
    turnId,
    state,
    requestedAt: at(requested),
    startedAt: at(requested),
    completedAt: completed === null ? null : at(completed),
    assistantMessageId: null,
  });
  const session = (status: "running" | "ready") => ({
    threadId: "thread-1",
    status,
    providerName: "codex",
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: at(0),
  });
  const firstTurn = [message("prompt-1", "user", null, 0), message("answer-1", "assistant", "turn-1", 1)];

  /** Serves the given thread states in order and repeats the last one. */
  function scripted(states: T3Thread[]) {
    let reads = 0;
    const paths: string[] = [];
    const adapter = new T3ThreadApi(
      mockApi({
        request: async (_method, requestPath) => {
          paths.push(requestPath);
          return { snapshotSequence: reads, thread: states[Math.min(reads++, states.length - 1)]! };
        },
      }),
      { waitIntervalMs: 0 },
    );
    return { adapter, reads: () => reads, paths };
  }

  it("waits for the turn that handles the sent message and confirms it finished", async () => {
    const sent = message("sent", "user", null, 10);
    const { adapter, reads } = scripted([
      thread({ latestTurn: turn("turn-1", "completed", 0, 2), session: session("ready"), messages: [...firstTurn, sent] }),
      thread({
        latestTurn: turn("turn-2", "running", 10, null),
        session: session("running"),
        messages: [...firstTurn, sent, message("progress-2", "assistant", "turn-2", 11)],
      }),
      thread({
        latestTurn: turn("turn-2", "completed", 10, 12),
        session: session("ready"),
        messages: [...firstTurn, sent, message("answer-2", "assistant", "turn-2", 12)],
      }),
    ]);

    const result = await adapter.waitForTurn("thread-1", { messageId: "sent", timeoutMs: 1_000 });

    expect(result).toMatchObject({ outcome: "completed", turnIndex: 2 });
    // Four bounded polls, then one read of the whole thread.
    expect(reads()).toBe(5);
  });

  it("keeps waiting while a queued Codex turn has not started yet", async () => {
    const sent = message("sent", "user", null, 5);
    const gap = thread({ latestTurn: turn("turn-1", "completed", 0, 6), session: session("ready"), messages: [...firstTurn, sent] });
    const { adapter } = scripted([
      thread({ latestTurn: turn("turn-1", "running", 0, null), session: session("running"), messages: [...firstTurn, sent] }),
      // The running turn finished, but the queued turn only starts several polls later.
      gap,
      gap,
      gap,
      thread({
        latestTurn: turn("turn-2", "running", 7, null),
        session: session("running"),
        messages: [...firstTurn, sent, message("progress-2", "assistant", "turn-2", 8)],
      }),
      thread({
        latestTurn: turn("turn-2", "completed", 7, 9),
        session: session("ready"),
        messages: [...firstTurn, sent, message("answer-2", "assistant", "turn-2", 9)],
      }),
    ]);

    await expect(adapter.waitForTurn("thread-1", { messageId: "sent", timeoutMs: 1_000 })).resolves.toMatchObject({
      outcome: "completed",
      turnIndex: 2,
    });
  });

  it("reports a start failure while waiting without a message id", async () => {
    const { adapter } = scripted([
      thread({
        latestTurn: turn("turn-1", "completed", 0, 2),
        session: session("ready"),
        messages: [...firstTurn, message("failed", "user", null, 10)],
        activities: [{ kind: "provider.turn.start.failed", createdAt: at(10), payload: { requestId: "failed", detail: "Model unavailable" } }],
      }),
    ]);

    await expect(adapter.waitForTurn("thread-1", { timeoutMs: 1_000 })).resolves.toMatchObject({
      outcome: "error",
      error: "Model unavailable",
    });
  });

  it("does not let an older start failure override later work", async () => {
    const { adapter } = scripted([
      thread({
        latestTurn: turn("turn-2", "completed", 10, 12),
        session: session("ready"),
        messages: [
          ...firstTurn,
          message("failed", "user", null, 5),
          message("prompt-2", "user", null, 10),
          message("answer-2", "assistant", "turn-2", 11),
        ],
        activities: [{ kind: "provider.turn.start.failed", createdAt: at(5), payload: { requestId: "failed", detail: "Model unavailable" } }],
      }),
    ]);

    await expect(adapter.waitForTurn("thread-1", { timeoutMs: 1_000 })).resolves.toMatchObject({
      outcome: "completed",
      turnIndex: 2,
    });
  });

  it("polls a bounded window and reads the whole thread once at the end", async () => {
    const { adapter, paths } = scripted([
      thread({ latestTurn: turn("turn-1", "running", 0, null), session: session("running"), messages: firstTurn }),
      thread({ latestTurn: turn("turn-1", "completed", 0, 2), session: session("ready"), messages: firstTurn }),
    ]);

    await adapter.waitForTurn("thread-1", { timeoutMs: 1_000 });

    expect(paths.slice(0, -1).every((requestPath) => requestPath.endsWith("?turnLimit=10"))).toBe(true);
    expect(paths.at(-1)).toBe("/api/orchestration/threads/thread-1");
  });

  it("keeps an interrupted turn interrupted after a later turn becomes the latest", async () => {
    const interrupted = { ...turn("turn-1", "completed", 0, 2), state: "interrupted" as const };
    const laterTurn = [...firstTurn, message("prompt-2", "user", null, 10), message("progress-2", "assistant", "turn-2", 11)];
    const { adapter } = scripted([
      thread({ latestTurn: interrupted, session: session("ready"), messages: firstTurn }),
      // A queued turn starts before the wait confirms; T3 now reports only turn 2's state.
      thread({
        latestTurn: turn("turn-2", "running", 10, null),
        session: session("running"),
        checkpoints: [{ turnId: "turn-1", completedAt: at(2) }],
        messages: laterTurn,
      }),
    ]);

    await expect(adapter.waitForTurn("thread-1", { messageId: "prompt-1", timeoutMs: 1_000 })).resolves.toMatchObject({
      outcome: "interrupted",
      turnIndex: 1,
    });
  });

  it("returns a finished message's turn even when a later turn waits for an approval", async () => {
    const { adapter } = scripted([
      thread({
        latestTurn: turn("turn-2", "running", 10, null),
        session: session("running"),
        checkpoints: [{ turnId: "turn-1", completedAt: at(2) }],
        messages: [...firstTurn, message("prompt-2", "user", null, 10), message("progress-2", "assistant", "turn-2", 11)],
        activities: [{ kind: "approval.requested", turnId: "turn-2", createdAt: at(12), payload: { requestId: "a", detail: "git push" } }],
      }),
    ]);

    await expect(adapter.waitForTurn("thread-1", { messageId: "prompt-1", timeoutMs: 1_000 })).resolves.toMatchObject({
      outcome: "completed",
      turnIndex: 1,
    });
    // Without a message, the wait reports the approval that holds up the thread.
    await expect(adapter.waitForTurn("thread-1", { timeoutMs: 1_000 })).resolves.toMatchObject({ outcome: "needs-attention" });
  });

  it("returns a message's own turn while a later turn runs", async () => {
    // Turn 1 answered prompt-1 and completed; turn 2 runs for a later prompt.
    const { adapter } = scripted([
      thread({
        latestTurn: turn("turn-2", "running", 10, null),
        session: session("running"),
        checkpoints: [{ turnId: "turn-1", completedAt: at(2) }],
        messages: [...firstTurn, message("prompt-2", "user", null, 10), message("progress-2", "assistant", "turn-2", 11)],
      }),
    ]);

    await expect(adapter.waitForTurn("thread-1", { messageId: "prompt-1", timeoutMs: 1_000 })).resolves.toMatchObject({
      outcome: "completed",
      turnIndex: 1,
    });
  });

  it("reports a provider that could not start the turn", async () => {
    const { adapter } = scripted([
      thread({
        latestTurn: turn("turn-1", "completed", 0, 2),
        session: session("ready"),
        messages: [...firstTurn, message("sent", "user", null, 10)],
        activities: [{ kind: "provider.turn.start.failed", createdAt: at(10), payload: { requestId: "sent", detail: "Model unavailable" } }],
      }),
    ]);

    await expect(adapter.waitForTurn("thread-1", { messageId: "sent", timeoutMs: 1_000 })).resolves.toMatchObject({
      outcome: "error",
      error: "Model unavailable",
    });
  });

  it("stops when the thread waits for a person", async () => {
    const { adapter, reads } = scripted([
      thread({
        latestTurn: turn("turn-1", "running", 0, null),
        session: session("running"),
        hasPendingUserInput: true,
        messages: firstTurn,
      }),
    ]);

    await expect(adapter.waitForTurn("thread-1", { timeoutMs: 1_000 })).resolves.toMatchObject({
      outcome: "needs-attention",
      turnIndex: 1,
    });
    expect(reads()).toBe(2);
  });

  it("notices an approval request in the running turn without T3's pending flags", async () => {
    const { adapter } = scripted([
      thread({
        latestTurn: turn("turn-1", "running", 0, null),
        session: session("running"),
        messages: firstTurn,
        activities: [{ kind: "approval.requested", turnId: "turn-1", createdAt: at(1), payload: { requestId: "r1", requestKind: "command", detail: "git status" } }],
      }),
    ]);

    await expect(adapter.waitForTurn("thread-1", { timeoutMs: 1_000 })).resolves.toMatchObject({ outcome: "needs-attention" });
  });

  it("waits for the latest turn when no message is given", async () => {
    const { adapter } = scripted([
      thread({ latestTurn: turn("turn-1", "running", 0, null), session: session("running"), messages: firstTurn }),
      thread({ latestTurn: turn("turn-1", "completed", 0, 2), session: session("ready"), messages: firstTurn }),
    ]);

    await expect(adapter.waitForTurn("thread-1", { timeoutMs: 1_000 })).resolves.toMatchObject({
      outcome: "completed",
      turnIndex: 1,
    });
  });

  it("times out with the last observed state", async () => {
    const { adapter } = scripted([
      thread({ latestTurn: turn("turn-1", "running", 0, null), session: session("running"), messages: firstTurn }),
    ]);

    await expect(adapter.waitForTurn("thread-1", { messageId: "prompt-1", timeoutMs: 20 })).rejects.toMatchObject({
      code: "THREAD_WAIT_TIMEOUT",
      exitCode: 6,
      details: { threadId: "thread-1", messageId: "prompt-1", sessionStatus: "running", latestTurn: { state: "running" } },
    } satisfies Partial<CliError>);
  });
});
