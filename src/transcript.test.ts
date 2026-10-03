import { describe, expect, it } from "vitest";

import {
  activeRun,
  buildTranscript,
  busyState,
  clip,
  pendingRequests,
  queuedRuns,
  renderPendingRequests,
  renderTranscript,
  runMessage,
  selectTurn,
  turnStateOf,
} from "./transcript.js";
import {
  TERMINAL_RUN_STATUSES,
  type RunStatus,
  type T3Message,
  type T3Run,
  type T3RuntimeRequest,
  type T3ThreadProjection,
  type T3TurnItem,
} from "./types.js";

function at(minute: number): string {
  return `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

function run(ordinal: number, status: RunStatus, minute: number, overrides: Partial<T3Run> = {}): T3Run {
  return {
    id: `run-${ordinal}`,
    threadId: "thread-1",
    ordinal,
    userMessageId: `prompt-${ordinal}`,
    status,
    queuePosition: null,
    requestedAt: at(minute),
    startedAt: status === "queued" ? null : at(minute),
    completedAt: TERMINAL_RUN_STATUSES.includes(status) ? at(minute + 5) : null,
    ...overrides,
  };
}

function message(
  id: string,
  role: T3Message["role"],
  runId: string | null,
  minute: number,
  text = id,
  overrides: Partial<T3Message> = {},
): T3Message {
  return { id, role, runId, text, streaming: false, createdAt: at(minute), updatedAt: at(minute), ...overrides };
}

function item(id: string, type: string, runId: string | null, minute: number, fields: Record<string, unknown> = {}): T3TurnItem {
  return { id, type, runId, status: "completed", startedAt: at(minute), updatedAt: at(minute), ...fields };
}

function projection(parts: Partial<T3ThreadProjection> = {}): T3ThreadProjection {
  return {
    thread: { id: "thread-1", projectId: "project-1", title: "Implementation", archivedAt: null },
    runs: [],
    runtimeRequests: [],
    messages: [],
    turnItems: [],
    ...parts,
  };
}

/** Two completed runs, each with a prompt, progress commentary, and a final answer. */
function twoRunThread(): T3ThreadProjection {
  return projection({
    // Out of order on purpose: turns follow the runs, not the array.
    runs: [run(2, "completed", 10), run(1, "completed", 0)],
    messages: [
      message("answer-2", "assistant", "run-2", 13, "Tests pass"),
      message("prompt-1", "user", "run-1", 0, "Build the feature"),
      message("progress-1", "assistant", "run-1", 2, "Looking at the code"),
      message("answer-1", "assistant", "run-1", 4, "Built it"),
      message("prompt-2", "user", "run-2", 10, "Now test it"),
      message("progress-2", "assistant", "run-2", 11, "Running tests"),
    ],
    turnItems: [
      item("reasoning-1", "reasoning", "run-1", 1, { text: "Thinking about it", streaming: false }),
      item("command-1", "command_execution", "run-1", 3, { input: "pnpm test", output: "12 passed" }),
      item("checkpoint-1", "checkpoint", "run-1", 5, {
        files: [{ path: "src/a.ts", kind: "modified", additions: 3, deletions: 1 }, { kind: "ignored-without-path" }],
      }),
      item("edit-2", "file_change", "run-2", 12, { fileName: "src/b.ts", additions: 2, deletions: 0, diffStr: "+ok" }),
    ],
  });
}

describe("buildTranscript", () => {
  it("makes each run a turn, in run order", () => {
    const transcript = buildTranscript(twoRunThread());

    expect(transcript.view).toEqual({
      detail: "messages",
      totalTurns: 2,
      returnedTurns: 2,
      omittedTurns: 0,
      firstTurnIncluded: true,
      maxChars: null,
    });
    expect(transcript.turns).toEqual([
      {
        index: 1,
        turnId: "run-1",
        state: "completed",
        runStatus: "completed",
        imported: false,
        inherited: false,
        sourceThreadId: null,
        queuePosition: null,
        startedAt: at(0),
        completedAt: at(5),
        finalMessageId: "answer-1",
        messageCount: 3,
      },
      {
        index: 2,
        turnId: "run-2",
        state: "completed",
        runStatus: "completed",
        imported: false,
        inherited: false,
        sourceThreadId: null,
        queuePosition: null,
        startedAt: at(10),
        completedAt: at(15),
        finalMessageId: "answer-2",
        messageCount: 3,
      },
    ]);
    expect(transcript.messages.map((entry) => [entry.id, entry.turnId, entry.turnIndex])).toEqual([
      ["prompt-1", "run-1", 1],
      ["progress-1", "run-1", 1],
      ["answer-1", "run-1", 1],
      ["prompt-2", "run-2", 2],
      ["progress-2", "run-2", 2],
      ["answer-2", "run-2", 2],
    ]);
    expect(transcript).not.toHaveProperty("toolCalls");
    expect(transcript.proposedPlans).toEqual([]);
  });

  it("orders runs requested in the same millisecond by ordinal", () => {
    const source = projection({
      runs: [run(3, "completed", 0), run(1, "completed", 0), run(2, "completed", 0)],
      messages: [message("prompt-3", "user", "run-3", 0), message("prompt-1", "user", "run-1", 0), message("prompt-2", "user", "run-2", 0)],
    });

    expect(buildTranscript(source).turns.map((turn) => [turn.index, turn.turnId])).toEqual([
      [1, "run-1"],
      [2, "run-2"],
      [3, "run-3"],
    ]);
  });

  it("opens a turn at each user message of imported V1 history", () => {
    const source = projection({
      runs: [run(1, "completed", 20)],
      messages: [
        // An assistant message before any prompt still opens a turn.
        message("intro", "assistant", null, 0, "Welcome"),
        message("v1-prompt-1", "user", null, 1, "Old request"),
        message("v1-progress-1", "assistant", null, 2, "Working on it"),
        message("v1-answer-1", "assistant", null, 3, "Old answer"),
        message("v1-prompt-2", "user", null, 5, "Second old request"),
        message("v1-answer-2", "assistant", null, 6, "Second old answer"),
        message("prompt-1", "user", "run-1", 20, "First V2 request"),
        message("answer-1", "assistant", "run-1", 21, "First V2 answer"),
      ],
      turnItems: [
        item("v1-plan", "proposed_plan", null, 4, { planId: "plan-v1", markdown: "# Imported plan" }),
        item("v1-command", "command_execution", null, 2, { input: "ls" }),
      ],
    });

    const transcript = buildTranscript(source, { detail: "full" });

    expect(transcript.view).toMatchObject({ totalTurns: 4, returnedTurns: 4 });
    expect(
      transcript.turns.map(({ index, turnId, state, runStatus, imported, startedAt, completedAt, finalMessageId }) => ({
        index,
        turnId,
        state,
        runStatus,
        imported,
        startedAt,
        completedAt,
        finalMessageId,
      })),
    ).toEqual([
      { index: 1, turnId: null, state: null, runStatus: null, imported: true, startedAt: at(0), completedAt: null, finalMessageId: "intro" },
      { index: 2, turnId: null, state: null, runStatus: null, imported: true, startedAt: at(1), completedAt: null, finalMessageId: "v1-answer-1" },
      { index: 3, turnId: null, state: null, runStatus: null, imported: true, startedAt: at(5), completedAt: null, finalMessageId: "v1-answer-2" },
      { index: 4, turnId: "run-1", state: "completed", runStatus: "completed", imported: false, startedAt: at(20), completedAt: at(25), finalMessageId: "answer-1" },
    ]);
    expect(transcript.messages.map((entry) => [entry.id, entry.turnId, entry.turnIndex])).toEqual([
      ["intro", null, 1],
      ["v1-prompt-1", null, 2],
      ["v1-progress-1", null, 2],
      ["v1-answer-1", null, 2],
      ["v1-prompt-2", null, 3],
      ["v1-answer-2", null, 3],
      ["prompt-1", "run-1", 4],
      ["answer-1", "run-1", 4],
    ]);
    // Imported history has no runs, so it has no tool calls or changed files to attribute.
    expect(transcript.toolCalls).toEqual([]);
    expect(transcript.turns[1]?.changedFiles).toEqual([]);
    expect(transcript.proposedPlans).toEqual([
      { id: "plan-v1", turnId: null, turnIndex: null, text: "# Imported plan", textTruncated: false, createdAt: at(4) },
    ]);
    expect(renderTranscript(buildTranscript(source, { detail: "answers" }))).toContain("## Turn 2 · imported · 2026-10-01 10:01:00Z");
  });

  it("lists queued runs as pending turns after the started ones, in queue order", () => {
    const source = projection({
      runs: [
        run(1, "completed", 0),
        run(2, "running", 10),
        run(3, "queued", 11, { queuePosition: 2 }),
        run(4, "queued", 12, { queuePosition: 1 }),
      ],
      messages: [
        message("prompt-1", "user", "run-1", 0),
        message("answer-1", "assistant", "run-1", 1),
        message("prompt-2", "user", "run-2", 10),
        message("progress-2", "assistant", "run-2", 11, "Halfway", { streaming: true }),
        message("prompt-3", "user", "run-3", 11, "Third"),
        message("prompt-4", "user", "run-4", 12, "Fourth"),
      ],
    });

    const transcript = buildTranscript(source, { turns: 1 });

    expect(transcript.view).toMatchObject({ totalTurns: 2, returnedTurns: 1, omittedTurns: 1, firstTurnIncluded: false });
    expect(transcript.turns.map(({ index, turnId, state, runStatus, queuePosition, startedAt }) => ({ index, turnId, state, runStatus, queuePosition, startedAt }))).toEqual([
      { index: 2, turnId: "run-2", state: "running", runStatus: "running", queuePosition: null, startedAt: at(10) },
      { index: 3, turnId: "run-4", state: "pending", runStatus: "queued", queuePosition: 1, startedAt: null },
      { index: 4, turnId: "run-3", state: "pending", runStatus: "queued", queuePosition: 2, startedAt: null },
    ]);
    expect(transcript.messages.map((entry) => [entry.id, entry.turnIndex])).toEqual([
      ["prompt-2", 2],
      ["progress-2", 2],
      ["prompt-4", 3],
      ["prompt-3", 4],
    ]);
    const rendered = renderTranscript(transcript);
    // A running turn's newest message is its latest, not its final, answer.
    expect(rendered).toContain("### assistant (latest) · 2026-10-01 10:11:00Z\nHalfway");
    expect(rendered).toContain("## Queued · position 1\n\n### user · 2026-10-01 10:12:00Z\nFourth");
    expect(rendered.indexOf("## Queued · position 1")).toBeLessThan(rendered.indexOf("## Queued · position 2"));
  });

  it("starts a fork with the history it inherited from its source thread", () => {
    const inherited = (position: number, entry: T3TurnItem) => ({
      position,
      visibility: "inherited",
      sourceThreadId: "source-thread",
      sourceItemId: entry.id,
      item: entry,
    });
    const source = projection({
      runs: [run(1, "completed", 20)],
      messages: [message("fork-prompt", "user", "run-1", 20, "Try uppercase"), message("fork-answer", "assistant", "run-1", 21, "ZEBRA")],
      turnItems: [item("fork-command", "command_execution", "run-1", 20, { input: "ls" })],
      visibleTurnItems: [
        inherited(0, item("src-user", "user_message", "source-run-1", 0, { messageId: "src-prompt", text: "Reply with one" })),
        inherited(1, item("src-command", "command_execution", "source-run-1", 1, { input: "pnpm test", output: "ok" })),
        inherited(2, item("src-answer", "assistant_message", "source-run-1", 2, { messageId: "src-reply", text: "one", streaming: false })),
        { position: 3, visibility: "synthetic", sourceThreadId: "source-thread", sourceItemId: "fork", item: item("fork", "fork", null, 3) },
        { position: 4, visibility: "local", sourceThreadId: "thread-1", sourceItemId: "fork-prompt", item: item("x", "user_message", "run-1", 20) },
      ],
    });

    const transcript = buildTranscript(source, { detail: "full" });

    expect(transcript.turns.map(({ index, turnId, state, inherited: fromSource, sourceThreadId, imported }) => ({ index, turnId, state, fromSource, sourceThreadId, imported }))).toEqual([
      { index: 1, turnId: "source-run-1", state: null, fromSource: true, sourceThreadId: "source-thread", imported: false },
      { index: 2, turnId: "run-1", state: "completed", fromSource: false, sourceThreadId: null, imported: false },
    ]);
    expect(transcript.messages.map((entry) => [entry.id, entry.turnIndex])).toEqual([
      ["src-prompt", 1],
      ["src-reply", 1],
      ["fork-prompt", 2],
      ["fork-answer", 2],
    ]);
    expect(transcript.toolCalls?.map((call) => [call.id, call.turnIndex])).toEqual([
      ["src-command", 1],
      ["fork-command", 2],
    ]);
    expect(renderTranscript(transcript)).toContain("## Turn 1 · inherited from source-thread · 2026-10-01 10:00:00Z");
  });

  it("leaves out a queued run whose message moved into the running turn, and labels cancelled ones", () => {
    const source = projection({
      runs: [
        run(1, "running", 0),
        run(2, "cancelled", 1, { startedAt: null }),
        run(3, "cancelled", 2, { startedAt: null }),
      ],
      messages: [
        message("prompt-1", "user", "run-1", 0),
        message("promoted", "user", "run-1", 1, "Joined the running turn"),
        message("prompt-3", "user", "run-3", 2, "Cancelled while queued"),
      ],
    });

    const transcript = buildTranscript(source);

    expect(transcript.turns.map((turn) => [turn.index, turn.turnId, turn.state, turn.runStatus])).toEqual([
      [1, "run-1", "running", "running"],
      [2, "run-3", "interrupted", "cancelled"],
    ]);
    expect(renderTranscript(transcript)).toContain("## Turn 2 · cancelled · ");
  });

  it("keeps only prompts and final answers in answers detail", () => {
    const transcript = buildTranscript(twoRunThread(), { detail: "answers" });

    expect(transcript.messages.map((entry) => entry.id)).toEqual(["prompt-1", "answer-1", "prompt-2", "answer-2"]);
    expect(transcript.turns.map((turn) => turn.messageCount)).toEqual([2, 2]);
    expect(transcript).not.toHaveProperty("toolCalls");
    expect(transcript.turns[0]).not.toHaveProperty("changedFiles");
  });

  it("picks the last finished assistant message as the final answer", () => {
    const source = projection({
      runs: [run(1, "running", 0), run(2, "completed", 10)],
      messages: [
        message("prompt-1", "user", "run-1", 0),
        message("done-1", "assistant", "run-1", 1),
        message("streaming-1", "assistant", "run-1", 2, "still typing", { streaming: true }),
        message("prompt-2", "user", "run-2", 10),
        message("only-streaming-2", "assistant", "run-2", 11, "typing", { streaming: true }),
      ],
    });

    const transcript = buildTranscript(source, { detail: "answers" });

    expect(transcript.turns.map((turn) => turn.finalMessageId)).toEqual(["done-1", "only-streaming-2"]);
    expect(transcript.messages.map((entry) => entry.id)).toEqual(["prompt-1", "done-1", "prompt-2", "only-streaming-2"]);
  });

  it("adds reasoning, system messages, tool calls, and changed files in full detail", () => {
    const source = twoRunThread();
    source.messages.push(message("notice", "system", "run-1", 3, "Context compacted"));

    const messages = buildTranscript(source, { detail: "messages" });
    const full = buildTranscript(source, { detail: "full" });

    expect(messages.messages.map((entry) => entry.id)).not.toContain("notice");
    expect(full.messages.filter((entry) => entry.turnIndex === 1).map((entry) => [entry.id, entry.role])).toEqual([
      ["prompt-1", "user"],
      ["reasoning-1", "reasoning"],
      ["progress-1", "assistant"],
      ["notice", "system"],
      ["answer-1", "assistant"],
    ]);
    expect(full.messages.find((entry) => entry.id === "reasoning-1")).toMatchObject({ turnId: "run-1", text: "Thinking about it" });
    expect(full.turns.map(({ toolCallCount, changedFiles }) => ({ toolCallCount, changedFiles }))).toEqual([
      // A checkpoint lists the run's changed files.
      { toolCallCount: 1, changedFiles: [{ path: "src/a.ts", kind: "modified", additions: 3, deletions: 1 }] },
      // Without a checkpoint, the run's file changes stand in for it.
      { toolCallCount: 1, changedFiles: [{ path: "src/b.ts", kind: "changed", additions: 2, deletions: 0 }] },
    ]);
    expect(full.toolCalls?.map((call) => call.id)).toEqual(["command-1", "edit-2"]);
  });

  it("describes each kind of tool call in full detail", () => {
    const source = projection({
      runs: [run(1, "completed", 0)],
      messages: [message("prompt-1", "user", "run-1", 0)],
      turnItems: [
        item("command", "command_execution", "run-1", 1, { input: "pnpm test", output: "12 passed", status: "failed" }),
        item("edit", "file_change", "run-1", 1, { fileName: "src/a.ts", additions: 3, deletions: 1, diffStr: "@@ -1 +1 @@" }),
        item("new-file", "file_change", "run-1", 1, { fileName: "src/new.ts" }),
        item("search", "file_search", "run-1", 1, { pattern: "*.ts", results: [{ fileName: "a.ts" }, { fileName: "b.ts" }] }),
        item("web", "web_search", "run-1", 1, {
          patterns: ["t3 code v2", 42],
          results: [{ url: "https://t3.codes", title: "T3" }, { title: "Title only" }],
        }),
        item("tool", "dynamic_tool", "run-1", 1, { toolName: "browser.open", input: { url: "https://t3.codes" }, output: { ok: true } }),
        item("anonymous", "dynamic_tool", "run-1", 1, { toolName: null, input: "raw input" }),
        item("agent", "subagent", "run-1", 1, { prompt: "Review the diff", result: null, progress: "Halfway" }),
        item("approval", "approval_request", "run-1", 1, { requestId: "r1", requestKind: "command", prompt: "git push" }),
        item("question", "user_input_request", "run-1", 1, {
          requestId: "r2",
          questions: [{ id: "q1", question: "Which branch?" }],
          questionAnswer: { answers: { q1: "main" } },
        }),
        item("failure", "error", "run-1", 1, { failure: { message: "Rate limited" } }),
        item("todo", "todo_list", "run-1", 1, { explanation: "Plan", steps: [{ status: "completed", text: "Read" }, { text: "Write" }] }),
        item("note", "notification", "run-1", 1, { summary: "Heads up", detail: "Disk almost full" }),
        item("child", "thread_created", "run-1", 1, { targetThreadId: "thread-2", targetModel: "gpt-6-astra" }),
        item("compact", "compaction", "run-1", 1, { title: null, summary: "Compacted 40k tokens" }),
        item("interrupt", "run_interrupt_request", "run-1", 1, { title: null, message: "Stop requested" }),
        // Messages, reasoning, plans, and checkpoints are not tool calls.
        item("user-item", "user_message", "run-1", 1, { text: "x" }),
        item("assistant-item", "assistant_message", "run-1", 1, { text: "x" }),
        item("reasoning", "reasoning", "run-1", 1, { text: "x" }),
        item("plan", "proposed_plan", "run-1", 1, { markdown: "x" }),
        item("checkpoint", "checkpoint", "run-1", 1, { files: [] }),
        // A run that is not in the projection has no turn to attach to.
        item("orphan", "command_execution", "run-unknown", 1, { input: "ls" }),
      ],
    });

    const toolCalls = buildTranscript(source, { detail: "full" }).toolCalls ?? [];

    expect(toolCalls.map(({ id, kind, name, status, input, output, turnId, turnIndex }) => ({ id, kind, name, status, input, output, turnId, turnIndex }))).toEqual([
      { id: "command", kind: "command_execution", name: "command", status: "failed", input: "pnpm test", output: "12 passed", turnId: "run-1", turnIndex: 1 },
      { id: "edit", kind: "file_change", name: "file change", status: "completed", input: "src/a.ts (+3 -1)", output: "@@ -1 +1 @@", turnId: "run-1", turnIndex: 1 },
      { id: "new-file", kind: "file_change", name: "file change", status: "completed", input: "src/new.ts", output: null, turnId: "run-1", turnIndex: 1 },
      { id: "search", kind: "file_search", name: "file search", status: "completed", input: "*.ts", output: "a.ts\nb.ts", turnId: "run-1", turnIndex: 1 },
      { id: "web", kind: "web_search", name: "web search", status: "completed", input: "t3 code v2", output: "https://t3.codes\nTitle only", turnId: "run-1", turnIndex: 1 },
      { id: "tool", kind: "dynamic_tool", name: "browser.open", status: "completed", input: '{"url":"https://t3.codes"}', output: '{"ok":true}', turnId: "run-1", turnIndex: 1 },
      { id: "anonymous", kind: "dynamic_tool", name: "tool", status: "completed", input: "raw input", output: null, turnId: "run-1", turnIndex: 1 },
      { id: "agent", kind: "subagent", name: "subagent", status: "completed", input: "Review the diff", output: "Halfway", turnId: "run-1", turnIndex: 1 },
      { id: "approval", kind: "approval_request", name: "approval", status: "completed", input: "git push", output: null, turnId: "run-1", turnIndex: 1 },
      { id: "question", kind: "user_input_request", name: "question", status: "completed", input: "Which branch?", output: '{"q1":"main"}', turnId: "run-1", turnIndex: 1 },
      { id: "failure", kind: "error", name: "error", status: "completed", input: null, output: "Rate limited", turnId: "run-1", turnIndex: 1 },
      { id: "todo", kind: "todo_list", name: "todo list", status: "completed", input: "Plan", output: "[completed] Read\n[?] Write", turnId: "run-1", turnIndex: 1 },
      { id: "note", kind: "notification", name: "notification", status: "completed", input: "Heads up", output: "Disk almost full", turnId: "run-1", turnIndex: 1 },
      { id: "child", kind: "thread_created", name: "thread created", status: "completed", input: "thread-2", output: "gpt-6-astra", turnId: "run-1", turnIndex: 1 },
      { id: "compact", kind: "compaction", name: "compaction", status: "completed", input: null, output: "Compacted 40k tokens", turnId: "run-1", turnIndex: 1 },
      { id: "interrupt", kind: "run_interrupt_request", name: "run interrupt request", status: "completed", input: "Stop requested", output: null, turnId: "run-1", turnIndex: 1 },
    ]);
  });

  it("keeps a run's proposed plan at every detail level", () => {
    const source = twoRunThread();
    source.turnItems.push(
      item("plan-item-1", "proposed_plan", "run-1", 3, { planId: "plan-1", markdown: "# Old plan" }),
      item("plan-item-2", "proposed_plan", "run-2", 12, { planId: "plan-2", markdown: "# Plan\n- Add tests" }),
      item("plan-empty", "proposed_plan", "run-2", 12, { planId: "plan-3", markdown: "" }),
    );

    for (const detail of ["answers", "messages", "full"] as const) {
      // The window leaves out run 1, and with it run 1's plan.
      expect(buildTranscript(source, { detail, turns: 1 }).proposedPlans).toEqual([
        { id: "plan-2", turnId: "run-2", turnIndex: 2, text: "# Plan\n- Add tests", textTruncated: false, createdAt: at(12) },
      ]);
    }
    expect(renderTranscript(buildTranscript(source, { detail: "answers", turns: 1 }))).toContain("### proposed plan\n# Plan\n- Add tests");
  });

  it("windows the last turns and can keep the original request", () => {
    const latest = buildTranscript(twoRunThread(), { turns: 1 });
    expect(latest.view).toMatchObject({ totalTurns: 2, returnedTurns: 1, omittedTurns: 1, firstTurnIncluded: false });
    expect(latest.messages.map((entry) => entry.id)).toEqual(["prompt-2", "progress-2", "answer-2"]);

    const withOrigin = buildTranscript(twoRunThread(), { turns: 1, firstTurn: true, detail: "answers" });
    expect(withOrigin.view).toMatchObject({ returnedTurns: 2, omittedTurns: 0, firstTurnIncluded: true });
    expect(withOrigin.messages.map((entry) => entry.id)).toEqual(["prompt-1", "answer-1", "prompt-2", "answer-2"]);

    // A window that already holds the first turn does not repeat it.
    expect(buildTranscript(twoRunThread(), { turns: 5, firstTurn: true }).turns.map((turn) => turn.index)).toEqual([1, 2]);
  });

  it("clips messages, plans, and tool text to --max-chars", () => {
    const long = `start ${"x".repeat(500)} end`;
    const source = projection({
      runs: [run(1, "completed", 0)],
      messages: [message("prompt-1", "user", "run-1", 0, long)],
      turnItems: [
        item("command", "command_execution", "run-1", 1, { input: "ls", output: long }),
        item("plan", "proposed_plan", "run-1", 2, { planId: "plan-1", markdown: long }),
      ],
    });

    const clipped = buildTranscript(source, { detail: "full", maxChars: 100 });

    expect(clipped.view.maxChars).toBe(100);
    const [entry] = clipped.messages;
    expect(entry).toMatchObject({ textTruncated: true });
    expect(entry?.text.startsWith("start ")).toBe(true);
    expect(entry?.text.endsWith(" end")).toBe(true);
    expect(entry?.text).toContain("characters omitted");
    // The omission marker counts toward the limit.
    expect(entry?.text).toHaveLength(100);
    expect(clipped.toolCalls?.[0]).toMatchObject({ input: "ls", inputTruncated: false, outputTruncated: true });
    expect(clipped.toolCalls?.[0]?.output).toHaveLength(100);
    expect(clipped.proposedPlans?.[0]).toMatchObject({ textTruncated: true });
    expect(clipped.proposedPlans?.[0]?.text).toHaveLength(100);

    // Without a limit, messages stay whole while tool output is still kept short.
    const unclipped = buildTranscript(source, { detail: "full" });
    expect(unclipped.messages[0]).toMatchObject({ text: long, textTruncated: false });
    expect(unclipped.toolCalls?.[0]).toMatchObject({ output: long, outputTruncated: false });
    const huge = projection({
      runs: [run(1, "completed", 0)],
      turnItems: [item("command", "command_execution", "run-1", 1, { input: "cat big.log", output: "y".repeat(5_000) })],
    });
    expect(buildTranscript(huge, { detail: "full" }).toolCalls?.[0]?.output).toHaveLength(600);
  });

  it("clips long text at the head and tail", () => {
    expect(clip("x".repeat(500), 10)).toEqual({ text: "x".repeat(10), truncated: true });
    expect(clip("short", 100)).toEqual({ text: "short", truncated: false });
    expect(clip("short", undefined)).toEqual({ text: "short", truncated: false });
    const clipped = clip(`${"a".repeat(300)}${"b".repeat(300)}`, 120);
    expect(clipped.text).toHaveLength(120);
    expect(clipped.text.startsWith("aaa")).toBe(true);
    expect(clipped.text.endsWith("bbb")).toBe(true);
  });
});

describe("selectTurn", () => {
  it("narrows a transcript to one turn without the caller's own message", () => {
    const source = twoRunThread();
    source.turnItems.push(item("plan-item-2", "proposed_plan", "run-2", 12, { planId: "plan-2", markdown: "# Plan" }));

    const transcript = selectTurn(buildTranscript(source, { detail: "full" }), 2, ["prompt-2"]);

    expect(transcript.turns.map((turn) => turn.index)).toEqual([2]);
    expect(transcript.messages.map((entry) => entry.id)).toEqual(["progress-2", "answer-2"]);
    expect(transcript.toolCalls?.map((call) => call.id)).toEqual(["edit-2"]);
    expect(transcript.proposedPlans?.map((plan) => plan.id)).toEqual(["plan-2"]);
    expect(transcript.view).toMatchObject({ detail: "full", totalTurns: 2, returnedTurns: 1, omittedTurns: 1, firstTurnIncluded: false });

    const first = selectTurn(buildTranscript(source, { detail: "answers" }), 1);
    expect(first.view.firstTurnIncluded).toBe(true);
    expect(first).not.toHaveProperty("toolCalls");
  });

  it("returns no turn for a thread without one", () => {
    const transcript = selectTurn(buildTranscript(projection()), null);

    expect(transcript.turns).toEqual([]);
    expect(transcript.messages).toEqual([]);
    expect(transcript.view).toMatchObject({ totalTurns: 0, returnedTurns: 0, omittedTurns: 0, firstTurnIncluded: false });
  });
});

function request(
  id: string,
  kind: string,
  capability: T3RuntimeRequest["responseCapability"]["type"],
  minute: number,
  status: T3RuntimeRequest["status"] = "pending",
): T3RuntimeRequest {
  return {
    id,
    kind,
    status,
    responseCapability: capability === "not_resumable" ? { type: capability, reason: "session ended" } : { type: capability },
    createdAt: at(minute),
    resolvedAt: status === "pending" ? null : at(minute + 1),
  };
}

describe("pendingRequests", () => {
  it("lists open approvals and questions with what it takes to answer them", () => {
    const source = projection({
      runs: [run(1, "completed", 0), run(2, "running", 10)],
      runtimeRequests: [
        request("message-question", "user_input", "message", 2),
        request("answered", "user_input", "message", 3, "resolved"),
        request("approval", "command", "live", 11),
        request("live-question", "user_input", "live", 12),
        request("stale-question", "user_input", "not_resumable", 4),
        // A request whose timeline item is missing still shows up.
        request("bare", "user_input", "live", 13),
      ],
      turnItems: [
        item("item-message-question", "user_input_request", "run-1", 2, {
          requestId: "message-question",
          responseMode: "message",
          questions: [{ id: "0", header: "Question", question: "Which OAuth apps?", options: [{ label: "Reuse", description: "" }] }],
        }),
        item("item-answered", "user_input_request", "run-1", 3, { requestId: "answered", questions: [{ id: "0", question: "Done?" }] }),
        item("item-approval", "approval_request", "run-2", 11, {
          requestId: "approval",
          requestKind: "command",
          prompt: "git push",
          options: [{ decision: "accept", label: "Allow" }, { decision: "decline", label: "Deny" }, { label: "No decision" }],
        }),
        item("item-live-question", "user_input_request", "run-2", 12, {
          requestId: "live-question",
          questions: [
            {
              id: "q1",
              header: "Target",
              question: "Which branch?",
              options: [{ label: "Main", value: "main", description: "The default branch" }, { label: "Dev" }, { value: "no-label" }],
              multiSelect: true,
              allowCustomAnswer: false,
            },
            { id: "q2", question: 42 },
          ],
        }),
        item("item-stale-question", "user_input_request", "run-1", 4, { requestId: "stale-question", questions: [{ id: "s", question: "Still there?" }] }),
      ],
    });

    expect(pendingRequests(source)).toEqual([
      {
        kind: "user-input",
        requestId: "message-question",
        turnId: "run-1",
        responseMode: "message",
        blocking: false,
        answerable: true,
        detail: "user_input",
        requestKind: "user_input",
        decisions: [],
        questions: [
          {
            id: "0",
            header: "Question",
            question: "Which OAuth apps?",
            options: ["Reuse"],
            choices: [{ label: "Reuse", value: null, description: null }],
            multiSelect: false,
            allowCustomAnswer: true,
          },
        ],
        createdAt: at(2),
      },
      {
        kind: "approval",
        requestId: "approval",
        turnId: "run-2",
        responseMode: null,
        blocking: true,
        answerable: true,
        detail: "git push",
        requestKind: "command",
        decisions: ["accept", "decline"],
        questions: [],
        createdAt: at(11),
      },
      {
        kind: "user-input",
        requestId: "live-question",
        turnId: "run-2",
        responseMode: null,
        blocking: true,
        answerable: true,
        detail: "user_input",
        requestKind: "user_input",
        decisions: [],
        questions: [
          {
            id: "q1",
            header: "Target",
            question: "Which branch?",
            options: ["Main", "Dev"],
            choices: [
              { label: "Main", value: "main", description: "The default branch" },
              { label: "Dev", value: null, description: null },
            ],
            multiSelect: true,
            allowCustomAnswer: false,
          },
        ],
        createdAt: at(12),
      },
      {
        kind: "user-input",
        requestId: "stale-question",
        turnId: "run-1",
        responseMode: null,
        blocking: false,
        answerable: false,
        detail: "user_input",
        requestKind: "user_input",
        decisions: [],
        questions: [
          { id: "s", header: null, question: "Still there?", options: [], choices: [], multiSelect: false, allowCustomAnswer: true },
        ],
        createdAt: at(4),
      },
      {
        kind: "user-input",
        requestId: "bare",
        turnId: null,
        responseMode: null,
        blocking: true,
        answerable: true,
        detail: "user_input",
        requestKind: "user_input",
        decisions: [],
        questions: [],
        createdAt: at(13),
      },
    ]);
  });

  it("reads message mode from the question item when the capability does not say so", () => {
    const source = projection({
      runs: [run(1, "running", 0)],
      runtimeRequests: [request("question", "user_input", "live", 1)],
      turnItems: [item("item", "user_input_request", "run-1", 1, { requestId: "question", responseMode: "message", questions: [] })],
    });

    expect(pendingRequests(source)[0]).toMatchObject({ responseMode: "message", blocking: true });
  });

  it("uses the request kind for an approval without a prompt", () => {
    const source = projection({
      runs: [run(1, "running", 0)],
      runtimeRequests: [request("approval", "file_change", "live", 1)],
      turnItems: [item("item", "approval_request", "run-1", 1, { requestId: "approval", requestKind: "file_change", title: null })],
    });

    expect(pendingRequests(source)[0]).toMatchObject({ kind: "approval", detail: "file_change", requestKind: "file_change", decisions: [] });
  });

  it("renders requests for people to read", () => {
    const source = projection({
      runs: [run(1, "running", 0)],
      runtimeRequests: [
        request("approval", "command", "live", 1),
        request("async", "user_input", "message", 2),
        request("stale", "user_input", "not_resumable", 3),
      ],
      turnItems: [
        item("a", "approval_request", "run-1", 1, { requestId: "approval", requestKind: "command", prompt: "git push" }),
        item("b", "user_input_request", "run-1", 2, {
          requestId: "async",
          questions: [{ id: "0", question: "Which apps?", options: [{ label: "Reuse" }, { label: "New" }] }],
        }),
        item("c", "user_input_request", "run-1", 3, { requestId: "stale", questions: [{ id: "0", question: "Still there?" }] }),
      ],
    });

    expect(renderPendingRequests(pendingRequests(source))).toBe(
      [
        "- Approval [approval]: git push",
        "- Question [async] (answer starts a new turn):",
        "  1. Which apps? (options: Reuse / New)",
        "- Question [stale] (its session is gone; dismiss it):",
        "  1. Still there?",
      ].join("\n"),
    );
  });
});

describe("run state", () => {
  it("maps each run status to a turn state", () => {
    const states = Object.fromEntries(
      (["preparing", "queued", "starting", "running", "waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back"] as const).map(
        (status) => [status, turnStateOf(status)],
      ),
    );

    expect(states).toEqual({
      preparing: "running",
      queued: "pending",
      starting: "running",
      running: "running",
      waiting: "running",
      completed: "completed",
      interrupted: "interrupted",
      failed: "error",
      cancelled: "interrupted",
      rolled_back: "rolled_back",
    });
  });

  it("reports the active run, the queue, and what keeps a thread busy", () => {
    expect(busyState(projection({ runs: [run(1, "completed", 0)] }))).toBeNull();
    expect(activeRun(projection())).toBeNull();

    const busy = projection({
      runs: [
        run(1, "completed", 0),
        run(2, "waiting", 10),
        run(3, "queued", 11, { queuePosition: 2 }),
        run(4, "queued", 12, { queuePosition: 1, queueHeld: true }),
      ],
      messages: [message("prompt-4", "user", "run-4", 12, "Fourth")],
    });

    expect(activeRun(busy)?.id).toBe("run-2");
    expect(queuedRuns(busy).map((candidate) => candidate.id)).toEqual(["run-4", "run-3"]);
    expect(busyState(busy)).toEqual({ runRunning: true, activeRunId: "run-2", queuedRuns: 2, queueHeld: true });
    expect(runMessage(busy, busy.runs[3]!)?.text).toBe("Fourth");
    expect(runMessage(busy, busy.runs[2]!)).toBeNull();

    // Queued runs keep a thread busy even when no run works.
    expect(busyState(projection({ runs: [run(1, "completed", 0), run(2, "queued", 5, { queuePosition: 1 })] }))).toEqual({
      runRunning: false,
      activeRunId: null,
      queuedRuns: 1,
      queueHeld: false,
    });
  });
});

describe("renderTranscript", () => {
  it("renders turns as Markdown with the final answer marked", () => {
    expect(renderTranscript(buildTranscript(twoRunThread(), { detail: "answers" }))).toBe(
      [
        "## Turn 1 · completed · 2026-10-01 10:00:00Z",
        "",
        "### user · 2026-10-01 10:00:00Z",
        "Build the feature",
        "",
        "### assistant (final) · 2026-10-01 10:04:00Z",
        "Built it",
        "",
        "## Turn 2 · completed · 2026-10-01 10:10:00Z",
        "",
        "### user · 2026-10-01 10:10:00Z",
        "Now test it",
        "",
        "### assistant (final) · 2026-10-01 10:13:00Z",
        "Tests pass",
      ].join("\n"),
    );
  });

  it("collects consecutive tool calls into one block and lists changed files", () => {
    const source = twoRunThread();
    source.turnItems.push(
      item("command-2", "command_execution", "run-1", 3, { input: "false", status: "failed" }),
      item("command-3", "command_execution", "run-1", 3, { input: "cat <<EOF\nmulti\nEOF" }),
    );

    const rendered = renderTranscript(buildTranscript(source, { detail: "full", turns: 1, firstTurn: true }));

    expect(rendered).toContain(
      "### tools\n- command: pnpm test\n> 12 passed\n- command (failed): false\n- command\n> cat <<EOF\n> multi\n> EOF",
    );
    expect(rendered).toContain("### reasoning · 2026-10-01 10:01:00Z\nThinking about it");
    expect(rendered).toContain("### changed files\n- modified src/a.ts (+3 -1)");
    expect(rendered).toContain("### changed files\n- changed src/b.ts (+2 -0)");
  });

  it("marks a turn without visible messages", () => {
    const source = projection({ runs: [run(1, "running", 0)] });

    expect(renderTranscript(buildTranscript(source))).toBe("## Turn 1 · running · 2026-10-01 10:00:00Z\n\n_No messages in this view._");
  });
});
