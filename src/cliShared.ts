import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { stdin as input } from "node:process";

import { Command, InvalidArgumentError, Option } from "commander";

import { expandHome, loadConfig } from "./config.js";
import { CliError } from "./errors.js";
import { normalizeProviderOptions } from "./modelSelection.js";
import { writeError } from "./output.js";
import type { ThreadWaitOptions, ThreadWaitView } from "./threadSupport.js";
import { READ_DETAILS, renderPendingRequests, renderTranscript, type ReadDetail } from "./transcript.js";
import type { CliConfig, ModelSelection } from "./types.js";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

export const program = new Command();
export const jsonRequested = process.argv.slice(2).includes("--json");
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

export interface CommandContext {
  config: CliConfig;
  configPath: string;
  configExists: boolean;
  json: boolean;
}

export async function commandContext(): Promise<CommandContext> {
  const global = program.opts<GlobalOptions>();
  const loaded = await loadConfig(global.config);
  const config = { ...loaded.config };
  if (global.t3Home) config.t3Home = path.resolve(expandHome(global.t3Home));
  if (global.origin) config.origin = new URL(global.origin).origin;
  return { config, configPath: loaded.path, configExists: loaded.exists, json: global.json ?? false };
}

export async function action(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const global = program.opts<GlobalOptions>();
    const cliError = writeError(error, { json: global.json ?? false });
    process.exitCode = cliError.exitCode;
  }
}

export const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/u.test(value.trim()) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Expected a positive whole number.");
  }
  return parsed;
}

export interface PromptOptions {
  prompt?: string;
  promptFile?: string;
  stdin?: boolean;
}

async function readStdin(): Promise<string> {
  input.setEncoding("utf8");
  let value = "";
  for await (const chunk of input) value += chunk;
  return value;
}

export async function resolvePrompt(options: PromptOptions): Promise<string> {
  const sources = [options.prompt !== undefined, options.promptFile !== undefined, options.stdin === true].filter(Boolean);
  if (sources.length !== 1) {
    throw new CliError("PROMPT_SOURCE_REQUIRED", "Use exactly one of --prompt, --prompt-file, or --stdin.");
  }
  if (options.prompt !== undefined) return options.prompt;
  if (options.promptFile !== undefined) return await readFile(path.resolve(options.promptFile), "utf8");
  return await readStdin();
}

/** Adds --prompt, --prompt-file, and --stdin. */
export function addPromptOptions(command: Command, noun = "message"): Command {
  return command
    .option("--prompt <text>", `The ${noun} text.`)
    .option("--prompt-file <path>", `Read the ${noun} from a UTF-8 file.`)
    .option("--stdin", `Read the ${noun} from stdin.`);
}

export interface ThreadWaitCommandOptions {
  thread?: string;
  timeout?: number;
  detail?: ReadDetail;
  maxChars?: number;
}

/** Flags that control how long to wait for a turn and how much of it to print. */
export function addReplyOptions(command: Command): Command {
  return command
    .option("--timeout <seconds>", "Stop waiting after <seconds> (default 600).", positiveInteger)
    .addOption(new Option("--detail <level>", "Turn detail: answers, messages, or full (default answers).").choices(READ_DETAILS))
    .option("--max-chars <count>", "Clip each message and tool entry to <count> characters.", positiveInteger);
}

export function waitOptions(options: ThreadWaitCommandOptions): ThreadWaitOptions {
  return {
    timeoutMs: (options.timeout ?? DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000,
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
  };
}

export function renderWait(result: ThreadWaitView): string {
  const { wait } = result;
  const seconds = Math.round(wait.waitedMs / 1000);
  const headline =
    wait.error !== undefined
      ? `The turn failed (waited ${seconds}s): ${wait.error}`
      : wait.outcome === "needs-attention"
        ? `The thread is waiting for a person (waited ${seconds}s):\n${renderPendingRequests(result.pendingRequests) || "- a pending approval or question"}`
        : wait.outcome === "queue-held"
          ? "The message waits in a queue that T3 holds after a restart. Resume it with threads queue resume."
          : wait.outcome === "idle"
            ? "The thread has no turns yet."
            : `Turn ${wait.turnIndex} ${wait.outcome} (waited ${seconds}s); the thread is now ${wait.statusAfter}.`;
  const transcript = renderTranscript(result.reply);
  return transcript ? `${headline}\n\n${transcript}` : headline;
}

export function withReply(text: string, result: Partial<ThreadWaitView>): string {
  const { wait, pendingRequests, reply } = result;
  return wait && pendingRequests && reply ? `${text}\n${renderWait({ wait, pendingRequests, reply })}` : text;
}

export function describeSelection(selection: ModelSelection | null | undefined): string {
  if (!selection) return "unknown";
  const options = normalizeProviderOptions(selection.options)
    .map((option) => `${option.id}=${String(option.value)}`)
    .join(", ");
  return `${selection.instanceId}/${selection.model}${options ? ` (${options})` : ""}`;
}
