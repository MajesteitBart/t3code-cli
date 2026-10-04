import { Option, type Command } from "commander";

import { action, addPromptOptions, commandContext, positiveInteger, resolvePrompt, type PromptOptions } from "./cliShared.js";
import { writeSuccess } from "./output.js";
import type { InteractionMode, OpenMode, RuntimeMode, SpeedMode } from "./types.js";
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
  runSchedule,
  searchThreads,
  setScheduleEnabled,
  snoozeTime,
  updateSchedule,
  type OrganizeAction,
  type QueueChange,
  type ScheduledTask,
  type ScheduleOptions,
} from "./v2Commands.js";

const SOURCE_POINT_HELP = "Fork point: latest (default), turn:<n>, or a run or checkpoint id.";

function oneLine(text: string, limit = 120): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

function threadOption(command: Command): Command {
  return command.requiredOption("--thread <thread-id>", "Exact T3 thread id.");
}

function registerForks(threads: Command): void {
  threadOption(threads.command("fork").description("Fork a thread into a new thread that continues from one of its turns."))
    .option("--from <point>", SOURCE_POINT_HELP)
    .option("--title <text>", "Title for the new thread (T3 names it after the source by default).")
    .addOption(new Option("--open <mode>", "Show the new thread afterwards.").choices(["auto", "desktop", "browser", "none"]))
    .action((options: { thread: string; from?: string; title?: string; open?: OpenMode }) =>
      action(async () => {
        const context = await commandContext();
        const result = await forkThread(context.config, {
          threadId: options.thread,
          ...(options.from === undefined ? {} : { from: options.from }),
          ...(options.title === undefined ? {} : { title: options.title }),
          ...(options.open ? { openMode: options.open } : {}),
        });
        writeSuccess(result, context, `Forked thread ${result.source.id} into ${result.thread.id} (${result.thread.title}).`);
      }),
    );

  threadOption(threads.command("merge-back").description("Hand a fork's work back to the thread it came from, for that thread's next turn."))
    .option("--into <thread-id>", "Thread to merge into (defaults to the thread the fork came from).")
    .option("--from <point>", "Point of the fork to merge: latest (default), turn:<n>, or a run or checkpoint id.")
    .action((options: { thread: string; into?: string; from?: string }) =>
      action(async () => {
        const context = await commandContext();
        const result = await mergeBackThread(context.config, {
          threadId: options.thread,
          ...(options.into === undefined ? {} : { into: options.into }),
          ...(options.from === undefined ? {} : { from: options.from }),
        });
        writeSuccess(
          result,
          context,
          `Merged fork ${result.source.id} back into ${result.target.id}; T3 hands its work to that thread's next turn.`,
        );
      }),
    );
}

function registerQueue(threads: Command): void {
  const queue = threads.command("queue").description("List and rearrange messages waiting for a thread's running turn.");
  const run = (command: Command) => command.requiredOption("--run <run-id>", "Run id of the queued message (see threads queue list).");
  const changed = async (threadId: string, change: QueueChange, text: (result: Awaited<ReturnType<typeof changeQueue>>) => string) => {
    const context = await commandContext();
    const result = await changeQueue(context.config, threadId, change);
    writeSuccess(result, context, text(result));
  };

  threadOption(queue.command("list").description("List the queued messages in delivery order.")).action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await listQueue(context.config, options.thread);
      const lines = result.queue.map((entry) => [entry.position, entry.runId, entry.held ? "held" : "waiting", oneLine(entry.text)].join("\t"));
      writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : `No queued messages on thread ${result.thread.id}.`);
    }),
  );

  addPromptOptions(run(threadOption(queue.command("edit").description("Replace a queued message's text."))), "new message").action(
    (options: { thread: string; run: string } & PromptOptions) =>
      action(async () => {
        const text = await resolvePrompt(options);
        await changed(options.thread, { type: "edit", runId: options.run, text }, (result) => `Edited queued message ${options.run} on thread ${result.thread.id}.`);
      }),
  );

  run(threadOption(queue.command("cancel").description("Remove a message from the queue."))).action((options: { thread: string; run: string }) =>
    action(() =>
      changed(options.thread, { type: "cancel", runId: options.run }, (result) => `Cancelled queued message ${options.run} on thread ${result.thread.id}.`),
    ),
  );

  run(threadOption(queue.command("move").description("Move a queued message before another one, or to the end.")))
    .requiredOption("--before <run-id|end>", "Run id of the message to move in front of, or end.")
    .action((options: { thread: string; run: string; before: string }) =>
      action(() =>
        changed(
          options.thread,
          { type: "move", runId: options.run, beforeRunId: options.before === "end" ? null : options.before },
          (result) => {
            const position = result.queue.find((entry) => entry.runId === options.run)?.position;
            return `Moved queued message ${options.run} to position ${position ?? "?"} on thread ${result.thread.id}.`;
          },
        ),
      ),
    );

  run(threadOption(queue.command("promote").description("Send a queued message into the running turn instead of waiting.")))
    .action((options: { thread: string; run: string }) =>
      action(() =>
        changed(
          options.thread,
          { type: "promote", runId: options.run },
          (result) => `Sent queued message ${options.run} into the running turn on thread ${result.thread.id}.`,
        ),
      ),
    );

  threadOption(queue.command("resume").description("Release a queue that T3 holds after a restart.")).action((options: { thread: string }) =>
    action(() =>
      changed(options.thread, { type: "resume" }, (result) => `Resumed the queue on thread ${result.thread.id}; ${result.queue.length} message${result.queue.length === 1 ? "" : "s"} still waiting.`),
    ),
  );
}

function registerOrganize(threads: Command): void {
  const register = (
    command: Command,
    build: (options: Record<string, string>) => OrganizeAction,
    text: (result: Awaited<ReturnType<typeof organizeThread>>) => string,
  ) =>
    command.action((options: Record<string, string> & { thread: string }) =>
      action(async () => {
        const context = await commandContext();
        const result = await organizeThread(context.config, options.thread, build(options));
        writeSuccess(result, context, text(result));
      }),
    );

  register(threadOption(threads.command("pin").description("Pin a thread to the top of the sidebar.")), () => ({ type: "pin" }), (result) => `Pinned thread ${result.thread.id}.`);
  register(threadOption(threads.command("unpin").description("Unpin a thread.")), () => ({ type: "unpin" }), (result) => `Unpinned thread ${result.thread.id}.`);
  register(
    threadOption(threads.command("snooze").description("Hide a thread until a time, then bring it back."))
      .requiredOption("--until <time>", "An ISO time, or a duration from now such as 30m, 2h, or 1d."),
    (options) => ({ type: "snooze", until: snoozeTime(options.until!) }),
    (result) => `Snoozed thread ${result.thread.id} until ${String(result.change.after)}.`,
  );
  register(threadOption(threads.command("unsnooze").description("Bring a snoozed thread back now.")), () => ({ type: "unsnooze" }), (result) => `Woke thread ${result.thread.id}.`);
  register(threadOption(threads.command("archive").description("Archive a thread.")), () => ({ type: "archive" }), (result) => `Archived thread ${result.thread.id}.`);
  register(threadOption(threads.command("unarchive").description("Restore an archived thread.")), () => ({ type: "unarchive" }), (result) => `Restored thread ${result.thread.id} from the archive.`);
  register(
    threadOption(threads.command("rename").description("Change a thread's title.")).requiredOption("--title <text>", "The new title."),
    (options) => ({ type: "rename", title: options.title! }),
    (result) => `Renamed thread ${result.thread.id} to ${result.thread.title}.`,
  );
}

function registerSearch(threads: Command): void {
  threads
    .command("search")
    .description("Search the messages of every thread.")
    .requiredOption("--query <text>", "Text to find, 2 to 200 characters.")
    .option("--limit <count>", "Return at most <count> matches (1 to 50).", positiveInteger)
    .action((options: { query: string; limit?: number }) =>
      action(async () => {
        const context = await commandContext();
        const result = await searchThreads(context.config, { query: options.query, ...(options.limit === undefined ? {} : { limit: options.limit }) });
        const lines = result.matches.map((match) =>
          [match.threadId, match.projectTitle ?? match.projectId, match.threadTitle ?? "(unknown thread)", match.source, oneLine(match.snippet)].join("\t"),
        );
        writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : `No threads match ${result.query}.`);
      }),
    );
}

interface ScheduleCommandOptions extends PromptOptions {
  title?: string;
  every?: string;
  at?: string;
  days?: string;
  cwd?: string;
  project?: string;
  thread?: string;
  checkout?: "current" | "worktree";
  provider?: string;
  model?: string;
  thinkingEffort?: string;
  speedMode?: SpeedMode;
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode | "build";
  disabled?: boolean;
}

function addScheduleOptions(command: Command): Command {
  return addPromptOptions(command, "prompt")
    .option("--every <duration>", "Run repeatedly, such as every 30m, 2h, or 1d (at least 1m).")
    .option("--at <HH:MM>", "Run at this time of day, in the T3 server's local time.")
    .option("--days <days>", "With --at: days such as mon,wed,fri, weekdays, weekends, or daily (default daily).")
    .option("--cwd <path>", "Project to run in, resolved from this folder (defaults to the current folder).")
    .option("--project <project-id>", "Project to run in, by exact id.")
    .option("--thread <thread-id>", "Send each run to this thread instead of starting a new thread.")
    .addOption(new Option("--checkout <mode>", "Start each new thread in the project checkout or a new worktree.").choices(["current", "worktree"]))
    .option("--provider <instance-id>", "T3 provider instance id (for example codex or claudeAgent).")
    .option("--model <slug>", "Provider model slug.")
    .option("--thinking-effort <effort>", "Model-specific reasoning effort.")
    .addOption(new Option("--speed, --speed-mode <mode>", "Model speed mode.").choices(["standard", "fast"]))
    .addOption(
      new Option("--permission, --runtime-mode <mode>", "Permission/access level.").choices(["approval-required", "auto-accept-edits", "auto", "full-access"]),
    )
    .addOption(new Option("--mode, --interaction-mode <mode>", "Build/default or Plan mode.").choices(["default", "build", "plan"]))
    .option("--disabled", "Save the task without letting it run.");
}

async function scheduleOptions(options: ScheduleCommandOptions, promptRequired: boolean): Promise<ScheduleOptions> {
  const promptGiven = options.prompt !== undefined || options.promptFile !== undefined || options.stdin === true;
  const prompt = promptRequired || promptGiven ? await resolvePrompt(options) : undefined;
  const { prompt: _prompt, promptFile: _promptFile, stdin: _stdin, interactionMode, ...rest } = options;
  return {
    ...rest,
    ...(prompt === undefined ? {} : { prompt }),
    ...(interactionMode ? { interactionMode: interactionMode === "build" ? "default" : interactionMode } : {}),
  } as ScheduleOptions;
}

function describeTask(task: ScheduledTask): string {
  const when = `${describeSchedule(task.schedule)}${task.schedule.type === "fixed_time" ? " (server time)" : ""}`;
  return `${task.id} (${task.title}): ${when}, ${task.enabled ? `next run ${task.nextRunAt ?? "not planned"}` : "disabled"}`;
}

function registerSchedules(program: Command): void {
  const schedules = program.command("schedules").description("Create and manage T3 Code scheduled tasks.");
  const taskOption = (command: Command) => command.requiredOption("--task <task-id>", "Scheduled task id (see schedules list).");

  schedules
    .command("list")
    .description("List scheduled tasks, optionally for one project.")
    .option("--cwd <path>", "Only tasks of the project resolved from this folder.")
    .option("--project <project-id>", "Only tasks of this project.")
    .action((options: { cwd?: string; project?: string }) =>
      action(async () => {
        const context = await commandContext();
        const result = await listSchedules(context.config, options);
        const lines = result.tasks.map((task) =>
          [
            task.id,
            task.enabled ? "enabled" : "disabled",
            describeSchedule(task.schedule),
            task.nextRunAt ?? "-",
            task.threadId ? `thread ${task.threadId}` : "new thread",
            task.projectTitle ?? task.projectId,
            task.title,
          ].join("\t"),
        );
        writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : "No scheduled tasks.");
      }),
    );

  addScheduleOptions(
    schedules
      .command("create")
      .description("Schedule a prompt to run on an interval or at a time of day.")
      .requiredOption("--title <text>", "Task title; also the title of each thread it starts."),
  ).action((options: ScheduleCommandOptions) =>
      action(async () => {
        const context = await commandContext();
        const result = await createSchedule(context.config, await scheduleOptions(options, true));
        writeSuccess(result, context, `Created schedule ${describeTask(result.task)}.`);
      }),
    );

  addScheduleOptions(
    taskOption(schedules.command("update").description("Change a scheduled task; flags left out keep their value.")).option("--title <text>", "New task title."),
  ).action((options: ScheduleCommandOptions & { task: string }) =>
      action(async () => {
        const context = await commandContext();
        const { task, ...rest } = options;
        const result = await updateSchedule(context.config, task, await scheduleOptions(rest, false));
        writeSuccess(result, context, `Updated schedule ${describeTask(result.task)}.`);
      }),
    );

  for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
    taskOption(schedules.command(name).description(enabled ? "Let a scheduled task run again." : "Stop a scheduled task from running without deleting it.")).action(
      (options: { task: string }) =>
        action(async () => {
          const context = await commandContext();
          const result = await setScheduleEnabled(context.config, options.task, enabled);
          writeSuccess(result, context, `${enabled ? "Enabled" : "Disabled"} schedule ${describeTask(result.task)}.`);
        }),
    );
  }

  taskOption(schedules.command("delete").description("Delete a scheduled task.")).action((options: { task: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await deleteSchedule(context.config, options.task);
      writeSuccess(result, context, `Deleted schedule ${result.task.id} (${result.task.title}).`);
    }),
  );

  taskOption(schedules.command("run").description("Run a scheduled task now, once.")).action((options: { task: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await runSchedule(context.config, options.task);
      const target = result.task.threadId ? `sent its prompt to thread ${result.task.threadId}` : "started a new thread";
      writeSuccess(result, context, `Ran schedule ${result.task.id} (${result.task.title}): it ${target}.`);
    }),
  );
}

/**
 * Registers the commands that reach orchestrator V2 features beyond the 0.2 command set: forks,
 * merge-back, the message queue, scheduled tasks, search, and thread organization.
 */
export function registerV2Commands(program: Command, threads: Command): void {
  registerForks(threads);
  registerQueue(threads);
  registerSearch(threads);
  registerOrganize(threads);
  registerSchedules(program);
}
