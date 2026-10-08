#!/usr/bin/env node
import { stdin as input, stderr as errorOutput } from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

import { Command, CommanderError, Option } from "commander";

import { renderCatalog } from "./catalog.js";
import {
  action,
  addPromptOptions,
  addReplyOptions,
  collect,
  commandContext,
  describeSelection,
  jsonRequested,
  positiveInteger,
  program,
  resolvePrompt,
  renderWait,
  waitOptions,
  withReply,
  type ThreadWaitCommandOptions,
} from "./cliShared.js";
import { registerV2Commands } from "./cliV2.js";
import { CONFIG_KEYS, saveConfig, setConfigValue, type ConfigKey } from "./config.js";
import { doctor } from "./doctor.js";
import { CliError } from "./errors.js";
import { writeError, writeSuccess } from "./output.js";
import { READ_DETAILS, renderPendingRequests, renderTranscript, type ReadDetail } from "./transcript.js";
import {
  createHandoverThread,
  ensureProject,
  inspectThread,
  listProjects,
  listThreads,
  rawGet,
  readThread,
  resolveProject,
  sendThreadMessage,
  settleThread,
  type IfBusy,
  type ThreadCreateOptions,
  type ThreadListStatus,
  unsettleThread,
  waitForThread,
} from "./service.js";
import {
  answerThread,
  interruptThread,
  listModels,
  respondToApproval,
  updateThreadSettings,
  type ThreadSettingsChange,
} from "./threadControls.js";
import type {
  InteractionMode,
  ModelSelection,
  OpenMode,
  ProjectPolicy,
  ProviderOptionSelection,
  RuntimeMode,
  SpeedMode,
  ThreadEnvMode,
  T3Project,
  WorkspaceMode,
} from "./types.js";

function addWorkspaceOptions(command: Command): Command {
  return command
    .option("--cwd <path>", "Folder to resolve (defaults to the current working directory).")
    .addOption(new Option("--workspace-mode <mode>").choices(["repo", "folder"]));
}

function addProjectPolicyOption(command: Command): Command {
  return command.addOption(
    new Option("--project-policy <policy>", "Create a missing project or require an existing one.").choices([
      "create",
      "existing",
    ]),
  );
}

function addThreadOptions(command: Command): Command {
  return addReplyOptions(
    addPromptOptions(addProjectPolicyOption(addWorkspaceOptions(command)), "handover prompt")
      .addOption(new Option("--open <mode>").choices(["auto", "desktop", "browser", "none"]))
      .option("--provider <instance-id>", "T3 provider instance id (for example codex or claudeAgent).")
      .option("--model <slug>", "Provider model slug.")
      .addOption(new Option("--speed, --speed-mode <mode>", "Model speed mode.").choices(["standard", "fast"]))
      .option("--thinking-effort <effort>", "Model-specific reasoning/thinking effort.")
      .addOption(
        new Option("--checkout, --env-mode <mode>", "Use the current checkout or create a new worktree.").choices([
          "t3",
          "local",
          "current",
          "worktree",
        ]),
      )
      .addOption(
        new Option("--permission, --runtime-mode <mode>", "Permission/access level.").choices([
          "approval-required",
          "auto-accept-edits",
          "full-access",
        ]),
      )
      .addOption(new Option("--mode, --interaction-mode <mode>", "Build/default or Plan mode.").choices(["default", "build", "plan"]))
      .option("--wait", "Wait for the first turn to finish and print its reply.")
      .option("--dry-run", "Resolve and print the launch without starting it."),
  );
}

interface WorkspaceCommandOptions {
  cwd?: string;
  workspaceMode?: WorkspaceMode;
  projectPolicy?: ProjectPolicy;
  dryRun?: boolean;
}

interface ThreadCommandOptions extends WorkspaceCommandOptions, ThreadWaitCommandOptions {
  prompt?: string;
  promptFile?: string;
  stdin?: boolean;
  open?: OpenMode;
  envMode?: ThreadEnvMode | "current";
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode | "build";
  provider?: string;
  model?: string;
  speedMode?: SpeedMode;
  thinkingEffort?: string;
  wait?: boolean;
}

interface ThreadListCommandOptions extends WorkspaceCommandOptions {
  project?: string;
  status?: ThreadListStatus;
}

interface SettingsCommandOptions {
  provider?: string;
  model?: string;
  thinkingEffort?: string;
  speedMode?: SpeedMode;
  option?: string[];
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode | "build";
}

interface ThreadSendCommandOptions extends ThreadWaitCommandOptions, SettingsCommandOptions {
  thread: string;
  prompt?: string;
  promptFile?: string;
  stdin?: boolean;
  wakeSettled?: boolean;
  wait?: boolean;
  ifBusy: IfBusy;
  idempotencyKey?: string;
  startDesktop?: boolean;
}

interface ThreadRequestCommandOptions extends ThreadWaitCommandOptions {
  thread: string;
  request?: string;
  wait?: boolean;
}

/** Flags that change an existing thread's settings, shared by `threads set` and `threads send`. */
function addSettingsOptions(command: Command): Command {
  return command
    .option("--provider <instance-id>", "Switch to another provider instance; T3 hands the conversation over (needs --model).")
    .option("--model <slug>", "Switch the thread's model.")
    .option("--thinking-effort <effort>", "Reasoning effort, such as low, medium, high, xhigh, or max.")
    .addOption(new Option("--speed, --speed-mode <mode>", "Turn fast mode on or off.").choices(["standard", "fast"]))
    .option("--option <id=value>", "Set a provider model option, such as contextWindow=1m (repeatable).", collect)
    .addOption(
      new Option("--permission, --runtime-mode <mode>", "Permission/access level.").choices([
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]),
    )
    .addOption(new Option("--mode, --interaction-mode <mode>", "Build/default or Plan mode.").choices(["default", "build", "plan"]));
}

function parseModelOption(raw: string): ProviderOptionSelection {
  const separator = raw.indexOf("=");
  const id = separator > 0 ? raw.slice(0, separator).trim() : "";
  if (!id) throw new CliError("INVALID_MODEL_OPTION", `Write model options as id=value, not ${raw}.`, { exitCode: 2 });
  const value = raw.slice(separator + 1).trim();
  return { id, value: value === "true" ? true : value === "false" ? false : value };
}

function settingsChange(options: SettingsCommandOptions): ThreadSettingsChange {
  return {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinkingEffort ? { thinkingEffort: options.thinkingEffort } : {}),
    ...(options.speedMode ? { speedMode: options.speedMode } : {}),
    ...(options.option?.length ? { options: options.option.map(parseModelOption) } : {}),
    ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
    ...(options.interactionMode
      ? { interactionMode: options.interactionMode === "build" ? "default" : options.interactionMode }
      : {}),
  };
}

function describeChanges(changes: {
  modelSelection: ModelSelection | null;
  providerSwitch?: boolean;
  runtimeMode: RuntimeMode | null;
  interactionMode: InteractionMode | null;
}): string {
  return [
    ...(changes.modelSelection
      ? [`${changes.providerSwitch ? "provider and model" : "model"} ${describeSelection(changes.modelSelection)}`]
      : []),
    ...(changes.runtimeMode ? [`permission ${changes.runtimeMode}`] : []),
    ...(changes.interactionMode ? [`${changes.interactionMode === "plan" ? "plan" : "build"} mode`] : []),
  ].join(", ");
}

interface ThreadReadCommandOptions {
  thread: string;
  detail: ReadDetail;
  turns?: number;
  lastTurn?: boolean;
  firstTurn?: boolean;
  maxChars?: number;
}

async function confirmSettledThread(
  thread: { id: string; title: string; settledAt?: string | null },
  project: T3Project | null,
): Promise<boolean> {
  if (!input.isTTY || !errorOutput.isTTY) {
    throw new CliError(
      "SETTLED_THREAD_CONFIRMATION_REQUIRED",
      `Thread ${thread.id} is settled. Re-run with --wake-settled to send and wake it.`,
      { exitCode: 4, details: { threadId: thread.id, settledAt: thread.settledAt } },
    );
  }
  const readline = createInterface({ input, output: errorOutput });
  try {
    const projectLabel = project ? ` in ${project.title}` : "";
    const answer = await readline.question(`Thread “${thread.title}”${projectLabel} is settled. Send this message and wake it? [y/N] `);
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}

function threadCreateOptions(options: ThreadCommandOptions, prompt: string): ThreadCreateOptions {
  return {
    prompt,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.workspaceMode ? { workspaceMode: options.workspaceMode } : {}),
    ...(options.projectPolicy ? { projectPolicy: options.projectPolicy } : {}),
    ...(options.open ? { openMode: options.open } : {}),
    ...(options.envMode ? { threadEnvMode: options.envMode === "current" ? "local" : options.envMode } : {}),
    ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
    ...(options.interactionMode
      ? { interactionMode: options.interactionMode === "build" ? "default" : options.interactionMode }
      : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.speedMode ? { speedMode: options.speedMode } : {}),
    ...(options.thinkingEffort ? { thinkingEffort: options.thinkingEffort } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.wait ? { wait: waitOptions(options) } : {}),
  };
}

program.command("doctor").description("Check T3 discovery, protocol, auth tooling, and desktop integration.").action(() =>
  action(async () => {
    const context = await commandContext();
    const result = await doctor(context.config, context.configPath, context.configExists);
    writeSuccess(result, context, result.ok ? "T3 Code CLI is ready." : "T3 Code CLI has failing checks.");
    if (!result.ok) process.exitCode = 1;
  }),
);

const configCommand = program.command("config").description("Inspect or update t3code-cli settings.");
configCommand.command("path").action(() =>
  action(async () => {
    const context = await commandContext();
    writeSuccess({ path: context.configPath }, context, context.configPath);
  }),
);
configCommand.command("show").action(() =>
  action(async () => {
    const context = await commandContext();
    writeSuccess({ path: context.configPath, exists: context.configExists, config: context.config }, context);
  }),
);
configCommand
  .command("set")
  .argument("<key>", `Setting key: ${CONFIG_KEYS.join(", ")}`)
  .argument("<value>")
  .action((key: string, value: string) =>
    action(async () => {
      if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
        throw new CliError("INVALID_CONFIG_KEY", `Unknown config key: ${key}`);
      }
      const context = await commandContext();
      const next = setConfigValue(context.config, key as ConfigKey, value);
      await saveConfig(context.configPath, next);
      writeSuccess({ path: context.configPath, config: next }, context, `Saved ${key}=${value}.`);
    }),
  );

const projects = program.command("projects").description("Resolve and manage T3 Code projects.");
projects.command("list").action(() =>
  action(async () => {
    const context = await commandContext();
    const result = await listProjects(context.config);
    const lines = result.projects.map((project) => `${project.id}\t${project.workspaceRoot}\t${project.title}`);
    writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : "No active projects.");
  }),
);
addWorkspaceOptions(projects.command("resolve"))
  .description("Resolve a folder/repository to an existing T3 project.")
  .action((options: WorkspaceCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const result = await resolveProject(context.config, options);
      writeSuccess(
        result,
        context,
        result.project
          ? `${result.project.id}\t${result.project.workspaceRoot}\t${result.project.title}`
          : `No project for ${result.workspace.workspaceRoot}.`,
      );
    }),
  );
addProjectPolicyOption(addWorkspaceOptions(projects.command("ensure")))
  .description("Resolve a project and create it when policy permits.")
  .option("--dry-run", "Do not create the project.")
  .action((options: WorkspaceCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const result = await ensureProject(context.config, options);
      writeSuccess(
        result,
        context,
        `${result.created ? (options.dryRun ? "Would create" : "Created") : "Resolved"} ${result.project.id} (${result.project.title}) at ${result.project.workspaceRoot}.`,
      );
    }),
  );

const threads = program.command("threads").description("Create, inspect, message, and organize T3 Code threads.");
threads
  .command("list")
  .description("List active and settled threads.")
  .option("--cwd <path>", "Filter by the T3 project resolved from this folder.")
  .addOption(new Option("--workspace-mode <mode>").choices(["repo", "folder"]))
  .option("--project <project-id>", "Filter by an exact T3 project id.")
  .addOption(new Option("--status <status>", "Filter by thread lifecycle status.").choices(["active", "settled", "all"]).default("all"))
  .action((options: ThreadListCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const result = await listThreads(context.config, options);
      const projectById = new Map(result.projects.map((project) => [project.id, project]));
      const lines = result.threads.map((thread) => {
        const project = projectById.get(thread.projectId);
        return [
          thread.status,
          thread.runStatus,
          thread.id,
          project?.title ?? thread.projectId,
          thread.title,
          thread.modelSelection?.model ?? "unknown-model",
          thread.updatedAt ?? "unknown-time",
        ].join("\t");
      });
      writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : "No matching threads.");
    }),
  );

threads
  .command("inspect")
  .description("Inspect a thread before targeting it.")
  .requiredOption("--thread <thread-id>", "Exact T3 thread id.")
  .action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await inspectThread(context.config, options.thread);
      const thread = result.thread;
      const requests = thread.pendingRequests;
      const kinds = [...new Set(requests.map((request) => (request.kind === "approval" ? "approval" : "user input")))];
      const run = thread.activeRun ?? thread.latestRun;
      writeSuccess(
        result,
        context,
        [
          `Thread: ${thread.id}`,
          `Title: ${thread.title}`,
          `Project: ${result.project?.title ?? thread.projectId}`,
          `Workspace: ${thread.worktreePath ?? result.project?.workspaceRoot ?? "unknown"}${thread.branch ? ` (branch ${thread.branch})` : ""}`,
          `Status: ${thread.status}`,
          `Model: ${describeSelection(thread.modelSelection)}`,
          `Settings: permission ${thread.runtimeMode ?? "unknown"}, ${thread.interactionMode === "plan" ? "plan" : "build"} mode`,
          `Turns: ${thread.turnCount} (${thread.messageCount} messages)`,
          `${thread.activeRun ? "Running turn" : "Latest turn"}: ${run ? `${run.status} (${run.runId})` : "none"}`,
          ...(thread.queue.length > 0
            ? [`Queue: ${thread.queue.length} message${thread.queue.length === 1 ? "" : "s"}${thread.queue.some((entry) => entry.held) ? " (held until resumed)" : ""}`]
            : []),
          ...(kinds.length > 0 ? [`Waiting for: ${kinds.join(" and ")}`] : []),
          ...(requests.length > 0 ? [renderPendingRequests(requests)] : []),
          `Updated: ${thread.updatedAt ?? "unknown"}`,
        ].join("\n"),
      );
    }),
  );

threads
  .command("read")
  .description("Read a thread's conversation as a transcript, from final answers only to full tool detail.")
  .requiredOption("--thread <thread-id>", "Exact T3 thread id.")
  .addOption(
    new Option("--detail <level>", "answers: prompts and final answers; messages: without reasoning or tools; full: everything.")
      .choices(READ_DETAILS)
      .default("messages"),
  )
  .option("--turns <count>", "Return only the last <count> turns.", positiveInteger)
  .option("--last-turn", "Return only the latest turn (same as --turns 1).")
  .option("--first-turn", "Also return the first turn, which holds the original request.")
  .option("--max-chars <count>", "Clip each message, tool input, and tool output to <count> characters.", positiveInteger)
  .action((options: ThreadReadCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      if (options.lastTurn && options.turns !== undefined && options.turns !== 1) {
        throw new CliError("THREAD_FILTER_CONFLICT", "Use either --last-turn or --turns, not both.", { exitCode: 2 });
      }
      const turns = options.lastTurn ? 1 : options.turns;
      const result = await readThread(context.config, options.thread, {
        detail: options.detail,
        ...(turns === undefined ? {} : { turns }),
        ...(options.firstTurn ? { firstTurn: true } : {}),
        ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
      });
      const thread = result.thread;
      const shown = thread.turns.filter((turn) => turn.state !== "pending").map((turn) => turn.index);
      const range = shown.length === thread.view.totalTurns ? "all" : shown.join(", ") || "none";
      writeSuccess(
        result,
        context,
        [
          `Thread: ${thread.id}`,
          `Title: ${thread.title}`,
          `Project: ${result.project?.title ?? thread.projectId}`,
          `Status: ${thread.status}, ${thread.activeRun ? `running turn ${thread.activeRun.status}` : `latest turn ${thread.latestRun?.status ?? "none"}`}`,
          `View: ${thread.view.detail}, turns ${range} of ${thread.view.totalTurns}`,
          "",
          renderTranscript(thread) || "No messages.",
        ].join("\n"),
      );
    }),
  );

addReplyOptions(
  addSettingsOptions(
    addPromptOptions(
      threads
        .command("send")
        .description("Send a message to an existing thread, optionally changing its model or modes first.")
        .requiredOption("--thread <thread-id>", "Exact T3 thread id."),
    )
      .option("--wake-settled", "Explicitly allow this message to wake a settled thread.")
      .option("--wait", "Wait for the turn that handles the message and print its reply.")
      .option("--idempotency-key <key>", "Retry this exact message safely; changing its text creates a different message.")
      .option("--no-start-desktop", "Fail instead of launching T3 Code when it is not running.")
      .addOption(
        new Option(
          "--if-busy <mode>",
          "When a turn runs or messages wait: refuse sends nothing; queue waits its turn; steer joins the running turn; restart stops it and starts over.",
        )
          .choices(["refuse", "queue", "steer", "restart", "reject", "inject"])
          .default("refuse"),
      ),
  ),
).action((options: ThreadSendCommandOptions) =>
  action(async () => {
    const context = await commandContext();
    const prompt = await resolvePrompt(options);
    const result = await sendThreadMessage(context.config, {
      threadId: options.thread,
      prompt,
      ...(options.wakeSettled ? { wakeSettled: true } : {}),
      ...(!context.json && !options.stdin ? { confirmSettled: confirmSettledThread } : {}),
      ...(options.wait ? { wait: waitOptions(options) } : {}),
      settings: settingsChange(options),
      ifBusy: options.ifBusy,
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.startDesktop !== undefined ? { startDesktop: options.startDesktop } : {}),
    });
    const changed = "settings" in result && result.settings ? describeChanges(result.settings) : "";
    const delivery =
      result.message.delivery === "start_immediately"
        ? "it starts a new turn"
        : result.message.delivery === "queue_after_active"
          ? "it waits in the queue"
          : result.message.delivery === "steer_active"
            ? "it joins the running turn"
            : "it restarts the running turn";
    const sent = result.message.delivery === "already_delivered"
      ? `Message ${result.message.messageId} was already delivered to thread ${result.thread.id}; nothing sent.`
      : `${changed ? `Changed ${changed}. ` : ""}Sent message ${result.message.messageId} to thread ${result.thread.id}; ${delivery}.`;
    writeSuccess(result, context, withReply(sent, result));
  }),
);

addReplyOptions(
  threads
    .command("wait")
    .description("Wait until a thread's current turn and queue finish or need a person, then print the turn.")
    .requiredOption("--thread <thread-id>", "Exact T3 thread id."),
).action((options: ThreadWaitCommandOptions & { thread: string }) =>
  action(async () => {
    const context = await commandContext();
    const result = await waitForThread(context.config, options.thread, waitOptions(options));
    writeSuccess(result, context, `Thread: ${result.thread.id}\nTitle: ${result.thread.title}\n${renderWait(result)}`);
  }),
);

addSettingsOptions(
  threads
    .command("set")
    .description("Change a thread's model, provider, reasoning effort, fast mode, permission, or plan mode without sending a message.")
    .requiredOption("--thread <thread-id>", "Exact T3 thread id.")
    .option("--dry-run", "Check the change and print its commands without dispatching them."),
).action((options: SettingsCommandOptions & { thread: string; dryRun?: boolean }) =>
  action(async () => {
    const context = await commandContext();
    const result = await updateThreadSettings(context.config, {
      threadId: options.thread,
      change: settingsChange(options),
      ...(options.dryRun ? { dryRun: true } : {}),
    });
    const notes = [
      ...(result.changes.providerSwitch && !result.dryRun
        ? ["T3 hands the conversation to the new provider with its recent history."]
        : []),
      ...(result.changes.modelSelection && !result.changes.catalogUsed
        ? ["T3 did not return its model catalog, so the options were not checked."]
        : []),
    ];
    writeSuccess(
      result,
      context,
      result.changed
        ? `${result.dryRun ? "Would change" : "Changed"} thread ${result.thread.id}: ${describeChanges(result.changes)}.${notes.map((note) => ` ${note}`).join("")}`
        : `Thread ${result.thread.id} already uses these settings.`,
    );
  }),
);

threads
  .command("interrupt")
  .description("Stop a thread's running turn.")
  .requiredOption("--thread <thread-id>", "Exact T3 thread id.")
  .action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await interruptThread(context.config, options.thread);
      writeSuccess(result, context, `Interrupted thread ${result.thread.id}: its turn is now ${result.runStatus}.`);
    }),
  );

addReplyOptions(
  threads
    .command("approve")
    .description("Approve the thread's pending approval request.")
    .requiredOption("--thread <thread-id>", "Exact T3 thread id.")
    .option("--request <request-id>", "The approval to answer when several are pending.")
    .addOption(
      new Option("--scope <scope>", "Approve once, for the rest of the session, or always when the request offers it.")
        .choices(["once", "session", "always"])
        .default("once"),
    )
    .option("--wait", "Then wait for the turn to finish or stop again, and print it."),
).action((options: ThreadRequestCommandOptions & { scope: "once" | "session" | "always" }) =>
  action(async () => {
    const context = await commandContext();
    const decision = options.scope === "session" ? "acceptForSession" : options.scope === "always" ? "acceptAlways" : "accept";
    const result = await respondToApproval(context.config, {
      threadId: options.thread,
      decision,
      ...(options.request ? { requestId: options.request } : {}),
      ...(options.wait ? { wait: waitOptions(options) } : {}),
    });
    const subject = result.request.detail ?? result.request.requestKind ?? "the request";
    writeSuccess(result, context, withReply(`Approved ${subject} on thread ${result.thread.id} (${decision}).`, result));
  }),
);

addReplyOptions(
  threads
    .command("decline")
    .description("Decline the thread's pending approval request.")
    .requiredOption("--thread <thread-id>", "Exact T3 thread id.")
    .option("--request <request-id>", "The approval to answer when several are pending.")
    .option("--cancel", "Cancel instead of declining; Codex then also stops the turn.")
    .option("--wait", "Then wait for the turn to finish or stop again, and print it."),
).action((options: ThreadRequestCommandOptions & { cancel?: boolean }) =>
  action(async () => {
    const context = await commandContext();
    const decision = options.cancel ? "cancel" : "decline";
    const result = await respondToApproval(context.config, {
      threadId: options.thread,
      decision,
      ...(options.request ? { requestId: options.request } : {}),
      ...(options.wait ? { wait: waitOptions(options) } : {}),
    });
    const subject = result.request.detail ?? result.request.requestKind ?? "the request";
    writeSuccess(result, context, withReply(`Declined ${subject} on thread ${result.thread.id} (${decision}).`, result));
  }),
);

addReplyOptions(
  threads
    .command("answer")
    .description("Answer, or dismiss, a question the thread asked.")
    .requiredOption("--thread <thread-id>", "Exact T3 thread id.")
    .option("--request <request-id>", "The question to answer when several are pending.")
    .option("--answer <answer>", "An answer, or <question>=<answer> with the question's number when it asks several (repeatable).", collect)
    .option("--dismiss", "Dismiss a question that no running turn waits on, instead of answering it.")
    .option("--wait", "Then wait for the turn that continues with the answer, and print it."),
).action((options: ThreadRequestCommandOptions & { answer?: string[]; dismiss?: boolean }) =>
  action(async () => {
    const context = await commandContext();
    const result = await answerThread(context.config, {
      threadId: options.thread,
      ...(options.request ? { requestId: options.request } : {}),
      ...(options.answer ? { answers: options.answer } : {}),
      ...(options.dismiss ? { dismiss: true } : {}),
      ...(options.wait ? { wait: waitOptions(options) } : {}),
    });
    const text = result.dismissed
      ? `Dismissed question ${result.request.requestId} on thread ${result.thread.id}.`
      : `Answered question ${result.request.requestId} on thread ${result.thread.id}.${result.startsTurn ? " T3 sends the answer to the thread as a new turn." : ""}`;
    writeSuccess(result, context, withReply(text, result));
  }),
);

threads
  .command("settle")
  .description("Mark a thread as settled after verifying it can be settled.")
  .requiredOption("--thread <thread-id>", "Exact T3 thread id.")
  .action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await settleThread(context.config, options.thread);
      writeSuccess(result, context, `Settled thread ${result.thread.id}; T3 shows the lifecycle change.`);
    }),
  );

threads
  .command("unsettle")
  .description("Mark a settled thread as active without starting a turn.")
  .requiredOption("--thread <thread-id>", "Exact T3 thread id.")
  .action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await unsettleThread(context.config, options.thread);
      writeSuccess(result, context, `Marked thread ${result.thread.id} active; T3 shows the lifecycle change.`);
    }),
  );

function handoverText(result: Awaited<ReturnType<typeof createHandoverThread>>, verb: string): string {
  const head = `${result.dryRun ? `Would ${verb}` : verb === "create" ? "Created" : "Handed over to"} thread ${result.thread.id} in ${result.project.title}.`;
  return withReply(head, result);
}

addThreadOptions(threads.command("create"))
  .description("Create a new project thread and start its first turn.")
  .action((options: ThreadCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const prompt = await resolvePrompt(options);
      const result = await createHandoverThread(context.config, threadCreateOptions(options, prompt));
      writeSuccess(result, context, handoverText(result, "create"));
    }),
  );

addThreadOptions(program.command("handover"))
  .description("Resolve the current repo, ensure its project, and start a new T3 Code thread.")
  .action((options: ThreadCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const prompt = await resolvePrompt(options);
      const result = await createHandoverThread(context.config, threadCreateOptions(options, prompt));
      writeSuccess(result, context, handoverText(result, "hand over to"));
    }),
  );

program
  .command("models")
  .description("List T3 Code's providers, models, and model options.")
  .command("list")
  .description("List provider instances with their models, reasoning efforts, and other options.")
  .option("--provider <instance-id>", "Show one provider instance with all of its models.")
  .action((options: { provider?: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await listModels(context.config, options.provider ? { provider: options.provider } : {});
      writeSuccess(result, context, renderCatalog({ providers: result.providers }, options.provider !== undefined));
    }),
  );

program
  .command("request")
  .description("Raw read-only HTTP escape hatch.")
  .command("get")
  .argument("<path>", "T3 API path, such as api/orchestration/shell (the leading slash is optional).")
  .action((requestPath: string) =>
    action(async () => {
      const context = await commandContext();
      const result = await rawGet(context.config, requestPath);
      writeSuccess(result, context);
    }),
  );

registerV2Commands(program, threads);

program.command("babysit")
  .description("Inspect PR state and manage durable babysitting events without an idle agent turn.")
  .helpOption(false)
  .allowUnknownOption()
  .argument("[arguments...]", "Arguments for the bundled babysit helper; use --help for its commands.")
  .action(async (args: string[]) => {
    const global = program.opts<{ config?: string; origin?: string; t3Home?: string }>();
    const env = { ...process.env,
      ...(global.config ? { T3CODE_CLI_CONFIG: global.config } : {}),
      ...(global.origin ? { T3CODE_CLI_ORIGIN: global.origin } : {}),
      ...(global.t3Home ? { T3CODE_HOME: global.t3Home } : {}),
    };
    const helper = fileURLToPath(new URL("../skills/babysit/scripts/babysit.mjs", import.meta.url));
    process.exitCode = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [helper, ...args], { stdio: "inherit", windowsHide: true, env });
      child.on("error", (cause) => {
        writeError(new CliError("BABYSIT_HELPER_START_FAILED", "Could not start the bundled babysit helper.", { cause }), { json: jsonRequested });
        resolve(1);
      });
      child.on("close", (code) => resolve(code ?? 1));
    });
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (!(error instanceof CommanderError)) throw error;
  if (error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    const message = error.message.replace(/^error:\s*/u, "");
    const cliError = writeError(new CliError("INVALID_USAGE", message, { exitCode: 2 }), {
      json: jsonRequested,
    });
    process.exitCode = cliError.exitCode;
  }
}
// Exit only after pending stdout/stderr writes drain, so large piped JSON is complete.
// Exiting still stops lingering handles, such as a WebSocket awaiting its close handshake.
const flush = (stream: NodeJS.WriteStream) => new Promise<void>((resolve) => stream.write("", () => resolve()));
await Promise.all([flush(process.stdout), flush(process.stderr)]);
process.exit(process.exitCode ?? 0);
