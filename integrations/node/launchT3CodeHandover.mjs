import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const OPEN_MODES = new Set(["auto", "desktop", "browser", "none"]);
const SPEED_MODES = new Set(["standard", "fast"]);
const PERMISSION_MODES = new Set([
  "approval-required",
  "auto-accept-edits",
  "full-access",
]);
const INTERACTION_MODES = new Set(["build", "default", "plan"]);
const CHECKOUT_MODES = new Set(["current", "local", "t3", "worktree"]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalChoice(value, choices, name) {
  if (value === undefined) return undefined;
  if (!choices.has(value)) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function optionalString(value, name) {
  return value === undefined ? undefined : requiredString(value, name);
}

/**
 * Build the stable t3code argument array. The prompt is intentionally absent;
 * callers must send it over stdin.
 */
export function buildT3CodeHandoverArgs(options) {
  const cwd = path.resolve(requiredString(options.cwd, "cwd"));
  const open = optionalChoice(options.open ?? "auto", OPEN_MODES, "open");
  const args = ["--json", "handover", "--cwd", cwd, "--stdin", "--open", open];
  const values = [
    ["--provider", optionalString(options.provider, "provider")],
    ["--model", optionalString(options.model, "model")],
    ["--speed", optionalChoice(options.speed, SPEED_MODES, "speed")],
    ["--thinking-effort", optionalString(options.thinkingEffort, "thinkingEffort")],
    ["--permission", optionalChoice(options.permission, PERMISSION_MODES, "permission")],
    ["--mode", optionalChoice(options.mode, INTERACTION_MODES, "mode")],
    ["--checkout", optionalChoice(options.checkout, CHECKOUT_MODES, "checkout")],
  ];
  for (const [flag, value] of values) {
    if (value !== undefined) args.push(flag, value);
  }
  return args;
}

/** Resolve a command without constructing an executable shell string. */
export function resolveT3CodeInvocation(command = "t3code") {
  if (Array.isArray(command)) {
    if (command.length === 0) throw new TypeError("command must not be empty.");
    const [executable, ...argsPrefix] = command.map((value) => requiredString(value, "command argument"));
    return { executable, argsPrefix };
  }

  const requested = requiredString(command, "command");
  const hasPath = path.isAbsolute(requested) || requested.includes("/") || requested.includes("\\");
  const candidates = hasPath
    ? [requested]
    : String(
        spawnSync(process.platform === "win32" ? "where.exe" : "which", [requested], {
          encoding: "utf8",
        }).stdout ?? "",
      )
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean);
  if (candidates.length === 0) {
    throw new Error("T3 Code CLI `t3code` was not found on PATH.");
  }

  const selected = process.platform === "win32"
    ? candidates.find((value) => /\.exe$/iu.test(value))
      ?? candidates.find((value) => /\.cmd$/iu.test(value))
      ?? candidates[0]
    : candidates.find((value) => !/\.cmd$/iu.test(value)) ?? candidates[0];
  if (!selected) throw new Error("T3 Code CLI `t3code` was not found on PATH.");
  if (process.platform === "win32" && /\.cmd$/iu.test(selected)) {
    return { executable: "cmd.exe", argsPrefix: ["/d", "/s", "/c", selected] };
  }
  return { executable: selected, argsPrefix: [] };
}

/**
 * Launch a T3 Code handover from a trusted Node backend.
 *
 * `cwd` must be selected by the server, not accepted blindly from a browser.
 */
export async function launchT3CodeHandover(options) {
  const cwd = path.resolve(requiredString(options.cwd, "cwd"));
  const prompt = requiredString(options.prompt, "prompt");
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive.");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new TypeError("maxOutputBytes must be positive.");
  }

  const invocation = resolveT3CodeInvocation(options.command);
  const args = [...invocation.argsPrefix, ...buildT3CodeHandoverArgs({ ...options, cwd })];
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const append = (stream, chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        child.kill();
        finish(new Error(`T3 Code CLI output exceeded ${maxOutputBytes} bytes.`));
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`T3 Code handover timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => finish(new Error(`Failed to start T3 Code CLI: ${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      let payload;
      try {
        payload = JSON.parse(code === 0 ? stdout : stderr || stdout);
      } catch {
        const detail = String(stderr || stdout || `exit code ${code}`).trim().slice(0, 1_000);
        finish(new Error(`T3 Code CLI returned invalid JSON: ${detail}`));
        return;
      }
      if (code !== 0 || payload?.ok !== true) {
        finish(new Error(payload?.error?.message ?? `T3 Code CLI exited with code ${code}.`));
        return;
      }
      finish(null, payload);
    });
    child.stdin.end(prompt);
  });
}
