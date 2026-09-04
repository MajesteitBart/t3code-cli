#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stderr as errorOutput } from "node:process";
import { createInterface } from "node:readline/promises";

import { Command, CommanderError, Option } from "commander";
import packageMetadata from "../package.json" with { type: "json" };

import {
  CONFIG_KEYS,
  expandHome,
  loadConfig,
  saveConfig,
  setConfigValue,
  type ConfigKey,
} from "./config.js";
import { doctor } from "./doctor.js";
import { CliError } from "./errors.js";
import { writeError, writeSuccess } from "./output.js";
import {
  createHandoverThread,
  ensureProject,
  inspectThread,
  listProjects,
  listThreads,
  rawGet,
  resolveProject,
  sendThreadMessage,
  settleThread,
  type ThreadCreateOptions,
  type ThreadListStatus,
  unsettleThread,
} from "./service.js";
import type {
  CliConfig,
  InteractionMode,
  OpenMode,
  ProjectPolicy,
  RuntimeMode,
  SpeedMode,
  ThreadEnvMode,
  T3Project,
  T3Thread,
  WorkspaceMode,
} from "./types.js";

const program = new Command();
const jsonRequested = process.argv.slice(2).includes("--json");
program
  .name("t3code")
  .description("Manage T3 Code projects, handover threads, and cross-thread messages.")
  .version(packageMetadata.version)
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

interface ThreadSendCommandOptions extends PromptOptions {
  thread: string;
  wakeSettled?: boolean;
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
      const latestTurn = result.thread.latestTurn;
      writeSuccess(
        result,
        context,
        [
          `Thread: ${result.thread.id}`,
          `Title: ${result.thread.title}`,
          `Project: ${result.project?.title ?? result.thread.projectId}`,
          `Status: ${result.thread.status}`,
          `Model: ${result.thread.modelSelection?.instanceId ?? "unknown"}/${result.thread.modelSelection?.model ?? "unknown"}`,
          `Session: ${result.thread.session?.status ?? "none"}`,
          `Latest turn: ${latestTurn ? `${latestTurn.state} (${latestTurn.turnId})` : "none"}`,
          `Updated: ${result.thread.updatedAt ?? "unknown"}`,
        ].join("\n"),
      );
    }),
  );

threads
  .command("send")
  .description("Start a new turn on an existing thread.")
  .requiredOption("--thread <thread-id>", "Exact T3 thread id.")
  .option("--prompt <text>", "Message text.")
  .option("--prompt-file <path>", "Read the message from a UTF-8 file.")
  .option("--stdin", "Read the message from stdin.")
  .option("--wake-settled", "Explicitly allow this message to wake a settled thread.")
  .action((options: ThreadSendCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const prompt = await resolvePrompt(options);
      const result = await sendThreadMessage(context.config, {
        threadId: options.thread,
        prompt,
        ...(options.wakeSettled ? { wakeSettled: true } : {}),
        ...(!context.json && !options.stdin ? { confirmSettled: confirmSettledThread } : {}),
      });
      writeSuccess(
        result,
        context,
        `Sent message ${result.message.messageId} to thread ${result.thread.id}; T3 accepted and projected the turn.`,
      );
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
  .command("request")
  .description("Raw read-only HTTP escape hatch.")
  .command("get")
  .argument("<path>", "Absolute T3 API path, starting with one slash.")
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
process.exitCode ??= 0;
