import { realpath } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { startFakeT3, type FakeT3 } from "./testing/fakeT3.js";
import {
  changeQueue,
  createSchedule,
  deleteSchedule,
  describeSchedule,
  forkThread,
  listQueue,
  listSchedules,
  mergeBackThread,
  organizeThread,
  parseDuration,
  runSchedule,
  scheduleFrom,
  searchThreads,
  setScheduleEnabled,
  snoozeTime,
  sourcePointFor,
  updateSchedule,
} from "./v2Commands.js";

const fakes: FakeT3[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function fakeT3(...args: Parameters<typeof startFakeT3>) {
  const fake = await startFakeT3(...args);
  fakes.push(fake);
  return fake;
}

/** A thread with a running turn and two queued messages behind it. */
async function busyThread() {
  const fake = await fakeT3({ runBehavior: "hold" });
  fake.addProject();
  const { thread } = fake.addThread();
  const running = fake.startRun(thread.id, "Working on it");
  const first = fake.startRun(thread.id, "First follow-up", { status: "queued" });
  const second = fake.startRun(thread.id, "Second follow-up", { status: "queued" });
  return { fake, threadId: thread.id, running, first, second };
}

describe("time and schedule parsing", () => {
  it("reads durations, snooze times, and schedules", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(parseDuration("soon")).toBeNull();

    const now = Date.parse("2026-10-03T10:00:00.000Z");
    expect(snoozeTime("2h", now)).toBe("2026-10-03T12:00:00.000Z");
    expect(snoozeTime("2026-10-04T09:00:00Z", now)).toBe("2026-10-04T09:00:00.000Z");
    expect(() => snoozeTime("2026-10-01T09:00:00Z", now)).toThrow(expect.objectContaining({ code: "INVALID_SNOOZE_TIME", exitCode: 2 }));

    expect(scheduleFrom({ every: "30m" }, null)).toEqual({ type: "interval", everyMs: 1_800_000 });
    expect(scheduleFrom({ at: "9:05", days: "weekdays" }, null)).toEqual({ type: "fixed_time", timeOfDay: "09:05", weekdays: [1, 2, 3, 4, 5] });
    expect(scheduleFrom({ at: "18:00", days: "mon,tue,wed,thu,fri,sat,sun" }, null)).toEqual({ type: "fixed_time", timeOfDay: "18:00" });
    // --days alone keeps the task's time of day.
    expect(scheduleFrom({ days: "sat,sun" }, { type: "fixed_time", timeOfDay: "07:30" })).toEqual({ type: "fixed_time", timeOfDay: "07:30", weekdays: [0, 6] });
    expect(() => scheduleFrom({ every: "30s" }, null)).toThrow(expect.objectContaining({ code: "INVALID_SCHEDULE" }));
    expect(() => scheduleFrom({ every: "1h", at: "09:00" }, null)).toThrow(expect.objectContaining({ code: "SCHEDULE_CONFLICT" }));
    expect(() => scheduleFrom({ at: "25:00" }, null)).toThrow(expect.objectContaining({ code: "INVALID_SCHEDULE" }));
    expect(() => scheduleFrom({ days: "mon" }, null)).toThrow(expect.objectContaining({ code: "INVALID_SCHEDULE" }));

    expect(describeSchedule({ type: "interval", everyMs: 5_400_000 })).toBe("every 1h30m");
    expect(describeSchedule({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] })).toBe("at 09:00 weekdays");
    expect(describeSchedule({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] })).toBe("at 09:00 mon,wed");
  });
});

describe("forks and merge-back", () => {
  it("forks from the latest turn and verifies the new thread", async () => {
    const fake = await fakeT3();
    fake.addProject();
    const source = fake.addThread({ turns: 2 });

    const result = await forkThread(fake.config, { threadId: source.thread.id, title: "  Try another route  " });
    expect(result.sourcePoint).toEqual({ type: "latest_stable" });
    expect(result.thread.title).toBe("Try another route");
    expect(result.thread.forkedFrom).toMatchObject({ threadId: source.thread.id });
    expect(result.opened.kind).toBe("none");
    expect(fake.commands.at(-1)).toMatchObject({
      type: "thread.fork",
      sourceThreadId: source.thread.id,
      targetThreadId: result.thread.id,
      createdBy: "user",
      creationSource: "web",
    });
    expect(fake.threads.has(result.thread.id)).toBe(true);
  });

  it("resolves --from as a turn number or a run id, with or without the run: prefix", async () => {
    const fake = await fakeT3();
    fake.addProject();
    const { thread, runs } = fake.addThread({ turns: 3 });
    const projection = fake.projection(thread.id);
    expect(sourcePointFor(projection, "turn:2")).toEqual({ type: "run", runId: runs[1]!.id });
    expect(sourcePointFor(projection, runs[0]!.id)).toEqual({ type: "run", runId: runs[0]!.id });
    expect(sourcePointFor(projection, `run:${runs[0]!.id}`)).toEqual({ type: "run", runId: runs[0]!.id });
    expect(() => sourcePointFor(projection, "run:missing")).toThrow(expect.objectContaining({ code: "SOURCE_POINT_NOT_FOUND", exitCode: 3 }));

    const forked = await forkThread(fake.config, { threadId: thread.id, from: "turn:1" });
    expect(fake.commands.at(-1)?.sourcePoint).toEqual({ type: "run", runId: runs[0]!.id });
    expect(forked.sourcePoint).toEqual({ type: "run", runId: runs[0]!.id });
  });

  it("refuses to fork from a turn the thread inherited from its own source", async () => {
    const fake = await fakeT3();
    fake.addProject();
    const { thread } = fake.addThread({ turns: 1 });
    const projection = fake.projection(thread.id);
    projection.visibleTurnItems = [
      {
        position: 0,
        visibility: "inherited",
        sourceThreadId: "source-thread",
        sourceItemId: "source-item",
        item: { id: "source-item", type: "user_message", runId: "source-run", messageId: "source-prompt", text: "Earlier", startedAt: "2026-09-30T10:00:00.000Z" },
      },
    ];

    expect(() => sourcePointFor(projection, "turn:1")).toThrow(
      expect.objectContaining({ code: "SOURCE_POINT_INHERITED", exitCode: 2 }),
    );
    // The fork's own turn comes after the inherited one.
    expect(sourcePointFor(projection, "turn:2")).toEqual({ type: "run", runId: projection.runs[0]!.id });
  });

  it("merges a fork back into its parent and refuses a thread that is not a fork", async () => {
    const fake = await fakeT3({
      onCommand: (command, server) => {
        if (command.type !== "thread.merge_back") return;
        const target = server.projection(command.targetThreadId as string);
        const transfers = Array.isArray(target.contextTransfers) ? target.contextTransfers : [];
        target.contextTransfers = [
          ...transfers,
          { id: `transfer:${command.commandId}`, type: "merge_back", sourceThreadId: command.sourceThreadId, status: "pending" },
        ];
      },
    });
    fake.addProject();
    const parent = fake.addThread({ turns: 1 });
    const fork = await forkThread(fake.config, { threadId: parent.thread.id });
    fake.startRun(fork.thread.id, "Explore the fork");

    const merged = await mergeBackThread(fake.config, { threadId: fork.thread.id });
    expect(merged.target.id).toBe(parent.thread.id);
    expect(merged.transfer.status).toBe("pending");
    expect(fake.commands.at(-1)).toMatchObject({
      type: "thread.merge_back",
      sourceThreadId: fork.thread.id,
      targetThreadId: parent.thread.id,
      sourcePoint: { type: "latest_stable" },
      createdBy: "user",
    });

    await expect(mergeBackThread(fake.config, { threadId: parent.thread.id })).rejects.toMatchObject({
      code: "THREAD_NOT_A_FORK",
      exitCode: 4,
    });
  });
});

describe("queue", () => {
  it("lists, edits, moves, and cancels queued messages", async () => {
    const { fake, threadId, running, first, second } = await busyThread();

    const listed = await listQueue(fake.config, threadId);
    expect(listed.activeRunId).toBe(running.id);
    expect(listed.queue.map((entry) => [entry.position, entry.runId, entry.text])).toEqual([
      [1, first.id, "First follow-up"],
      [2, second.id, "Second follow-up"],
    ]);

    const edited = await changeQueue(fake.config, threadId, { type: "edit", runId: first.id, text: "  Sharper follow-up " });
    expect(edited.command).toMatchObject({ type: "queued-run.edit", runId: first.id, text: "Sharper follow-up" });
    expect(edited.queue[0]?.text).toBe("Sharper follow-up");

    const moved = await changeQueue(fake.config, threadId, { type: "move", runId: second.id, beforeRunId: first.id });
    expect(moved.queue.map((entry) => entry.runId)).toEqual([second.id, first.id]);
    const toEnd = await changeQueue(fake.config, threadId, { type: "move", runId: second.id, beforeRunId: null });
    expect(toEnd.command).toMatchObject({ type: "queued-run.reorder", beforeRunId: null });
    expect(toEnd.queue.map((entry) => entry.runId)).toEqual([first.id, second.id]);

    const cancelled = await changeQueue(fake.config, threadId, { type: "cancel", runId: first.id });
    expect(cancelled.queue.map((entry) => entry.runId)).toEqual([second.id]);

    await expect(changeQueue(fake.config, threadId, { type: "cancel", runId: first.id })).rejects.toMatchObject({
      code: "QUEUED_RUN_NOT_FOUND",
      exitCode: 3,
    });
    await expect(changeQueue(fake.config, threadId, { type: "edit", runId: second.id, text: "   " })).rejects.toMatchObject({
      code: "PROMPT_REQUIRED",
      exitCode: 2,
    });
  });

  it("promotes a queued message into the running turn and resumes a held queue", async () => {
    const { fake, threadId, running, first, second } = await busyThread();

    const promoted = await changeQueue(fake.config, threadId, { type: "promote", runId: first.id });
    expect(promoted.command).toMatchObject({ type: "queued-message.promote-to-steer", queuedRunId: first.id, targetRunId: running.id });
    expect(promoted.queue.map((entry) => entry.runId)).toEqual([second.id]);

    await expect(changeQueue(fake.config, threadId, { type: "resume" })).rejects.toMatchObject({ code: "QUEUE_NOT_HELD", exitCode: 4 });
    for (const run of fake.projection(threadId).runs) if (run.status === "queued") run.queueHeld = true;
    const resumed = await changeQueue(fake.config, threadId, { type: "resume" });
    expect(resumed.command.type).toBe("queue.resume");
    expect(resumed.queue.every((entry) => !entry.held)).toBe(true);

    fake.completeRun(threadId, running.id);
    fake.completeRun(threadId, second.id);
    await expect(changeQueue(fake.config, threadId, { type: "promote", runId: second.id })).rejects.toMatchObject({
      code: "QUEUED_RUN_NOT_FOUND",
    });
  });

  it("refuses to promote without a running turn", async () => {
    const fake = await fakeT3({ runBehavior: "hold" });
    fake.addProject();
    const { thread } = fake.addThread();
    const queued = fake.startRun(thread.id, "Waiting", { status: "queued" });
    await expect(changeQueue(fake.config, thread.id, { type: "promote", runId: queued.id })).rejects.toMatchObject({
      code: "THREAD_NOT_RUNNING",
      exitCode: 4,
    });
  });
});

describe("thread organization and search", () => {
  it("pins, snoozes, archives, and renames, verifying each change", async () => {
    const fake = await fakeT3();
    fake.addProject();
    const { thread } = fake.addThread({ turns: 1 });

    const pinned = await organizeThread(fake.config, thread.id, { type: "pin" });
    expect(pinned.change.field).toBe("pinnedAt");
    expect(pinned.change.after).not.toBeNull();
    expect((await organizeThread(fake.config, thread.id, { type: "unpin" })).change.after).toBeNull();

    const until = new Date(Date.now() + 3_600_000).toISOString();
    const snoozed = await organizeThread(fake.config, thread.id, { type: "snooze", until });
    expect(snoozed.change.after).toBe(until);
    const woken = await organizeThread(fake.config, thread.id, { type: "unsnooze" });
    expect(fake.commands.at(-1)).toMatchObject({ type: "thread.unsnooze", reason: "user" });
    expect(woken.change.after).toBeNull();

    await organizeThread(fake.config, thread.id, { type: "archive" });
    expect(fake.projection(thread.id).thread.archivedAt).not.toBeNull();
    await organizeThread(fake.config, thread.id, { type: "unarchive" });
    expect(fake.projection(thread.id).thread.archivedAt).toBeNull();

    const renamed = await organizeThread(fake.config, thread.id, { type: "rename", title: " Release notes " });
    expect(renamed.thread.title).toBe("Release notes");
    expect(fake.commands.at(-1)).toMatchObject({ type: "thread.metadata.update", title: "Release notes" });
    await expect(organizeThread(fake.config, thread.id, { type: "rename", title: " " })).rejects.toMatchObject({ code: "TITLE_REQUIRED", exitCode: 2 });
    await expect(organizeThread(fake.config, "missing-thread", { type: "pin" })).rejects.toMatchObject({ code: "THREAD_NOT_FOUND", exitCode: 3 });
  });

  it("searches threads and adds thread and project titles", async () => {
    const fake = await fakeT3();
    const project = fake.addProject({ title: "Website" });
    const { thread } = fake.addThread({ title: "Pricing page", turns: 1 });
    fake.projection(thread.id).messages[0]!.text = "Rework the pricing table";

    const result = await searchThreads(fake.config, { query: "pricing", limit: 5 });
    expect(fake.rpcCalls.find((call) => call.tag === "orchestration.searchThreads")?.payload).toEqual({ query: "pricing", limit: 5 });
    expect(result.matches).toEqual([
      expect.objectContaining({ threadId: thread.id, projectId: project.id, threadTitle: "Pricing page", projectTitle: "Website", archived: false }),
    ]);

    await expect(searchThreads(fake.config, { query: "a" })).rejects.toMatchObject({ code: "SEARCH_QUERY_INVALID", exitCode: 2 });
    await expect(searchThreads(fake.config, { query: "pricing", limit: 51 })).rejects.toMatchObject({ code: "SEARCH_LIMIT_INVALID", exitCode: 2 });
  });
});

describe("schedules", () => {
  it("creates a task for the folder's project with the catalog's default model", async () => {
    const fake = await fakeT3();
    // The folder resolves to its real path, which can differ from a short temp path on Windows.
    const project = fake.addProject({ workspaceRoot: await realpath(fake.root) });

    const created = await createSchedule(fake.config, { title: "Nightly triage", prompt: " Triage new issues ", every: "30m", cwd: fake.root });
    expect(created.project.id).toBe(project.id);
    const upsert = fake.rpcCalls.find((call) => call.tag === "scheduledTasks.upsert")!.payload;
    expect(upsert).toEqual({
      title: "Nightly triage",
      prompt: "Triage new issues",
      enabled: true,
      schedule: { type: "interval", everyMs: 1_800_000 },
      projectId: project.id,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
    });
    expect(created.task.id).toMatch(/^scheduled-task:/u);

    const worktree = await createSchedule(fake.config, {
      title: "Weekday report",
      prompt: "Write the report",
      at: "8:30",
      days: "weekdays",
      project: project.id,
      checkout: "worktree",
      model: "gpt-6-luna",
      thinkingEffort: "low",
      interactionMode: "plan",
      disabled: true,
    });
    expect(worktree.task).toMatchObject({
      enabled: false,
      schedule: { type: "fixed_time", timeOfDay: "08:30", weekdays: [1, 2, 3, 4, 5] },
      workspaceStrategy: { type: "worktree", baseRef: "main" },
      interactionMode: "plan",
    });
    // The catalog maps the effort to the one option id the model uses.
    expect(worktree.task.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "low" }] });

    await expect(
      createSchedule(fake.config, { title: "x", prompt: "y", every: "1h", project: project.id, model: "gpt-0" }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND", exitCode: 2 });
    await expect(
      createSchedule(fake.config, { title: "x", prompt: "y", every: "1h", project: project.id, provider: "claudeAgent" }),
    ).rejects.toMatchObject({ code: "MODEL_REQUIRED_FOR_PROVIDER", exitCode: 2 });
  });

  it("binds a task to a thread and keeps that thread's model and project", async () => {
    const fake = await fakeT3();
    fake.addProject({ defaultModelSelection: { instanceId: "codex", model: "gpt-6-astra" } });
    const other = fake.addProject({ title: "Other" });
    const { thread } = fake.addThread({ projectId: other.id, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } });

    const created = await createSchedule(fake.config, { title: "Check in", prompt: "Any news?", every: "2h", thread: thread.id });
    expect(created.task).toMatchObject({
      projectId: other.id,
      threadId: thread.id,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    });

    await expect(
      createSchedule(fake.config, { title: "x", prompt: "y", every: "2h", thread: thread.id, checkout: "worktree" }),
    ).rejects.toMatchObject({ code: "SCHEDULE_CHECKOUT_CONFLICT", exitCode: 2 });
    await expect(
      createSchedule(fake.config, { title: "x", prompt: "y", every: "2h", thread: thread.id, project: fake.projects[0]!.id }),
    ).rejects.toMatchObject({ code: "SCHEDULE_THREAD_PROJECT_MISMATCH", exitCode: 2 });
    await expect(createSchedule(fake.config, { title: "x", prompt: "y", cwd: fake.root })).rejects.toMatchObject({
      code: "SCHEDULE_REQUIRED",
      exitCode: 2,
    });
  });

  it("lists, updates, enables, runs, and deletes tasks", async () => {
    const fake = await fakeT3();
    const project = fake.addProject({ title: "Website" });
    const other = fake.addProject({ title: "Other", workspaceRoot: `${fake.root}-other` });
    const created = await createSchedule(fake.config, { title: "Daily", prompt: "Summarize", at: "09:00", project: project.id });
    await createSchedule(fake.config, { title: "Elsewhere", prompt: "Summarize", every: "1h", project: other.id });

    const listed = await listSchedules(fake.config, { project: project.id });
    expect(listed.tasks.map((task) => [task.title, task.projectTitle])).toEqual([["Daily", "Website"]]);
    expect((await listSchedules(fake.config)).tasks).toHaveLength(2);

    const updated = await updateSchedule(fake.config, created.task.id, { days: "mon,fri", title: "Twice a week" });
    const upsert = fake.rpcCalls.filter((call) => call.tag === "scheduledTasks.upsert").at(-1)!.payload;
    expect(upsert).toMatchObject({ id: created.task.id, requireExisting: true, prompt: "Summarize", creationSource: "web" });
    expect(updated.task).toMatchObject({ title: "Twice a week", schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5] } });
    await expect(updateSchedule(fake.config, created.task.id, {})).rejects.toMatchObject({ code: "SCHEDULE_CHANGE_REQUIRED", exitCode: 2 });

    expect((await setScheduleEnabled(fake.config, created.task.id, false)).task.enabled).toBe(false);
    expect((await setScheduleEnabled(fake.config, created.task.id, true)).changed).toBe(true);

    const ran = await runSchedule(fake.config, created.task.id);
    expect(ran.task.runCount).toBe(1);

    const deleted = await deleteSchedule(fake.config, created.task.id);
    expect(deleted.task.id).toBe(created.task.id);
    expect(fake.scheduledTasks.map((task) => task.id)).not.toContain(created.task.id);
    await expect(deleteSchedule(fake.config, created.task.id)).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND", exitCode: 3 });
  });

  it("reports a save that T3 acknowledged but does not list", async () => {
    const fake = await fakeT3({
      rpcHandlers: {
        "scheduledTasks.upsert": (payload) => ({ task: { ...payload, id: "scheduled-task:lost", runCount: 0, lastRunAt: null } }),
      },
    });
    const project = fake.addProject();

    await expect(
      createSchedule(fake.config, { title: "Daily", prompt: "Summarize", every: "1d", project: project.id }),
    ).rejects.toMatchObject({ code: "SCHEDULE_NOT_VERIFIED", exitCode: 5 });
  });

  it("reports a save whose model options T3 stored differently", async () => {
    const fake = await fakeT3({
      rpcHandlers: {
        "scheduledTasks.upsert": (payload, server) => {
          const model = payload.modelSelection as Record<string, unknown>;
          const task = {
            ...payload,
            id: "scheduled-task:options",
            runCount: 0,
            lastRunAt: null,
            modelSelection: { ...model, options: [{ id: "reasoningEffort", value: "low" }] },
          };
          server.scheduledTasks.push(task);
          return { task };
        },
      },
    });
    const project = fake.addProject();

    await expect(
      createSchedule(fake.config, { title: "Daily", prompt: "Summarize", every: "1d", project: project.id, thinkingEffort: "high" }),
    ).rejects.toMatchObject({ code: "SCHEDULE_NOT_VERIFIED", exitCode: 5 });
  });

  it("reports an enable that T3 acknowledged but did not keep", async () => {
    const fake = await fakeT3({
      rpcHandlers: {
        "scheduledTasks.setEnabled": (payload, server) => {
          const task = server.scheduledTasks.find((candidate) => candidate.id === payload.id)!;
          return { task: { ...task, enabled: payload.enabled } };
        },
      },
    });
    const project = fake.addProject();
    const created = await createSchedule(fake.config, { title: "Daily", prompt: "Summarize", every: "1d", project: project.id, disabled: true });

    await expect(setScheduleEnabled(fake.config, created.task.id, true)).rejects.toMatchObject({ code: "SCHEDULE_NOT_VERIFIED", exitCode: 5 });
  });

  it("reports a manual run that T3 could not start", async () => {
    const fake = await fakeT3({
      rpcHandlers: {
        "scheduledTasks.runNow": (payload, server) => {
          const task = server.scheduledTasks.find((candidate) => candidate.id === payload.id)!;
          return { task: { ...task, lastRunStatus: "failed", lastRunError: "Thread is archived." } };
        },
      },
    });
    const project = fake.addProject();
    const created = await createSchedule(fake.config, { title: "Daily", prompt: "Summarize", every: "1d", project: project.id });
    await expect(runSchedule(fake.config, created.task.id)).rejects.toMatchObject({ code: "SCHEDULE_RUN_FAILED", exitCode: 4 });
  });
});
