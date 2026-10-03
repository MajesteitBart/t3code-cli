import { access } from "node:fs/promises";

import { commandExists, probeT3Version, resolveT3Invocation } from "./process.js";
import { hasProtocolHandler } from "./platformOpen.js";
import { discoverRuntime, resolveT3Home } from "./runtime.js";
import { ORCHESTRATION_PROTOCOL_VERSION, type CliConfig } from "./types.js";

export async function doctor(config: CliConfig, configPath: string, configExists: boolean) {
  const [git, desktopProtocol, exactThreadProtocol, t3HomeExists, runtime] = await Promise.all([
    commandExists("git"),
    hasProtocolHandler("t3code"),
    hasProtocolHandler("t3"),
    access(resolveT3Home(config))
      .then(() => true)
      .catch(() => false),
    discoverRuntime(config, { startDesktopIfNeeded: false, allowUnsupportedProtocol: true }).catch(() => null),
  ]);
  // The `t3` command must match the server's version, because sessions live in that version's database.
  const invocation = await resolveT3Invocation(config.t3Command, runtime?.serverVersion ?? null, runtime?.runtimeStatePath).catch(
    (error: unknown) => ({ error }),
  );

  // A configured command is used as given, so ask it for its version here.
  const version =
    "error" in invocation ? null : (invocation.version ?? (await probeT3Version(invocation)));
  const invocationResult =
    "error" in invocation
      ? { available: false, source: null, version: null, matchesServer: false }
      : {
          available: true,
          source: invocation.source,
          version,
          ...(invocation.installPath ? { installPath: invocation.installPath } : {}),
          // Null when either version is unknown; only a known mismatch fails the check.
          matchesServer: version === null || runtime === null ? null : version === runtime.serverVersion,
        };
  const protocol = runtime?.orchestrationProtocolVersion ?? null;
  const checks = {
    node: { ok: true, version: process.version },
    git: { ok: git },
    t3Cli: { ok: invocationResult.available && invocationResult.matchesServer !== false, ...invocationResult },
    t3Home: { ok: t3HomeExists, path: resolveT3Home(config) },
    t3Server: {
      ok: runtime !== null,
      origin: runtime?.origin ?? null,
      environmentId: runtime?.environmentId ?? null,
      version: runtime?.serverVersion ?? null,
    },
    orchestrationProtocol: {
      ok: protocol === ORCHESTRATION_PROTOCOL_VERSION,
      server: protocol,
      supported: ORCHESTRATION_PROTOCOL_VERSION,
      ...(runtime && protocol !== ORCHESTRATION_PROTOCOL_VERSION
        ? { hint: protocol === null || protocol < ORCHESTRATION_PROTOCOL_VERSION ? "Use @bvdm/t3code-cli@0.2 for this T3 build." : "Update @bvdm/t3code-cli." }
        : {}),
    },
    desktopProtocol: { ok: desktopProtocol, scheme: "t3code" },
    exactThreadProtocol: { ok: exactThreadProtocol, scheme: "t3" },
    config: { ok: true, path: configPath, exists: configExists },
  };

  return {
    ok: checks.git.ok && checks.t3Cli.ok && checks.t3Server.ok && checks.orchestrationProtocol.ok,
    checks,
  };
}
