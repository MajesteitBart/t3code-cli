import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CliError } from "./errors.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 60_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      clearTimeout(timeout);
      reject(new CliError("PROCESS_START_FAILED", `Could not start ${command}.`, { cause }));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const exitCode = code ?? 1;
      if (timedOut) {
        reject(new CliError("PROCESS_TIMEOUT", `${command} timed out.`, { details: { command } }));
        return;
      }
      if (exitCode !== 0 && !options.allowFailure) {
        reject(
          new CliError("PROCESS_FAILED", `${command} exited with code ${exitCode}.`, {
            details: { command, exitCode, stderr: stderr.trim() },
          }),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = await runProcess(locator, [command], { allowFailure: true, timeoutMs: 5_000 }).catch(
    () => null,
  );
  return result?.exitCode === 0;
}

export interface T3Invocation {
  command: string;
  argsPrefix: string[];
  source: "configured" | "bundled" | "path" | "npx";
  version: string | null;
}

async function isFile(filePath: string): Promise<boolean> {
  return await access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function bundledT3Invocation(): Promise<T3Invocation | null> {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 6; index += 1) {
    const packageRoot = path.join(cursor, "node_modules", "t3");
    const binPath = path.join(packageRoot, "dist", "bin.mjs");
    if (await isFile(binPath)) {
      const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
        version?: unknown;
      };
      return {
        command: process.execPath,
        argsPrefix: [binPath],
        source: "bundled",
        version: typeof packageJson.version === "string" ? packageJson.version : null,
      };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

export async function resolveT3Invocation(configured?: readonly string[]): Promise<T3Invocation> {
  if (configured && configured.length > 0) {
    const [command, ...argsPrefix] = configured;
    if (!command) throw new CliError("INVALID_T3_COMMAND", "Configured t3Command is empty.");
    return { command, argsPrefix, source: "configured", version: null };
  }

  const bundled = await bundledT3Invocation();
  if (bundled) return bundled;

  if (await commandExists("t3")) {
    return { command: "t3", argsPrefix: [], source: "path", version: null };
  }

  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  if (await commandExists(npx)) {
    return { command: npx, argsPrefix: ["--yes", "t3@latest"], source: "npx", version: null };
  }

  throw new CliError(
    "T3_CLI_NOT_FOUND",
    "The upstream T3 CLI is unavailable. Reinstall t3code-cli or install `t3` on PATH.",
  );
}
