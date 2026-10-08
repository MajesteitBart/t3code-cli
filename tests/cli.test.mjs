import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startFakeT3 } from "../src/testing/fakeT3.ts";
import { runProcess } from "../src/process.ts";
import { buildCli, runBuiltCli } from "./helpers/built-cli.mjs";

let built;
beforeAll(async () => {
  built = await buildCli(".cli-test-");
}, 20_000);
afterAll(async () => { await built?.remove(); });

const run = (args) => runBuiltCli(built.cli, args);

describe("CLI parsing", () => {
  it("routes babysit help to the packaged helper without connecting to T3", async () => {
    const result = await run(["babysit", "--help"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.commands).toHaveProperty("tick");
    expect(result.stderr).toBe("");
  });
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
    const result = await run(["--json", "threads", "send", "--thread", "thread-1", "--prompt", "x", "--if-busy", "wait"]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error).toEqual({
      code: "INVALID_USAGE",
      message: "option '--if-busy <mode>' argument 'wait' is invalid. Allowed choices are refuse, queue, steer, restart, reject, inject.",
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

describe("built CLI against an orchestration V2 server", () => {
  const fakes = [];
  afterEach(async () => {
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  });

  /** Starts the fake server and writes a config file that points the CLI at it. */
  async function serve(options = {}) {
    const fake = await startFakeT3({ gitRepo: false, ...options });
    fakes.push(fake);
    fake.addProject({ id: "project-1", title: "Project One" });
    const config = path.join(fake.root, "cli-config.json");
    await writeFile(config, JSON.stringify(fake.config));
    return { fake, config };
  }

  // Environment overrides would point the CLI somewhere else.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("T3CODE")));
  const runAgainst = (config, args) => runBuiltCli(built.cli, ["--config", config, ...args], { env });

  it("reads a thread as a JSON envelope", async () => {
    const { fake, config } = await serve();
    const { thread } = fake.addThread({ turns: 2 });

    const result = await runAgainst(config, ["--json", "threads", "read", "--thread", thread.id, "--detail", "answers", "--last-turn"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.project).toMatchObject({ id: "project-1" });
    expect(envelope.data.thread.view).toMatchObject({ detail: "answers", totalTurns: 2, returnedTurns: 1 });
    expect(envelope.data.thread.messages.map((message) => message.text)).toEqual(["Prompt 2", "Reply to: Prompt 2"]);
    expect(result.stdout).not.toContain("mock-token");
    const orchestration = fake.httpRequests.filter((request) => request.url.startsWith("/api/orchestration/"));
    expect(orchestration.length).toBeGreaterThan(0);
    expect(orchestration.every((request) => request.protocolHeader === "2")).toBe(true);
  });

  it("inspects a thread for people, including a model whose options T3 stores as an object map", async () => {
    const { fake, config } = await serve({ runBehavior: "hold" });
    const { thread } = fake.addThread({
      title: "Legacy options",
      modelSelection: { instanceId: "codex", model: "gpt-x", options: { reasoningEffort: "high" } },
    });
    const running = fake.startRun(thread.id, "Working");
    fake.startRun(thread.id, "Next", { status: "queued" });
    const approval = fake.addApproval(thread.id, running.id, { prompt: "git push" });

    const result = await runAgainst(config, ["threads", "inspect", "--thread", thread.id]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Title: Legacy options");
    expect(result.stdout).toContain("Project: Project One");
    expect(result.stdout).toContain("Model: codex/gpt-x (reasoningEffort=high)");
    expect(result.stdout).toContain(`Running turn: running (${running.id})`);
    expect(result.stdout).toContain("Queue: 1 message");
    expect(result.stdout).toContain("Waiting for: approval");
    expect(result.stdout).toContain(`- Approval [${approval.id}]: git push`);
  });

  it("queues a message behind a running turn", async () => {
    const { fake, config } = await serve({ runBehavior: "hold" });
    const { thread } = fake.addThread();
    fake.startRun(thread.id, "Working");

    const refused = await runAgainst(config, ["--json", "threads", "send", "--thread", thread.id, "--prompt", "Also this"]);
    const queued = await runAgainst(config, ["threads", "send", "--thread", thread.id, "--prompt", "Also this", "--if-busy", "queue"]);

    expect(refused.code).toBe(4);
    expect(JSON.parse(refused.stderr).error).toMatchObject({ code: "THREAD_BUSY", details: { runRunning: true, queuedRuns: 0 } });
    expect(queued.stderr).toBe("");
    expect(queued.code).toBe(0);
    expect(queued.stdout).toMatch(/^Sent message [0-9a-f-]{36} to thread \S+; it waits in the queue\.\n$/u);
    expect(fake.commands).toEqual([
      expect.objectContaining({ type: "message.dispatch", threadId: thread.id, text: "Also this", dispatchMode: { type: "queue_after_active" } }),
    ]);
    expect(fake.projection(thread.id).runs.map((run) => run.status)).toEqual(["running", "queued"]);
  });

  it("refuses an orchestrator V1 server with exit code 4", async () => {
    const { fake, config } = await serve({ protocol: 1, serverVersion: "0.0.45" });

    const result = await runAgainst(config, ["--json", "threads", "list"]);

    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "T3_PROTOCOL_UNSUPPORTED", details: { orchestrationProtocolVersion: 1 } });
    expect(fake.httpRequests.map((request) => request.url)).toEqual(["/.well-known/t3/environment"]);
  });

  it("delivers stdin once with a retry key and refuses conflicting options", async () => {
    const { fake, config } = await serve();
    const { thread } = fake.addThread();
    const args = [built.cli, "--config", config, "--json", "threads", "send", "--thread", thread.id,
      "--stdin", "--if-busy", "queue", "--idempotency-key", "evt_cli", "--no-start-desktop"];
    const first = await runProcess(process.execPath, args, { input: "Exact wake message\n", env });
    const retry = await runProcess(process.execPath, args, { input: "Exact wake message\n", env });
    expect(JSON.parse(first.stdout).data.verification.accepted).toBe(true);
    expect(JSON.parse(retry.stdout).data.idempotency.deduplicated).toBe("projection");
    expect(fake.commands.filter((command) => command.type === "message.dispatch")).toHaveLength(1);
    expect(fake.commands.find((command) => command.type === "message.dispatch").text).toBe("Exact wake message\n");
    const refused = await runAgainst(config, ["--json", "threads", "send", "--thread", thread.id,
      "--prompt", "Wake", "--idempotency-key", "evt_bad", "--if-busy", "restart"]);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr).error.code).toBe("IDEMPOTENCY_KEY_UNSUPPORTED_OPTIONS");
  });
});
