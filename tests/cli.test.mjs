import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCli, runBuiltCli } from "./helpers/built-cli.mjs";

let built;
beforeAll(async () => {
  built = await buildCli(".cli-test-");
}, 20_000);
afterAll(async () => { await built?.remove(); });

const run = (args) => runBuiltCli(built.cli, args);

describe("CLI parsing", () => {
  it("writes a JSON usage envelope for a missing required option", async () => {
    const result = await run(["--json", "threads", "inspect"]);

    expect(result.code).toBe(2);
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
    const result = await run(["--json", "threads", "read"]);

    expect(result.code).toBe(2);
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
    const result = await run(["--json", "threads", "list", "--status", "archived"]);

    expect(result.code).toBe(2);
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
    const result = await run(["--json", "threads", "inspect", "--thread", "thread-1", "--bogus"]);

    expect(result.code).toBe(2);
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
    const result = await run(["threads", "inspect"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("t3code: required option '--thread <thread-id>' not specified\n");
  });

  it("keeps help and version successful", async () => {
    const { version } = JSON.parse(await readFile("package.json", "utf8"));
    const help = await run(["--help"]);
    const printed = await run(["--version"]);

    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage: t3code [options] [command]");
    expect(printed).toEqual({ stdout: `${version}\n`, stderr: "", code: 0 });
  });

  it("leaves action-level JSON errors unchanged", async () => {
    const missingConfig = path.join(built.directory, "missing-config.json");
    const result = await run(["--json", "--config", missingConfig, "handover"]);

    expect(result.code).toBe(1);
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
