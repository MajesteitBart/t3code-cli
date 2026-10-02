import { describe, expect, it } from "vitest";

import { buildTranscript, clip, pendingRequests, renderTranscript, selectTurn } from "./transcript.js";
import type { T3Message, T3Thread } from "./types.js";

function message(id: string, role: T3Message["role"], turnId: string | null, minute: number, text = id): T3Message {
  const at = `2026-09-04T10:${String(minute).padStart(2, "0")}:00.000Z`;
  return { id, role, text, turnId, streaming: false, createdAt: at, updatedAt: at };
}

function at(minute: number): string {
  return `2026-09-04T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

function thread(overrides: Partial<T3Thread> = {}): T3Thread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Implementation",
    archivedAt: null,
    messages: [],
    ...overrides,
  };
}

/** Two completed turns, each with reasoning, progress commentary, and a final answer. */
function twoTurnThread(): T3Thread {
  return thread({
    latestTurn: {
      turnId: "turn-2",
      state: "completed",
      requestedAt: at(10),
      startedAt: at(10),
      completedAt: at(14),
      assistantMessageId: "answer-2",
    },
    checkpoints: [{ turnId: "turn-1", files: [{ path: "src/a.ts", kind: "modified", additions: 3, deletions: 1 }], assistantMessageId: "answer-1", completedAt: at(5) }],
    messages: [
      message("prompt-1", "user", null, 0, "Build the feature"),
      message("reasoning:summary:turn-1:segment:1", "system", "turn-1", 1, "Thinking about it"),
      message("progress-1", "assistant", "turn-1", 2, "Looking at the code"),
      message("answer-1", "assistant", "turn-1", 4, "Built it"),
      message("prompt-2", "user", null, 10, "Now test it"),
      message("progress-2", "assistant", "turn-2", 11, "Running tests"),
      message("answer-2", "assistant", "turn-2", 13, "Tests pass"),
    ],
  });
}

describe("buildTranscript", () => {
  it("groups prompts with the turn they started and numbers turns", () => {
    const transcript = buildTranscript(twoTurnThread());

    expect(transcript.view).toEqual({
      detail: "messages",
      totalTurns: 2,
      returnedTurns: 2,
      omittedTurns: 0,
      firstTurnIncluded: true,
      maxChars: null,
    });
    expect(transcript.turns.map(({ index, turnId, state, finalMessageId }) => ({ index, turnId, state, finalMessageId }))).toEqual([
      // T3 reports only the latest turn's state, so an earlier turn's ending is unknown.
      { index: 1, turnId: "turn-1", state: null, finalMessageId: "answer-1" },
      { index: 2, turnId: "turn-2", state: "completed", finalMessageId: "answer-2" },
    ]);
    expect(transcript.messages.map((entry) => [entry.id, entry.turnIndex])).toEqual([
      ["prompt-1", 1],
      ["progress-1", 1],
      ["answer-1", 1],
      ["prompt-2", 2],
      ["progress-2", 2],
      ["answer-2", 2],
    ]);
  });

  it("keeps only prompts and final answers in answers detail", () => {
    const transcript = buildTranscript(twoTurnThread(), { detail: "answers" });

    expect(transcript.messages.map((entry) => entry.id)).toEqual(["prompt-1", "answer-1", "prompt-2", "answer-2"]);
    expect(transcript).not.toHaveProperty("toolCalls");
  });

  it("keeps a plan-mode turn's proposed plan at every detail level", () => {
    const source = twoTurnThread();
    source.proposedPlans = [{ id: "plan-1", turnId: "turn-2", planMarkdown: "# Plan\n- Add tests", createdAt: at(12) }];

    const transcript = buildTranscript(source, { detail: "answers", turns: 1 });

    expect(transcript.proposedPlans).toEqual([
      { id: "plan-1", turnId: "turn-2", turnIndex: 2, text: "# Plan\n- Add tests", textTruncated: false, createdAt: at(12) },
    ]);
    expect(renderTranscript(transcript)).toContain("### proposed plan\n# Plan\n- Add tests");
  });

  it("includes reasoning, changed files, and tool calls in full detail", () => {
    const source = twoTurnThread();
    source.activities = [
      { kind: "tool.started", turnId: "turn-1", createdAt: at(3), payload: { itemType: "command_execution", toolCallId: "call-1", status: "inProgress", title: "Command run", detail: "Bash: {}", data: { toolName: "Bash" } } },
      { kind: "tool.completed", turnId: "turn-1", createdAt: at(3), payload: { itemType: "command_execution", toolCallId: "call-1", status: "completed", detail: "Bash: pnpm test", data: { toolName: "Bash", command: "pnpm test", rawOutput: { content: "12 passed" } } } },
      // T3 can record an update with the completion's timestamp after the completion itself.
      { kind: "tool.updated", turnId: "turn-1", createdAt: at(3), payload: { itemType: "command_execution", toolCallId: "call-1", status: "inProgress", data: { toolName: "Bash" } } },
      { kind: "tool.completed", turnId: "turn-2", createdAt: at(12), payload: { itemType: "command_execution", toolCallId: "call-2", status: "failed", title: "Ran command", data: { item: { command: "npm run lint", aggregatedOutput: "2 errors" } } } },
      { kind: "tool.completed", turnId: "turn-2", createdAt: at(12), payload: { itemType: "file_change", toolCallId: "call-3", status: "completed", detail: "Edit: {}", data: { toolName: "Edit", files: [{ path: "src/b.ts" }] } } },
      { kind: "task.started", turnId: "turn-2", createdAt: at(12), payload: { taskId: "task-1", taskType: "local_bash", title: "Run the suite" } },
      { kind: "task.completed", turnId: "turn-2", createdAt: at(13), payload: { taskId: "task-1", status: "completed", title: "Run the suite" } },
    ];

    const transcript = buildTranscript(source, { detail: "full" });

    expect(transcript.messages.map((entry) => entry.id)).toContain("reasoning:summary:turn-1:segment:1");
    expect(transcript.turns[0]).toMatchObject({ toolCallCount: 1, changedFiles: [{ path: "src/a.ts", additions: 3, deletions: 1 }] });
    expect(transcript.toolCalls?.map(({ id, name, status, input, output, turnIndex }) => ({ id, name, status, input, output, turnIndex }))).toEqual([
      { id: "call-1", name: "Bash", status: "completed", input: "pnpm test", output: "12 passed", turnIndex: 1 },
      { id: "call-2", name: "Ran command", status: "failed", input: "npm run lint", output: "2 errors", turnIndex: 2 },
      { id: "call-3", name: "Edit", status: "completed", input: "src/b.ts", output: null, turnIndex: 2 },
      { id: "task:task-1", name: "local_bash", status: "completed", input: "Run the suite", output: null, turnIndex: 2 },
    ]);
  });

  it("treats system and reasoning roles and reasoning ids as reasoning", () => {
    const source = thread({
      messages: [
        message("prompt", "user", null, 0),
        message("summary", "system", "turn-1", 1),
        message("thought", "reasoning", "turn-1", 2),
        message("reasoning:summary:turn-1:segment:3", "assistant", "turn-1", 3),
        message("answer", "assistant", "turn-1", 4),
      ],
    });

    expect(buildTranscript(source).messages.map((entry) => entry.id)).toEqual(["prompt", "answer"]);
  });

  it("windows the last turns and can keep the original request", () => {
    const latest = buildTranscript(twoTurnThread(), { turns: 1 });
    expect(latest.view).toMatchObject({ returnedTurns: 1, omittedTurns: 1, firstTurnIncluded: false });
    expect(latest.messages.map((entry) => entry.id)).toEqual(["prompt-2", "progress-2", "answer-2"]);

    const withOrigin = buildTranscript(twoTurnThread(), { turns: 1, firstTurn: true, detail: "answers" });
    expect(withOrigin.view.firstTurnIncluded).toBe(true);
    expect(withOrigin.messages.map((entry) => entry.id)).toEqual(["prompt-1", "answer-1", "prompt-2", "answer-2"]);
  });

  it("folds a message sent during a running turn into that turn", () => {
    const source = thread({
      latestTurn: { turnId: "turn-1", state: "running", requestedAt: at(0), startedAt: at(0), completedAt: null, assistantMessageId: null },
      messages: [
        message("prompt", "user", null, 0),
        message("progress", "assistant", "turn-1", 1),
        message("steer", "user", null, 2),
        message("more", "assistant", "turn-1", 3),
      ],
    });

    const transcript = buildTranscript(source);

    expect(transcript.turns).toHaveLength(1);
    expect(transcript.turns[0]?.state).toBe("running");
    expect(transcript.messages.map((entry) => [entry.id, entry.turnIndex])).toEqual([
      ["prompt", 1],
      ["progress", 1],
      ["steer", 1],
      ["more", 1],
    ]);
  });

  it("keeps a folded message in its turn after later turns start", () => {
    const source = thread({
      session: { threadId: "thread-1", status: "ready", providerName: "claudeAgent", runtimeMode: "full-access", activeTurnId: null, lastError: null, updatedAt: at(12) },
      latestTurn: { turnId: "turn-2", state: "completed", requestedAt: at(10), startedAt: at(10), completedAt: at(12), assistantMessageId: "answer-2" },
      checkpoints: [{ turnId: "turn-1", completedAt: at(5) }],
      messages: [
        message("prompt-1", "user", null, 0),
        message("progress-1", "assistant", "turn-1", 1),
        message("steer", "user", null, 2),
        message("answer-1", "assistant", "turn-1", 4),
        message("prompt-2", "user", null, 10),
        message("answer-2", "assistant", "turn-2", 11),
      ],
    });

    expect(buildTranscript(source).messages.map((entry) => [entry.id, entry.turnIndex])).toEqual([
      ["prompt-1", 1],
      ["progress-1", 1],
      ["steer", 1],
      ["answer-1", 1],
      ["prompt-2", 2],
      ["answer-2", 2],
    ]);
  });

  it("gives a prompt sent as the previous turn completes to the turn it starts", () => {
    const source = thread({
      session: { threadId: "thread-1", status: "ready", providerName: "claudeAgent", runtimeMode: "full-access", activeTurnId: null, lastError: null, updatedAt: at(8) },
      latestTurn: { turnId: "turn-2", state: "completed", requestedAt: at(5), startedAt: at(5), completedAt: at(8), assistantMessageId: "answer-2" },
      // Turn 1 completes at the same millisecond as the prompt that starts turn 2.
      checkpoints: [{ turnId: "turn-1", completedAt: at(5) }],
      messages: [
        message("prompt-1", "user", null, 0),
        message("answer-1", "assistant", "turn-1", 1),
        message("prompt-2", "user", null, 5),
        message("answer-2", "assistant", "turn-2", 7),
      ],
    });

    expect(buildTranscript(source, { turns: 1 }).messages.map((entry) => entry.id)).toEqual(["prompt-2", "answer-2"]);
  });

  it("keeps a message sent into a finished turn with that turn when no turn follows", () => {
    // Live Codex threads fold an answer sent mid-turn into the running turn, just as Claude does.
    const source = thread({
      session: { threadId: "thread-1", status: "ready", providerName: "codex", runtimeMode: "full-access", activeTurnId: null, lastError: null, updatedAt: at(4) },
      latestTurn: { turnId: "turn-1", state: "completed", requestedAt: at(0), startedAt: at(0), completedAt: at(4), assistantMessageId: "answer-1" },
      messages: [
        message("prompt-1", "user", null, 0),
        message("progress-1", "assistant", "turn-1", 1),
        message("folded", "user", null, 2),
        message("answer-1", "assistant", "turn-1", 3),
      ],
    });

    const transcript = buildTranscript(source);

    expect(transcript.turns.map(({ index, state }) => [index, state])).toEqual([[1, "completed"]]);
    expect(transcript.messages.find((entry) => entry.id === "folded")?.turnIndex).toBe(1);
  });

  it("gives each message queued during a turn its own queued turn", () => {
    const second = (value: number) => `2026-09-04T10:04:${String(value).padStart(2, "0")}.000Z`;
    const at4 = (base: T3Message, value: number) => ({ ...base, createdAt: second(value), updatedAt: second(value) });
    const queuedDuringTurn1 = [
      at4(message("prompt-1", "user", null, 0), 0),
      at4(message("progress-1", "assistant", "turn-1", 0), 1),
      at4(message("queued-a", "user", null, 0), 2),
      at4(message("queued-b", "user", null, 0), 3),
      at4(message("answer-1", "assistant", "turn-1", 0), 9),
    ];
    const turn = (turnId: string, state: "running" | "completed", requested: number, completed: number | null) => ({
      turnId,
      state,
      requestedAt: second(requested),
      startedAt: second(requested),
      completedAt: completed === null ? null : second(completed),
      assistantMessageId: null,
    });
    const owners = (source: T3Thread) =>
      Object.fromEntries(buildTranscript(source).messages.map((entry) => [entry.id, entry.turnIndex]));

    // The first queued turn runs; the second message waits for its own turn.
    const firstQueued = thread({
      latestTurn: turn("turn-2", "running", 11, null),
      checkpoints: [{ turnId: "turn-1", completedAt: second(10) }],
      messages: [...queuedDuringTurn1, at4(message("progress-2", "assistant", "turn-2", 0), 12)],
    });
    expect(owners(firstQueued)).toMatchObject({ "queued-a": 2, "queued-b": 3, "answer-1": 1 });
    expect(buildTranscript(firstQueued).turns.at(-1)).toMatchObject({ index: 3, state: "pending" });

    // Both queued turns ran back to back.
    const bothQueued = thread({
      latestTurn: turn("turn-3", "completed", 14, 16),
      checkpoints: [{ turnId: "turn-1", completedAt: second(10) }, { turnId: "turn-2", completedAt: second(13) }],
      messages: [
        ...queuedDuringTurn1,
        at4(message("answer-2", "assistant", "turn-2", 0), 12),
        at4(message("answer-3", "assistant", "turn-3", 0), 15),
      ],
    });
    expect(owners(bothQueued)).toMatchObject({ "queued-a": 2, "queued-b": 3 });
  });

  it("gives a queued message to the turn that starts right after its turn ends", () => {
    const second = (value: number) => `2026-09-04T10:04:${String(value).padStart(2, "0")}.000Z`;
    const queuedThread = (extra: T3Message[]) =>
      thread({
        latestTurn: { turnId: "turn-2", state: "running", requestedAt: second(1), startedAt: second(1), completedAt: null, assistantMessageId: null },
        checkpoints: [{ turnId: "turn-1", completedAt: second(0) }],
        messages: [
          message("prompt-1", "user", null, 0),
          message("progress-1", "assistant", "turn-1", 1),
          message("queued", "user", null, 2),
          message("answer-1", "assistant", "turn-1", 3),
          ...extra,
          { ...message("progress-2", "assistant", "turn-2", 0), createdAt: second(2), updatedAt: second(2) },
        ],
      });

    // Turn 2 started one second after turn 1 ended, without a prompt of its own: it took the queued message.
    expect(buildTranscript(queuedThread([])).messages.map((entry) => [entry.id, entry.turnIndex])).toEqual([
      ["prompt-1", 1],
      ["progress-1", 1],
      ["answer-1", 1],
      ["queued", 2],
      ["progress-2", 2],
    ]);

    // With its own prompt, turn 2 answers that prompt, and the earlier message stays where it was sent.
    const ownPrompt = { ...message("prompt-2", "user", null, 0), createdAt: second(1), updatedAt: second(1) };
    expect(
      buildTranscript(queuedThread([ownPrompt])).messages.find((entry) => entry.id === "queued")?.turnIndex,
    ).toBe(1);
  });

  it("reports messages that no turn has picked up as pending", () => {
    const source = thread({
      latestTurn: { turnId: "turn-1", state: "completed", requestedAt: at(0), startedAt: at(0), completedAt: at(2), assistantMessageId: "answer" },
      messages: [message("prompt", "user", null, 0), message("answer", "assistant", "turn-1", 1), message("next", "user", null, 5)],
    });

    const transcript = buildTranscript(source, { turns: 1 });

    expect(transcript.view.totalTurns).toBe(1);
    expect(transcript.turns.map(({ index, turnId, state }) => ({ index, turnId, state }))).toEqual([
      { index: 1, turnId: "turn-1", state: "completed" },
      { index: 2, turnId: null, state: "pending" },
    ]);
    expect(transcript.messages.at(-1)).toMatchObject({ id: "next", turnIndex: 2 });
  });

  it("clips long text at the head and tail", () => {
    const transcript = buildTranscript(
      thread({ messages: [message("prompt", "user", null, 0, `start ${"x".repeat(500)} end`)] }),
      { maxChars: 100 },
    );

    const [entry] = transcript.messages;
    expect(entry?.textTruncated).toBe(true);
    expect(entry?.text.startsWith("start ")).toBe(true);
    expect(entry?.text.endsWith(" end")).toBe(true);
    expect(entry?.text).toContain("characters omitted");
    // The omission marker counts toward the limit.
    expect(entry?.text).toHaveLength(100);
    expect(clip("x".repeat(500), 10)).toEqual({ text: "x".repeat(10), truncated: true });
    expect(clip("short", 100)).toEqual({ text: "short", truncated: false });
  });
});

describe("selectTurn", () => {
  it("narrows a transcript to one turn without the caller's own message", () => {
    const transcript = selectTurn(buildTranscript(twoTurnThread(), { detail: "answers" }), 2, ["prompt-2"]);

    expect(transcript.turns.map((turn) => turn.index)).toEqual([2]);
    expect(transcript.messages.map((entry) => entry.id)).toEqual(["answer-2"]);
    expect(transcript.view).toMatchObject({ returnedTurns: 1, omittedTurns: 1, firstTurnIncluded: false });
  });
});

describe("pendingRequests", () => {
  it("lists open approvals and questions with what is needed to answer them", () => {
    const running = { turnId: "turn-2", state: "running" as const, requestedAt: at(5), startedAt: at(5), completedAt: null, assistantMessageId: null };
    const activities = [
      // A message-mode question from an earlier turn stays open; another was answered.
      {
        kind: "user-input.requested",
        turnId: "turn-1",
        createdAt: at(1),
        payload: { requestId: "async-open", responseMode: "message", questions: [{ id: "0", header: "Question", question: "Which OAuth apps?", options: [{ label: "Reuse", description: "" }], allowCustomAnswer: true, multiSelect: false }] },
      },
      { kind: "user-input.requested", turnId: "turn-1", createdAt: at(2), payload: { requestId: "async-done", responseMode: "message", questions: [{ id: "0", question: "Done?" }] } },
      { kind: "user-input.resolved", turnId: null, createdAt: at(3), payload: { requestId: "async-done", responseMode: "message" } },
      { kind: "approval.requested", turnId: "turn-2", createdAt: at(6), payload: { requestId: "approval", requestKind: "command", detail: "git push", options: [{ decision: "accept", label: "Allow" }, { decision: "decline", label: "Deny" }] } },
      { kind: "approval.requested", turnId: "turn-2", createdAt: at(6), payload: { requestId: "stale-approval", detail: "rm -rf build" } },
      { kind: "provider.approval.respond.failed", turnId: "turn-2", createdAt: at(7), payload: { requestId: "stale-approval", detail: "Stale pending approval request: stale-approval." } },
      {
        kind: "user-input.requested",
        turnId: "turn-2",
        createdAt: at(8),
        payload: { requestId: "question", questions: [{ id: "q1", header: "Target", question: "Which branch?", options: [{ label: "Main", value: "main" }, { label: "Dev" }], multiSelect: true }] },
      },
    ];

    expect(pendingRequests(thread({ activities, latestTurn: running }))).toEqual([
      {
        kind: "user-input",
        requestId: "async-open",
        turnId: "turn-1",
        responseMode: "message",
        blocking: false,
        detail: null,
        requestKind: null,
        decisions: [],
        questions: [{ id: "0", header: "Question", question: "Which OAuth apps?", options: ["Reuse"], choices: [{ label: "Reuse", value: null, description: null }], multiSelect: false, allowCustomAnswer: true }],
        createdAt: at(1),
      },
      {
        kind: "approval",
        requestId: "approval",
        turnId: "turn-2",
        responseMode: null,
        blocking: true,
        detail: "git push",
        requestKind: "command",
        decisions: ["accept", "decline"],
        questions: [],
        createdAt: at(6),
      },
      {
        kind: "user-input",
        requestId: "question",
        turnId: "turn-2",
        responseMode: null,
        blocking: true,
        detail: null,
        requestKind: null,
        decisions: [],
        questions: [{ id: "q1", header: "Target", question: "Which branch?", options: ["Main", "Dev"], choices: [{ label: "Main", value: "main", description: null }, { label: "Dev", value: null, description: null }], multiSelect: true, allowCustomAnswer: true }],
        createdAt: at(8),
      },
    ]);
    // The shell snapshot's flags, when present, close a kind of request entirely.
    expect(pendingRequests(thread({ activities, latestTurn: running, hasPendingApprovals: false, hasPendingUserInput: false }))).toEqual([]);
  });

  it("ignores the thread-wide pending flag for requests from an ended turn", () => {
    const running = { turnId: "turn-2", state: "running" as const, requestedAt: at(5), startedAt: at(5), completedAt: null, assistantMessageId: null };
    const activities = [
      { kind: "approval.requested", turnId: "turn-1", createdAt: at(1), payload: { requestId: "stale", detail: "old" } },
      { kind: "approval.requested", turnId: "turn-2", createdAt: at(6), payload: { requestId: "live", detail: "git status" } },
    ];

    // The flag says some approval is pending; only the one in the running turn can be answered.
    expect(
      pendingRequests(thread({ activities, latestTurn: running, hasPendingApprovals: true })).map((request) => request.requestId),
    ).toEqual(["live"]);
  });

  it("drops ordinary questions whose turn ended and keeps the request kind as detail", () => {
    const completed = { turnId: "turn-1", state: "completed" as const, requestedAt: at(0), startedAt: at(0), completedAt: at(3), assistantMessageId: null };
    const activities = [
      { kind: "user-input.requested", turnId: "turn-1", createdAt: at(1), payload: { requestId: "ordinary", questions: [{ id: "q", question: "Which?" }] } },
      { kind: "user-input.requested", turnId: "turn-1", createdAt: at(2), payload: { requestId: "async", responseMode: "message", questions: [{ id: "0", question: "Later?" }] } },
    ];
    expect(pendingRequests(thread({ activities, latestTurn: completed })).map((request) => request.requestId)).toEqual(["async"]);

    const running = { ...completed, state: "running" as const, completedAt: null };
    const approval = { kind: "approval.requested", turnId: "turn-1", createdAt: at(1), summary: "Command approval requested", payload: { requestId: "a", requestKind: "command" } };
    expect(pendingRequests(thread({ activities: [approval], latestTurn: running }))[0]?.detail).toBe("command");
  });

  it("derives pending requests from a running turn when T3 omits its flags", () => {
    // The thread detail endpoint carries request activities but not the shell's pending flags.
    const activities = [
      { kind: "approval.requested", turnId: "turn-1", createdAt: at(1), payload: { requestId: "stale", detail: "old" } },
      { kind: "approval.requested", turnId: "turn-2", createdAt: at(5), payload: { requestId: "live", detail: "git status" } },
    ];
    const running = { turnId: "turn-2", state: "running" as const, requestedAt: at(4), startedAt: at(4), completedAt: null, assistantMessageId: null };

    expect(pendingRequests(thread({ activities, latestTurn: running })).map((request) => request.requestId)).toEqual(["live"]);
    expect(pendingRequests(thread({ activities, latestTurn: { ...running, state: "completed", completedAt: at(6) } }))).toEqual([]);
  });
});

describe("renderTranscript", () => {
  it("renders turns as Markdown with the final answer marked", () => {
    const rendered = renderTranscript(buildTranscript(twoTurnThread(), { detail: "answers" }));

    expect(rendered).toBe(
      [
        "## Turn 1 · 2026-09-04 10:00:00Z",
        "",
        "### user · 2026-09-04 10:00:00Z",
        "Build the feature",
        "",
        "### assistant (final) · 2026-09-04 10:04:00Z",
        "Built it",
        "",
        "## Turn 2 · completed · 2026-09-04 10:10:00Z",
        "",
        "### user · 2026-09-04 10:10:00Z",
        "Now test it",
        "",
        "### assistant (final) · 2026-09-04 10:13:00Z",
        "Tests pass",
      ].join("\n"),
    );
  });

  it("collects consecutive tool calls into one block and lists changed files", () => {
    const source = twoTurnThread();
    source.activities = [
      { kind: "tool.completed", turnId: "turn-1", createdAt: at(3), payload: { itemType: "command_execution", toolCallId: "a", status: "completed", data: { toolName: "Bash", command: "ls", rawOutput: { content: "3 lines" } } } },
      { kind: "tool.completed", turnId: "turn-1", createdAt: at(3), payload: { itemType: "command_execution", toolCallId: "b", status: "failed", data: { toolName: "Bash", command: "false" } } },
    ];

    const rendered = renderTranscript(buildTranscript(source, { detail: "full", turns: 1, firstTurn: true }));

    expect(rendered).toContain("### tools\n- Bash: ls\n> 3 lines\n- Bash (failed): false");
    expect(rendered).toContain("### changed files\n- modified src/a.ts (+3 -1)");
  });
});
