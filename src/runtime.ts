import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expandHome } from "./config.js";
import { CliError } from "./errors.js";
import { hasProtocolHandler, openExternal } from "./platformOpen.js";
import type { CliConfig, RuntimeState, T3Runtime } from "./types.js";

interface EnvironmentDescriptor {
  environmentId: string;
  serverVersion: string;
}

export function resolveT3Home(config: CliConfig): string {
  return path.resolve(expandHome(config.t3Home ?? process.env.T3CODE_HOME ?? path.join(os.homedir(), ".t3")));
}

async function readRuntimeState(filePath: string): Promise<RuntimeState | null> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<RuntimeState>;
    if (
      value.version !== 1 ||
      typeof value.pid !== "number" ||
      typeof value.port !== "number" ||
      typeof value.origin !== "string" ||
      typeof value.startedAt !== "string"
    ) {
      return null;
    }
    return value as RuntimeState;
  } catch {
    return null;
  }
}

async function fetchDescriptor(origin: string): Promise<EnvironmentDescriptor | null> {
  try {
    const response = await fetch(new URL("/.well-known/t3/environment", origin), {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return null;
    const value = (await response.json()) as Partial<EnvironmentDescriptor>;
    if (typeof value.environmentId !== "string" || typeof value.serverVersion !== "string") return null;
    return value as EnvironmentDescriptor;
  } catch {
    return null;
  }
}

interface RuntimeCandidate {
  origin: string;
  stateDir: string | null;
  runtimeStatePath: string | null;
  settingsPath: string | null;
}

async function runtimeCandidates(config: CliConfig): Promise<RuntimeCandidate[]> {
  const candidates: RuntimeCandidate[] = [];
  if (config.origin) {
    candidates.push({ origin: config.origin, stateDir: null, runtimeStatePath: null, settingsPath: null });
  }
  const home = resolveT3Home(config);
  for (const stateDirectoryName of ["userdata", "dev"]) {
    const stateDir = path.join(home, stateDirectoryName);
    const runtimeStatePath = path.join(stateDir, "server-runtime.json");
    const state = await readRuntimeState(runtimeStatePath);
    if (!state) continue;
    const candidate = {
      origin: state.origin,
      stateDir,
      runtimeStatePath,
      settingsPath: path.join(stateDir, "settings.json"),
    };
    const existingIndex = candidates.findIndex((existing) => existing.origin === state.origin);
    if (existingIndex >= 0) {
      // Keep the explicit origin's priority while retaining its matching local
      // installation paths so settings and projections remain discoverable.
      candidates[existingIndex] = candidate;
    } else {
      candidates.push(candidate);
    }
  }
  return candidates;
}

async function findRuntime(config: CliConfig): Promise<T3Runtime | null> {
  for (const candidate of await runtimeCandidates(config)) {
    const descriptor = await fetchDescriptor(candidate.origin);
    if (!descriptor) continue;
    return { ...candidate, ...descriptor };
  }
  return null;
}

async function startDesktopAndWait(config: CliConfig): Promise<T3Runtime | null> {
  if (!(await hasProtocolHandler("t3code"))) return null;
  await openExternal("t3code://app/");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const runtime = await findRuntime(config);
    if (runtime) return runtime;
  }
  return null;
}

export async function discoverRuntime(
  config: CliConfig,
  options: { startDesktopIfNeeded: boolean },
): Promise<T3Runtime> {
  const existing = await findRuntime(config);
  if (existing) return existing;

  const started = options.startDesktopIfNeeded ? await startDesktopAndWait(config) : null;
  if (started) return started;

  throw new CliError(
    "T3_SERVER_UNAVAILABLE",
    options.startDesktopIfNeeded
      ? "T3 Code did not expose its local server within 30 seconds. Start T3 Code and retry."
      : "No running T3 Code server was found. Start T3 Code and retry.",
    { details: { t3Home: resolveT3Home(config), origin: config.origin ?? null } },
  );
}
