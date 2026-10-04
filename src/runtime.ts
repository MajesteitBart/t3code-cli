import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expandHome } from "./config.js";
import { CliError } from "./errors.js";
import { readResponseText, withHttpResponse } from "./http.js";
import { hasProtocolHandler, openExternal } from "./platformOpen.js";
import { ORCHESTRATION_PROTOCOL_VERSION, type CliConfig, type RuntimeState, type T3Runtime } from "./types.js";

interface EnvironmentDescriptor {
  environmentId: string;
  serverVersion: string;
  orchestrationProtocolVersion: number | null;
  capabilities: {
    threadSettlement?: boolean;
    [key: string]: unknown;
  };
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
    // Node's own HTTP client: global fetch leaves a handle that crashes Node 26 at exit after two discoveries.
    const { status, text } = await withHttpResponse(
      new URL("/.well-known/t3/environment", origin),
      { method: "GET", signal: AbortSignal.timeout(2_500) },
      undefined,
      async (response) => ({ status: response.statusCode ?? 0, text: await readResponseText(response) }),
    );
    if (status < 200 || status >= 300) return null;
    const value = JSON.parse(text) as Partial<EnvironmentDescriptor>;
    if (typeof value.environmentId !== "string" || typeof value.serverVersion !== "string") return null;
    const capabilities =
      value.capabilities !== null &&
      typeof value.capabilities === "object" &&
      !Array.isArray(value.capabilities)
        ? value.capabilities
        : {};
    const protocol = (value as { orchestrationProtocolVersion?: unknown }).orchestrationProtocolVersion;
    return {
      environmentId: value.environmentId,
      serverVersion: value.serverVersion,
      orchestrationProtocolVersion: typeof protocol === "number" ? protocol : null,
      capabilities,
    };
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

/**
 * This CLI speaks orchestration protocol 2, which T3 introduced with orchestrator V2. Older servers
 * reject every V2 request, so refuse them up front and name the CLI version that still speaks to them.
 */
export function requireSupportedProtocol(runtime: T3Runtime): T3Runtime {
  if (runtime.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) return runtime;
  throw new CliError(
    "T3_PROTOCOL_UNSUPPORTED",
    runtime.orchestrationProtocolVersion === null || runtime.orchestrationProtocolVersion < ORCHESTRATION_PROTOCOL_VERSION
      ? `T3 ${runtime.serverVersion} runs orchestrator V1. This CLI needs orchestrator V2; use @bvdm/t3code-cli@0.2 for this T3 build.`
      : `T3 ${runtime.serverVersion} speaks orchestration protocol ${runtime.orchestrationProtocolVersion}, which this CLI does not know yet. Update @bvdm/t3code-cli.`,
    {
      exitCode: 4,
      details: {
        serverVersion: runtime.serverVersion,
        orchestrationProtocolVersion: runtime.orchestrationProtocolVersion,
        supportedProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      },
    },
  );
}

export async function discoverRuntime(
  config: CliConfig,
  options: { startDesktopIfNeeded: boolean; allowUnsupportedProtocol?: boolean },
): Promise<T3Runtime> {
  const check = (runtime: T3Runtime) => (options.allowUnsupportedProtocol ? runtime : requireSupportedProtocol(runtime));
  const existing = await findRuntime(config);
  if (existing) return check(existing);

  const started = options.startDesktopIfNeeded ? await startDesktopAndWait(config) : null;
  if (started) return check(started);

  throw new CliError(
    "T3_SERVER_UNAVAILABLE",
    options.startDesktopIfNeeded
      ? "T3 Code did not expose its local server within 30 seconds. Start T3 Code and retry."
      : "No running T3 Code server was found. Start T3 Code and retry.",
    { details: { t3Home: resolveT3Home(config), origin: config.origin ?? null } },
  );
}
