#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { stdin as input, stderr as errorOutput } from "node:process";
import { createInterface } from "node:readline/promises";

import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import {
  CONFIG_KEYS,
  expandHome,
  loadConfig,
  saveConfig,
  setConfigValue,
  type ConfigKey,
} from "./config.js";
import { renderCatalog } from "./catalog.js";
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
  type ThreadCreateOptions,
  type ThreadListStatus,
  unsettleThread,
  waitForThread,
  type ThreadWaitOptions,
  type ThreadWaitView,
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
  CliConfig,
  InteractionMode,
  ModelSelection,
  OpenMode,
  ProjectPolicy,
  ProviderOptionSelection,
  RuntimeMode,
  SpeedMode,
  ThreadEnvMode,
  T3Project,
  T3Thread,
  WorkspaceMode,
} from "./types.js";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();
const jsonRequested = process.argv.slice(2).includes("--json");
program
  .name("t3code")
  .description("Manage T3 Code projects, handover threads, and cross-thread messages.")
  .version(packageJson.version)
  .option("--json", "Emit stable JSON envelopes.")
  .option("--config <path>", "Use a specific config file.")
  .option("--t3-home <path>", "Override T3CODE_HOME for this command.")
  .option("--origin <url>", "Override the running T3 server origin.");
program.configureOutput({ outputError: () => undefined }).exitOverride();

interface GlobalOptions {
  json?: boolean;
  config?: string;
  t3Home?: string;
  origin?: string;
}

async function commandContext(): Promise<{
  config: CliConfig;
  configPath: string;
  configExists: boolean;
  json: boolean;
}> {
  const global = program.opts<GlobalOptions>();
  const loaded = await loadConfig(global.config);
  const config = { ...loaded.config };
  if (global.t3Home) config.t3Home = path.resolve(expandHome(global.t3Home));
  if (global.origin) config.origin = new URL(global.origin).origin;
  return { config, configPath: loaded.path, configExists: loaded.exists, json: global.json ?? false };
}

async function action(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const global = program.opts<GlobalOptions>();
    const cliError = writeError(error, { json: global.json ?? false });
    process.exitCode = cliError.exitCode;
  }
}

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
  return addProjectPolicyOption(addWorkspaceOptions(command))
    .option("--prompt <text>", "Handover prompt.")
    .option("--prompt-file <path>", "Read the handover prompt from a UTF-8 file.")
    .option("--stdin", "Read the handover prompt from stdin.")
    .addOption(new Option("--open <mode>").choices(["auto", "desktop", "browser", "none"]))
    .option("--provider <instance-id>", "T3 provider instance id (for example codex or claudeAgent).")
    .option("--model <slug>", "Provider model slug.")
    .addOption(
      new Option("--speed, --speed-mode <mode>", "Model speed mode.")
        .choices(["standard", "fast"]),
    )
    .option("--thinking-effort <effort>", "Model-specific reasoning/thinking effort.")
    .addOption(
      new Option("--checkout, --env-mode <mode>", "Use the current checkout or create a new worktree.")
        .choices(["t3", "local", "current", "worktree"]),
    )
    .addOption(
      new Option("--permission, --runtime-mode <mode>", "Permission/access level.")
        .choices(["approval-required", "auto-accept-edits", "full-access"]),
    )
    .addOption(
      new Option("--mode, --interaction-mode <mode>", "Build/default or Plan mode.")
        .choices(["default", "build", "plan"]),
    )
    .option("--dry-run", "Resolve and print commands without dispatching them.");
}

interface WorkspaceCommandOptions {
  cwd?: string;
  workspaceMode?: WorkspaceMode;
  projectPolicy?: ProjectPolicy;
  dryRun?: boolean;
}

interface ThreadCommandOptions extends WorkspaceCommandOptions {
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
}

interface PromptOptions {
  prompt?: string;
  promptFile?: string;
  stdin?: boolean;
}

interface ThreadListCommandOptions extends WorkspaceCommandOptions {
  project?: string;
  status?: ThreadListStatus;
}

interface ThreadWaitCommandOptions {
  thread: string;
  timeout?: number;
  detail?: ReadDetail;
  maxChars?: number;
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

interface ThreadSendCommandOptions extends PromptOptions, ThreadWaitCommandOptions, SettingsCommandOptions {
  wakeSettled?: boolean;
  wait?: boolean;
}

interface ThreadRequestCommandOptions extends ThreadWaitCommandOptions {
  request?: string;
  wait?: boolean;
}

const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Flags that change an existing thread's settings, shared by `threads set` and `threads send`. */
function addSettingsOptions(command: Command): Command {
  return command
    .option("--provider <instance-id>", "Switch to another provider instance of the same driver (needs --model).")
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
    .addOption(
      new Option("--mode, --interaction-mode <mode>", "Build/default or Plan mode.").choices(["default", "build", "plan"]),
    );
}

/** Flags that control how long to wait for a turn and how much of it to print. */
function addReplyOptions(command: Command): Command {
  return command
    .option("--timeout <seconds>", "Stop waiting after <seconds> (default 600).", positiveInteger)
    .addOption(
      new Option("--detail <level>", "Turn detail: answers, messages, or full (default answers).").choices(READ_DETAILS),
    )
    .option("--max-chars <count>", "Clip each message and tool entry to <count> characters.", positiveInteger);
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

function describeSelection(selection: ModelSelection | null | undefined): string {
  if (!selection) return "unknown";
  const options = (selection.options ?? []).map((option) => `${option.id}=${String(option.value)}`).join(", ");
  return `${selection.instanceId}/${selection.model}${options ? ` (${options})` : ""}`;
}

function describeChanges(changes: {
  modelSelection: ModelSelection | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: InteractionMode | null;
}): string {
  return [
    ...(changes.modelSelection ? [`model ${describeSelection(changes.modelSelection)}`] : []),
    ...(changes.runtimeMode ? [`permission ${changes.runtimeMode}`] : []),
    ...(changes.interactionMode ? [`${changes.interactionMode === "plan" ? "plan" : "build"} mode`] : []),
  ].join(", ");
}

function withReply(text: string, result: Partial<ThreadWaitView>): string {
  const { wait, pendingRequests, reply } = result;
  return wait && pendingRequests && reply ? `${text}\n${renderWait({ wait, pendingRequests, reply })}` : text;
}

function waitOptions(options: ThreadWaitCommandOptions): ThreadWaitOptions {
  return {
    timeoutMs: (options.timeout ?? DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000,
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
  };
}

function renderWait(result: ThreadWaitView): string {
  const { wait } = result;
  const seconds = Math.round(wait.waitedMs / 1000);
  const headline =
    wait.error !== undefined
      ? `T3 could not start the turn: ${wait.error}`
      : wait.outcome === "needs-attention"
        ? `The thread is waiting for a person (waited ${seconds}s):\n${renderPendingRequests(result.pendingRequests) || "- a pending approval or question"}`
        : wait.outcome === "idle"
          ? "The thread has no turns yet."
          : `Turn ${wait.turnIndex} ${wait.outcome} (waited ${seconds}s); the thread is now ${wait.statusAfter}.`;
  const transcript = renderTranscript(result.reply);
  return transcript ? `${headline}\n\n${transcript}` : headline;
}

interface ThreadReadCommandOptions {
  thread: string;
  detail: ReadDetail;
  turns?: number;
  lastTurn?: boolean;
  firstTurn?: boolean;
  maxChars?: number;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/u.test(value.trim()) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Expected a positive whole number.");
  }
  return parsed;
}

async function readStdin(): Promise<string> {
  input.setEncoding("utf8");
  let value = "";
  for await (const chunk of input) value += chunk;
  return value;
}

async function resolvePrompt(options: PromptOptions): Promise<string> {
  const sources = [options.prompt !== undefined, options.promptFile !== undefined, options.stdin === true].filter(Boolean);
  if (sources.length !== 1) {
    throw new CliError("PROMPT_SOURCE_REQUIRED", "Use exactly one of --prompt, --prompt-file, or --stdin.");
  }
  if (options.prompt !== undefined) return options.prompt;
  if (options.promptFile !== undefined) return await readFile(path.resolve(options.promptFile), "utf8");
  return await readStdin();
}

async function confirmSettledThread(thread: T3Thread, project: T3Project | null): Promise<boolean> {
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
    const answer = await readline.question(
      `Thread “${thread.title}”${projectLabel} is settled. Send this message and wake it? [y/N] `,
    );
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
  };
}

program.command("doctor").description("Check T3 discovery, auth tooling, and desktop integration.").action(() =>
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
  .option("--dry-run", "Do not dispatch project.create.")
  .action((options: WorkspaceCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const result = await ensureProject(context.config, options);
      writeSuccess(
        result,
        context,
        `${result.created ? "Created" : "Resolved"} ${result.project.id} (${result.project.title}) at ${result.project.workspaceRoot}.`,
      );
    }),
  );

const threads = program.command("threads").description("Create, inspect, and message T3 Code threads.");
threads.command("list")
  .description("List active and settled threads.")
  .option("--cwd <path>", "Filter by the T3 project resolved from this folder.")
  .addOption(new Option("--workspace-mode <mode>").choices(["repo", "folder"]))
  .option("--project <project-id>", "Filter by an exact T3 project id.")
  .addOption(
    new Option("--status <status>", "Filter by thread lifecycle status.")
      .choices(["active", "settled", "all"])
      .default("all"),
  )
  .action((options: ThreadListCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const result = await listThreads(context.config, options);
      const projectById = new Map(result.projects.map((project) => [project.id, project]));
      const lines = result.threads.map((thread) => {
        const project = projectById.get(thread.projectId);
        return [
          thread.status,
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
      const latestTurn = thread.latestTurn;
      const requests = thread.pendingRequests;
      const blocked = [
        ...(thread.hasPendingApprovals || requests.some((request) => request.kind === "approval") ? ["approval"] : []),
        ...(thread.hasPendingUserInput || requests.some((request) => request.kind === "user-input") ? ["user input"] : []),
      ];
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
          `Session: ${thread.session?.status ?? "none"}`,
          `Turns: ${thread.turnCount} (${thread.messageCount} messages)`,
          `Latest turn: ${latestTurn ? `${latestTurn.state} (${latestTurn.turnId})` : "none"}`,
          ...(blocked.length > 0 ? [`Waiting for: ${blocked.join(" and ")}`] : []),
          ...(requests.length > 0 ? [renderPendingRequests(requests)] : []),
          ...(thread.contextWindow
            ? [`Context: ${thread.contextWindow.usedTokens} tokens${thread.contextWindow.maxTokens ? ` of ${thread.contextWindow.maxTokens}` : ""}`]
            : []),
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
      const shown = thread.turns.filter((turn) => turn.turnId !== null).map((turn) => turn.index);
      const range = shown.length === thread.view.totalTurns ? "all" : shown.join(", ") || "none";
      writeSuccess(
        result,
        context,
        [
          `Thread: ${thread.id}`,
          `Title: ${thread.title}`,
          `Project: ${result.project?.title ?? thread.projectId}`,
          `Status: ${thread.status}${thread.latestTurn ? `, latest turn ${thread.latestTurn.state}` : ""}`,
          `View: ${thread.view.detail}, turns ${range} of ${thread.view.totalTurns}`,
          "",
          renderTranscript(thread) || "No messages.",
        ].join("\n"),
      );
    }),
  );

addReplyOptions(
  addSettingsOptions(
    threads
      .command("send")
      .description("Start a new turn on an existing thread, optionally changing its model or modes first.")
      .requiredOption("--thread <thread-id>", "Exact T3 thread id.")
      .option("--prompt <text>", "Message text.")
      .option("--prompt-file <path>", "Read the message from a UTF-8 file.")
      .option("--stdin", "Read the message from stdin.")
      .option("--wake-settled", "Explicitly allow this message to wake a settled thread.")
      .option("--wait", "Wait for the turn that handles the message and print its reply."),
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
    });
    const changed = result.settings ? describeChanges(result.settings) : "";
    const sent = `${changed ? `Changed ${changed}. ` : ""}Sent message ${result.message.messageId} to thread ${result.thread.id}; T3 accepted and projected the turn.`;
    writeSuccess(result, context, withReply(sent, result));
  }),
);

addReplyOptions(
  threads
    .command("wait")
    .description("Wait until a thread's current turn finishes or needs a person, then print that turn.")
    .requiredOption("--thread <thread-id>", "Exact T3 thread id."),
).action((options: ThreadWaitCommandOptions) =>
  action(async () => {
    const context = await commandContext();
    const result = await waitForThread(context.config, options.thread, waitOptions(options));
    writeSuccess(result, context, `Thread: ${result.thread.id}\nTitle: ${result.thread.title}\n${renderWait(result)}`);
  }),
);

addSettingsOptions(
  threads
    .command("set")
    .description("Change a thread's model, reasoning effort, fast mode, permission, or plan mode without sending a message.")
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
      ...(result.sessionRestart && !result.dryRun ? ["T3 restarted the provider session to apply the permission mode."] : []),
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
      writeSuccess(
        result,
        context,
        `Interrupted thread ${result.thread.id}: its latest turn is ${result.latestTurn?.state ?? "unknown"} and the session is ${result.sessionStatus ?? "gone"}.${result.providerError ? ` The provider reported: ${result.providerError}` : ""}`,
      );
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
    .option(
      "--answer <answer>",
      "An answer, or <question>=<answer> with the question's number when it asks several (repeatable).",
      collect,
    )
    .option("--dismiss", "Dismiss a question that outlived its turn instead of answering it.")
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
      : `Answered question ${result.request.requestId} on thread ${result.thread.id}.${result.answerMessageId ? " T3 sends the answer to the thread as a new message." : ""}`;
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
      writeSuccess(
        result,
        context,
        `Settled thread ${result.thread.id}; T3 projected the lifecycle change.`,
      );
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
      writeSuccess(
        result,
        context,
        `Marked thread ${result.thread.id} active; T3 projected the lifecycle change.`,
      );
    }),
  );

addThreadOptions(threads.command("create"))
  .description("Create a new project thread and start its first turn.")
  .action((options: ThreadCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const prompt = await resolvePrompt(options);
      const result = await createHandoverThread(context.config, threadCreateOptions(options, prompt));
      writeSuccess(
        result,
        context,
        `${result.dryRun ? "Would create" : "Created"} thread ${result.thread.id} in ${result.project.title}.`,
      );
    }),
  );

addThreadOptions(program.command("handover"))
  .description("Resolve the current repo, ensure its project, and start a new T3 Code thread.")
  .action((options: ThreadCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const prompt = await resolvePrompt(options);
      const result = await createHandoverThread(context.config, threadCreateOptions(options, prompt));
      writeSuccess(
        result,
        context,
        `${result.dryRun ? "Would hand over to" : "Handed over to"} thread ${result.thread.id} in ${result.project.title}.`,
      );
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
