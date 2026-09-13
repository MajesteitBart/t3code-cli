import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | string | undefined;
}

async function runCli(args: string[]): Promise<CliResult> {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  let stdout = "";
  let stderr = "";

  process.argv = [process.execPath, "t3code", ...args];
  process.exitCode = undefined;
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += chunk.toString();
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += chunk.toString();
    return true;
  });

  vi.resetModules();
  try {
    await import("./cli.js");
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.sequential("CLI parsing", () => {
  it("writes a JSON usage envelope for a missing required option", async () => {
    const result = await runCli(["--json", "threads", "inspect"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "INVALID_USAGE",
        message: "required option '--thread <thread-id>' not specified",
      },
    });
  });

  it("requires an exact thread id for reads", async () => {
    const result = await runCli(["--json", "threads", "read"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "INVALID_USAGE",
        message: "required option '--thread <thread-id>' not specified",
      },
    });
  });

  it("writes a JSON usage envelope for an invalid choice", async () => {
    const result = await runCli(["--json", "threads", "list", "--status", "archived"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "INVALID_USAGE",
        message: "option '--status <status>' argument 'archived' is invalid. Allowed choices are active, settled, all.",
      },
    });
  });

  it("writes a JSON usage envelope for an unknown option", async () => {
    const result = await runCli(["--json", "threads", "inspect", "--thread", "thread-1", "--bogus"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "INVALID_USAGE",
        message: "unknown option '--bogus'",
      },
    });
  });

  it("keeps human-readable usage errors", async () => {
    const result = await runCli(["threads", "inspect"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("t3code: required option '--thread <thread-id>' not specified\n");
  });

  it("keeps help and version successful", async () => {
    const help = await runCli(["--help"]);
    const version = await runCli(["--version"]);

    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage: t3code [options] [command]");
    expect(version).toEqual({ stdout: "0.1.2\n", stderr: "", exitCode: 0 });
  });

  it("leaves action-level JSON errors unchanged", async () => {
    const missingConfig = path.join(os.tmpdir(), "t3code-cli-cli-test-missing.json");
    const result = await runCli(["--json", "--config", missingConfig, "handover"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "PROMPT_SOURCE_REQUIRED",
        message: "Use exactly one of --prompt, --prompt-file, or --stdin.",
      },
    });
  });
});
