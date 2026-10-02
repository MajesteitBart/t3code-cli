import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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

  it("rejects a turn count that is not a positive whole number", async () => {
    const result = await run(["--json", "threads", "read", "--thread", "thread-1", "--turns", "0"]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "INVALID_USAGE",
        message: "option '--turns <count>' argument '0' is invalid. Expected a positive whole number.",
      },
    });
  });

  it("rejects an unknown busy-thread mode", async () => {
    const result = await run(["--json", "threads", "send", "--thread", "thread-1", "--prompt", "x", "--if-busy", "queue"]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error).toEqual({
      code: "INVALID_USAGE",
      message: "option '--if-busy <mode>' argument 'queue' is invalid. Allowed choices are reject, inject.",
    });
  });

  it("rejects an unknown read detail", async () => {
    const result = await run(["--json", "threads", "read", "--thread", "thread-1", "--detail", "verbose"]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error).toEqual({
      code: "INVALID_USAGE",
      message: "option '--detail <level>' argument 'verbose' is invalid. Allowed choices are answers, messages, full.",
    });
  });

  it("rejects conflicting turn windows before contacting T3", async () => {
    const missingConfig = path.join(built.directory, "missing-config.json");
    const result = await run(["--json", "--config", missingConfig, "threads", "read", "--thread", "thread-1", "--last-turn", "--turns", "2"]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error).toEqual({
      code: "THREAD_FILTER_CONFLICT",
      message: "Use either --last-turn or --turns, not both.",
    });
  });

  it("rejects thread control requests that are incomplete before contacting T3", async () => {
    const missingConfig = path.join(built.directory, "missing-config.json");
    const offline = (args) => run(["--json", "--config", missingConfig, ...args]);

    const noSettings = await offline(["threads", "set", "--thread", "thread-1"]);
    expect(noSettings.code).toBe(2);
    expect(JSON.parse(noSettings.stderr).error.code).toBe("THREAD_SETTINGS_REQUIRED");

    const badOption = await offline(["threads", "set", "--thread", "thread-1", "--option", "contextWindow"]);
    expect(badOption.code).toBe(2);
    expect(JSON.parse(badOption.stderr).error).toEqual({
      code: "INVALID_MODEL_OPTION",
      message: "Write model options as id=value, not contextWindow.",
    });

    const noAnswer = await offline(["threads", "answer", "--thread", "thread-1"]);
    expect(noAnswer.code).toBe(2);
    expect(JSON.parse(noAnswer.stderr).error.code).toBe("ANSWER_REQUIRED");

    const badScope = await offline(["threads", "approve", "--thread", "thread-1", "--scope", "forever"]);
    expect(badScope.code).toBe(2);
    expect(JSON.parse(badScope.stderr).error.code).toBe("INVALID_USAGE");
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

describe("thread inspection against a T3 server", () => {
  it("describes a model whose options T3 stores as an object map", async () => {
    const thread = {
      id: "thread-1",
      projectId: "project-1",
      title: "Legacy options",
      archivedAt: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      modelSelection: { instanceId: "codex", model: "gpt-x", options: { reasoningEffort: "high" } },
      messages: [],
      activities: [],
    };
    const server = createServer((request, response) => {
      const send = (value) => response.end(JSON.stringify(value));
      if (request.url === "/.well-known/t3/environment") return send({ environmentId: "test", serverVersion: "test" });
      if (request.url?.startsWith("/api/orchestration/threads/thread-1")) return send({ snapshotSequence: 1, thread });
      if (request.url === "/api/orchestration/shell") return send({ snapshotSequence: 1, projects: [], threads: [thread] });
      response.statusCode = 404;
      response.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const authScript = path.join(built.directory, "inspect-auth.mjs");
    await writeFile(authScript, "if (process.argv.includes('issue')) console.log(JSON.stringify({ sessionId: 's', token: 't' }));\n");
    const config = path.join(built.directory, "inspect-config.json");
    await writeFile(config, JSON.stringify({
      origin: `http://127.0.0.1:${server.address().port}`,
      t3Home: built.directory,
      t3Command: [process.execPath, authScript],
    }));
    try {
      const result = await run(["--config", config, "threads", "inspect", "--thread", "thread-1"]);

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Model: codex/gpt-x (reasoningEffort=high)");
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
