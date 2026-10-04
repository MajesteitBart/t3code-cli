import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  // `where.exe` searches the current folder before PATH, which can outlast the timeout in a large folder.
  const [locator, pattern] = process.platform === "win32" ? ["where.exe", `$PATH:${command}`] : ["which", command];
  const result = await runProcess(locator, [pattern], { allowFailure: true, timeoutMs: 5_000 }).catch(
    () => null,
  );
  return result?.exitCode === 0;
}

/** How the CLI runs the upstream `t3` command, which issues and revokes its T3 sessions. */
export interface T3Invocation {
  command: string;
  argsPrefix: string[];
  /** Extra environment, such as the Electron switch that runs the desktop app as Node. */
  env?: Record<string, string>;
  source: "configured" | "server" | "desktop" | "path" | "npx";
  version: string | null;
  /** The installed desktop app whose bundled server this invocation runs. */
  installPath?: string;
}

async function exists(filePath: string): Promise<boolean> {
  return await access(filePath)
    .then(() => true)
    .catch(() => false);
}

interface DesktopInstall {
  executable: string;
  entry: string;
  installPath: string;
}

async function directoryEntries(directory: string): Promise<string[]> {
  return await readdir(directory).catch(() => []);
}

/**
 * The T3 Code desktop apps installed on this machine. Each one ships the server that also serves the
 * upstream `t3` command, which the app's own executable runs as Node: on Windows from the
 * `resources/server.asar` sidecar, on macOS and Linux from the app archive.
 */
export async function findDesktopInstalls(): Promise<DesktopInstall[]> {
  const installs: DesktopInstall[] = [];
  if (process.platform === "win32") {
    const roots = [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null,
      process.env.ProgramFiles ?? null,
      process.env["ProgramFiles(x86)"] ?? null,
    ].filter((root): root is string => root !== null);
    for (const root of roots) {
      for (const name of await directoryEntries(root)) {
        const installPath = path.join(root, name);
        const archive = path.join(installPath, "resources", "server.asar");
        if (!(await exists(archive))) continue;
        const executable = (await directoryEntries(installPath)).find(
          (file) => /^T3 Code.*\.exe$/iu.test(file) && !/^Uninstall/iu.test(file),
        );
        if (!executable) continue;
        installs.push({
          executable: path.join(installPath, executable),
          entry: path.join(archive, "apps", "server", "dist", "bin.mjs"),
          installPath,
        });
      }
    }
    return installs;
  }
  if (process.platform === "darwin") {
    for (const root of ["/Applications", path.join(os.homedir(), "Applications")]) {
      for (const name of await directoryEntries(root)) {
        if (!/^T3 Code.*\.app$/u.test(name)) continue;
        const installPath = path.join(root, name);
        const archive = path.join(installPath, "Contents", "Resources", "app.asar");
        const executable = path.join(installPath, "Contents", "MacOS", name.replace(/\.app$/u, ""));
        if (!(await exists(archive)) || !(await exists(executable))) continue;
        installs.push({ executable, entry: path.join(archive, "apps", "server", "dist", "bin.mjs"), installPath });
      }
    }
    return installs;
  }
  for (const name of await directoryEntries("/opt")) {
    if (!/^T3 Code/u.test(name)) continue;
    const installPath = path.join("/opt", name);
    const archive = path.join(installPath, "resources", "app.asar");
    const executable = path.join(installPath, "t3code");
    if (!(await exists(archive)) || !(await exists(executable))) continue;
    installs.push({ executable, entry: path.join(archive, "apps", "server", "dist", "bin.mjs"), installPath });
  }
  return installs;
}

const ELECTRON_AS_NODE = { ELECTRON_RUN_AS_NODE: "1" };

function parseVersion(output: string | undefined): string | null {
  return output?.match(/v?(\d+\.\d+\.\d+[\w.+-]*)/u)?.[1] ?? null;
}

/** Asks a `t3` command for its version; null when it does not answer with one. */
export async function probeT3Version(invocation: Pick<T3Invocation, "command" | "argsPrefix" | "env">): Promise<string | null> {
  const result = await runProcess(invocation.command, [...invocation.argsPrefix, "--version"], {
    ...(invocation.env ? { env: { ...process.env, ...invocation.env } } : {}),
    allowFailure: true,
    timeoutMs: 20_000,
  }).catch(() => null);
  return parseVersion(result?.stdout);
}

/** The first match on PATH, as a full path. */
async function findOnPath(name: string): Promise<string | null> {
  const [locator, pattern] = process.platform === "win32" ? ["where.exe", `$PATH:${name}`] : ["which", name];
  const result = await runProcess(locator, [pattern], { allowFailure: true, timeoutMs: 5_000 }).catch(() => null);
  if (result?.exitCode !== 0) return null;
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) ?? null;
}

function versionCachePath(): string {
  const root =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? process.env.LOCALAPPDATA
      : process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(root, "t3code-cli", "t3-versions.json");
}

type VersionCache = Record<string, { mtimeMs: number; version: string | null }>;

/**
 * Asks each installed app's `t3` for its version. Starting one takes about half a second, so answers
 * are cached until the executable changes, which an update does. The probes run in parallel and the
 * cache is written once afterwards, so no answer overwrites another.
 */
async function desktopVersions(installs: readonly DesktopInstall[]): Promise<Array<{ install: DesktopInstall; version: string | null }>> {
  const cacheFile = versionCachePath();
  const cache = (await readFile(cacheFile, "utf8")
    .then((raw) => JSON.parse(raw) as VersionCache)
    .catch(() => ({}))) as VersionCache;
  let changed = false;
  const versions = await Promise.all(
    installs.map(async (install) => {
      const mtimeMs = await stat(install.executable)
        .then((info) => info.mtimeMs)
        .catch(() => null);
      const cached = cache[install.executable];
      if (mtimeMs !== null && cached?.mtimeMs === mtimeMs) return { install, version: cached.version };
      const version = await probeT3Version({ command: install.executable, argsPrefix: [install.entry], env: ELECTRON_AS_NODE });
      if (mtimeMs !== null) {
        cache[install.executable] = { mtimeMs, version };
        changed = true;
      }
      return { install, version };
    }),
  );
  if (changed) {
    await mkdir(path.dirname(cacheFile), { recursive: true })
      .then(() => writeFile(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8"))
      .catch(() => undefined);
  }
  return versions;
}

function desktopInvocation(install: DesktopInstall, version: string | null): T3Invocation {
  return {
    command: install.executable,
    argsPrefix: [install.entry],
    env: ELECTRON_AS_NODE,
    source: "desktop",
    version,
    installPath: install.installPath,
  };
}

const SERVER_ENTRY = /(?:^|[\\/])apps[\\/]server[\\/]dist[\\/]bin\.mjs$/u;

/**
 * On Linux, the running server's own executable, read from /proc. It is the server, so its version
 * matches by definition. This covers AppImages, which live anywhere, and a standalone `t3 serve`.
 */
export async function serverProcessInvocation(
  runtimeStatePath: string | null | undefined,
  serverVersion: string | null | undefined,
): Promise<T3Invocation | null> {
  if (process.platform !== "linux" || !runtimeStatePath) return null;
  const state = await readFile(runtimeStatePath, "utf8")
    .then((raw) => JSON.parse(raw) as { pid?: unknown })
    .catch(() => null);
  const pid = typeof state?.pid === "number" && Number.isSafeInteger(state.pid) ? state.pid : null;
  if (pid === null) return null;
  const [executable, cmdline] = await Promise.all([
    readlink(`/proc/${pid}/exe`).catch(() => null),
    readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => null),
  ]);
  if (!executable || !cmdline) return null;
  const version = serverVersion ?? null;
  // The desktop app runs the server as `<electron> ... apps/server/dist/bin.mjs`; Node runs it the same way.
  const arg = cmdline.split("\0").find((value) => SERVER_ENTRY.test(value));
  if (arg) {
    // cmdline keeps the path as the server was given it, so a relative entry is relative to the
    // server's working directory, not ours. Without that directory, leave it to the other routes.
    const entry = path.isAbsolute(arg)
      ? arg
      : await readlink(`/proc/${pid}/cwd`).then((cwd) => path.resolve(cwd, arg)).catch(() => null);
    if (!entry) return null;
    return { command: executable, argsPrefix: [entry], env: ELECTRON_AS_NODE, source: "server", version };
  }
  // A standalone server is the self-contained `t3` executable itself.
  if (/^t3$/u.test(path.basename(executable))) return { command: executable, argsPrefix: [], source: "server", version };
  return null;
}

/**
 * Finds the `t3` command whose version matches the running server, because a session only works when
 * `t3` writes it to the database that server reads. Order: a configured command, the running server's
 * own executable (Linux), the installed desktop app that matches the server, `t3` on PATH, then `npx`
 * pinned to the server's exact version.
 */
export async function resolveT3Invocation(
  configured?: readonly string[],
  serverVersion?: string | null,
  runtimeStatePath?: string | null,
): Promise<T3Invocation> {
  if (configured && configured.length > 0) {
    const [command, ...argsPrefix] = configured;
    if (!command) throw new CliError("INVALID_T3_COMMAND", "Configured t3Command is empty.");
    return { command, argsPrefix, source: "configured", version: null };
  }

  const running = await serverProcessInvocation(runtimeStatePath, serverVersion);
  if (running) return running;

  const installs = await findDesktopInstalls();
  if (installs.length > 0) {
    const versions = await desktopVersions(installs);
    const match = serverVersion ? versions.find((candidate) => candidate.version === serverVersion) : undefined;
    if (match) return desktopInvocation(match.install, match.version);
    if (!serverVersion) return desktopInvocation(versions[0]!.install, versions[0]!.version);
  }

  // On Windows only an executable qualifies: Node cannot start npm's `t3.cmd` shims without a shell.
  const onPath = await findOnPath(process.platform === "win32" ? "t3.exe" : "t3");
  if (onPath) {
    const version = await probeT3Version({ command: onPath, argsPrefix: [] });
    // A `t3` of another version would write the session to a database this server does not read.
    if (!serverVersion || version === serverVersion) return { command: onPath, argsPrefix: [], source: "path", version };
  }

  const spec = serverVersion ? `t3@${serverVersion}` : "t3@latest";
  // Node refuses to spawn Windows batch files such as npx.cmd without a shell, so run npm's own script.
  const npxScript = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (process.platform === "win32" && (await exists(npxScript))) {
    return { command: process.execPath, argsPrefix: [npxScript, "--yes", spec], source: "npx", version: serverVersion ?? null };
  }
  if (process.platform !== "win32" && (await commandExists("npx"))) {
    return { command: "npx", argsPrefix: ["--yes", spec], source: "npx", version: serverVersion ?? null };
  }

  throw new CliError(
    "T3_CLI_NOT_FOUND",
    "Found no `t3` command for this T3 server. Install T3 Code, put `t3` on PATH, or set t3Command.",
    { details: { serverVersion: serverVersion ?? null } },
  );
}
