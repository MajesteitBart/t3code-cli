import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "./config.js";
import { CliError } from "./errors.js";
import { runProcess } from "./process.js";
import { createHandoverThread } from "./service.js";
import type { CliConfig, T3Project, T3Thread } from "./types.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk;
  return JSON.parse(body) as unknown;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function testHarness(
  initialProjects: T3Project[] = [],
  options: {
    failTurn?: boolean;
    serverVersion?: string;
    settings?: Record<string, unknown>;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-service-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await runProcess("git", ["init", "-b", "main"], { cwd: root });

  const mockT3 = path.join(root, "mock-t3.mjs");
  await writeFile(
    mockT3,
    `const args = process.argv.slice(2);\nif (args.includes("issue")) process.stdout.write(JSON.stringify({sessionId:"mock-session",token:"mock-token"}));\n`,
    "utf8",
  );

  const projects = [...initialProjects];
  const threads: T3Thread[] = [];
  const commands: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/.well-known/t3/environment") {
      json(response, 200, {
        environmentId: "environment-1",
        serverVersion: options.serverVersion ?? "0.0.34-nightly.20260818.1124",
      });
      return;
    }
    if (request.headers.authorization !== "Bearer mock-token") {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && request.url === "/api/orchestration/shell") {
      json(response, 200, {
        snapshotSequence: commands.length,
        projects,
        threads,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/orchestration/dispatch") {
      const command = (await bodyOf(request)) as Record<string, unknown>;
      commands.push(command);
      if (command.type === "project.create") {
        projects.push({
          id: command.projectId as string,
          title: command.title as string,
          workspaceRoot: command.workspaceRoot as string,
          defaultModelSelection: command.defaultModelSelection as T3Project["defaultModelSelection"],
          deletedAt: null,
        });
      }
      if (command.type === "thread.create") {
        threads.push({
          id: command.threadId as string,
          projectId: command.projectId as string,
          title: command.title as string,
          archivedAt: null,
        });
      }
      if (command.type === "thread.turn.start") {
        const bootstrap = command.bootstrap as
          | { createThread?: Record<string, unknown> }
          | undefined;
        const createThread = bootstrap?.createThread;
        if (createThread) {
          threads.push({
            id: command.threadId as string,
            projectId: createThread.projectId as string,
            title: createThread.title as string,
            archivedAt: null,
          });
        }
      }
      if (command.type === "thread.delete") {
        const index = threads.findIndex((thread) => thread.id === command.threadId);
        if (index >= 0) threads.splice(index, 1);
      }
      if (command.type === "thread.turn.start" && options.failTurn) {
        const index = threads.findIndex((thread) => thread.id === command.threadId);
        if (index >= 0) threads.splice(index, 1);
        json(response, 500, { error: "turn failed" });
        return;
      }
      json(response, 200, { sequence: commands.length });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");

  const origin = `http://127.0.0.1:${address.port}`;
  const stateDir = path.join(root, ".t3", "userdata");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "server-runtime.json"),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port: address.port,
      origin,
      startedAt: new Date().toISOString(),
    }),
    "utf8",
  );
  if (options.settings) {
    await writeFile(path.join(stateDir, "settings.json"), JSON.stringify(options.settings), "utf8");
  }

  const config: CliConfig = {
    ...DEFAULT_CONFIG,
    origin,
    t3Home: path.join(root, ".t3"),
    t3Command: [process.execPath, mockT3],
    openMode: "none",
    threadEnvMode: "local",
  };
  return { root, config, projects, threads, commands };
}

describe("createHandoverThread", () => {
  it("creates a missing project, thread, and first turn", async () => {
    const harness = await testHarness();

    const result = await createHandoverThread(harness.config, {
      cwd: harness.root,
      prompt: "Continue the implementation from this handover.",
      openMode: "none",
    });

    expect(result.projectCreated).toBe(true);
    expect(result.workspace.workspaceRoot).toBe(await realpath(harness.root));
    expect(harness.commands.map((command) => command.type)).toEqual([
      "project.create",
      "thread.create",
      "thread.turn.start",
    ]);
    const createThread = harness.commands[1] as {
      projectId: string;
      branch: string;
      modelSelection: {
        instanceId: string;
        model: string;
        options: Array<{ id: string; value: string | boolean }>;
      };
      runtimeMode: string;
    };
    const turn = harness.commands[2] as {
      message: { text: string };
    };
    expect(turn.message.text).toBe("Continue the implementation from this handover.");
    expect(createThread.projectId).toBe(result.project.id);
    expect(createThread.branch).toBe("main");
    expect(createThread.modelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.6-sol",
    });
    expect(createThread.modelSelection.options).toBeUndefined();
    expect(createThread.runtimeMode).toBe("full-access");
    expect(harness.commands[2]).toMatchObject({ runtimeMode: "full-access" });
    expect(result.opened.kind).toBe("none");
  });

  it("inherits an existing project's pre-configured model and options", async () => {
    const harness = await testHarness();
    harness.projects.push({
      id: "project-existing",
      title: "Existing project",
      workspaceRoot: await realpath(harness.root),
      defaultModelSelection: {
        instanceId: "claudeAgent",
        model: "claude-sonnet-5",
        options: [{ id: "effort", value: "max" }],
      },
      deletedAt: null,
    });

    await createHandoverThread(harness.config, {
      cwd: harness.root,
      prompt: "Handover",
      openMode: "none",
    });

    expect(harness.commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
    const expectedSelection = {
      instanceId: "claudeAgent",
      model: "claude-sonnet-5",
      options: [{ id: "effort", value: "max" }],
    };
    expect(harness.commands[0]).toMatchObject({
      modelSelection: expectedSelection,
      runtimeMode: "full-access",
    });
    expect(harness.commands[1]).toMatchObject({
      modelSelection: expectedSelection,
      runtimeMode: "full-access",
    });
  });

  it("honors existing-only project policy", async () => {
    const harness = await testHarness();

    await expect(
      createHandoverThread(harness.config, {
        cwd: harness.root,
        prompt: "Handover",
        projectPolicy: "existing",
        openMode: "none",
      }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" } satisfies Partial<CliError>);
    expect(harness.commands).toHaveLength(0);
  });

  it("supports a no-write dry run", async () => {
    const harness = await testHarness();

    const result = await createHandoverThread(harness.config, {
      cwd: harness.root,
      prompt: "Handover",
      dryRun: true,
      openMode: "none",
    });

    expect(result.dryRun).toBe(true);
    expect(result.projectCommand).toMatchObject({ type: "project.create" });
    expect(result.thread.createCommand).toMatchObject({ type: "thread.create" });
    expect(result.thread.command).toMatchObject({ type: "thread.turn.start" });
    expect(harness.commands).toHaveLength(0);
  });

  it("uses the process working directory when cwd is omitted", async () => {
    const harness = await testHarness();

    const result = await createHandoverThread(harness.config, {
      prompt: "Handover",
      dryRun: true,
      openMode: "none",
    });

    expect(result.workspace.inputPath).toBe(await realpath(process.cwd()));
  });

  it("applies provider, model, speed, effort, permission, and interaction selections", async () => {
    const harness = await testHarness();

    await createHandoverThread(harness.config, {
      cwd: harness.root,
      prompt: "Handover",
      provider: "codex",
      model: "gpt-5.3-codex",
      speedMode: "fast",
      thinkingEffort: "high",
      runtimeMode: "approval-required",
      interactionMode: "plan",
      openMode: "none",
    });

    const createThread = harness.commands[1] as {
      modelSelection: { instanceId: string; model: string; options: Array<{ id: string; value: string | boolean }> };
      runtimeMode: string;
      interactionMode: string;
    };
    const turn = harness.commands[2] as typeof createThread;
    expect(createThread.modelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.3-codex",
    });
    expect(createThread.modelSelection.options).toEqual(
      expect.arrayContaining([
        { id: "serviceTier", value: "fast" },
        { id: "fastMode", value: true },
        { id: "reasoningEffort", value: "high" },
        { id: "effort", value: "high" },
        { id: "reasoning", value: "high" },
      ]),
    );
    expect(createThread.runtimeMode).toBe("approval-required");
    expect(createThread.interactionMode).toBe("plan");
    expect(turn.modelSelection).toEqual(createThread.modelSelection);
  });

  it("creates a new worktree through T3's bootstrap command", async () => {
    const harness = await testHarness();

    const result = await createHandoverThread(harness.config, {
      cwd: harness.root,
      prompt: "Handover",
      threadEnvMode: "worktree",
      openMode: "none",
    });

    expect(harness.commands.map((command) => command.type)).toEqual([
      "project.create",
      "thread.turn.start",
    ]);
    expect(result.thread.createDispatch).toBeNull();
    expect(result.thread.command).toMatchObject({
      type: "thread.turn.start",
      bootstrap: {
        createThread: {
          projectId: result.project.id,
          branch: "main",
          worktreePath: null,
        },
        prepareWorktree: {
          projectCwd: await realpath(harness.root),
          baseBranch: "main",
          startFromOrigin: true,
        },
        runSetupScript: true,
      },
      runtimeMode: "full-access",
    });
    expect(result.thread.command).toMatchObject({
      bootstrap: { createThread: { runtimeMode: "full-access" } },
    });
    expect(harness.threads).toHaveLength(1);
  });

  it("honors an explicit worktree-origin setting from the current installation", async () => {
    const harness = await testHarness([], {
      settings: { newWorktreesStartFromOrigin: false },
    });

    const result = await createHandoverThread(harness.config, {
      cwd: harness.root,
      prompt: "Handover",
      threadEnvMode: "worktree",
      openMode: "none",
      dryRun: true,
    });

    expect(result.thread.command).toMatchObject({
      bootstrap: { prepareWorktree: { startFromOrigin: false } },
    });
  });

  it("uses the 0.0.28 worktree-origin and model defaults", async () => {
    const harness = await testHarness([], { serverVersion: "0.0.28" });

    const result = await createHandoverThread(harness.config, {
      cwd: harness.root,
      prompt: "Handover",
      threadEnvMode: "worktree",
      openMode: "none",
      dryRun: true,
    });

    expect(result.projectCommand).toMatchObject({
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
    });
    expect(result.thread.command).toMatchObject({
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      bootstrap: { prepareWorktree: { startFromOrigin: false } },
    });
  });

  it("prefers a project's checkout setting over t3.json and the global setting", async () => {
    const harness = await testHarness([], {
      settings: { defaultThreadEnvMode: "worktree" },
    });
    await writeFile(
      path.join(harness.root, "t3.json"),
      JSON.stringify({ defaultThreadEnvMode: "worktree" }),
      "utf8",
    );
    harness.projects.push({
      id: "project-existing",
      title: "Existing project",
      workspaceRoot: await realpath(harness.root),
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      defaultThreadEnvMode: "local",
      deletedAt: null,
    });
    harness.config.threadEnvMode = "t3";

    const result = await createHandoverThread(harness.config, {
      cwd: harness.root,
      prompt: "Handover",
      dryRun: true,
      openMode: "none",
    });

    expect(result.settings).toMatchObject({
      effectiveThreadEnvMode: "local",
      threadEnvModeSource: "project",
    });
    expect(result.thread.command).not.toHaveProperty("bootstrap");
  });

  it("prefers t3.json's checkout setting over the global setting", async () => {
    const harness = await testHarness([], {
      settings: { defaultThreadEnvMode: "worktree" },
    });
    await writeFile(
      path.join(harness.root, "t3.json"),
      JSON.stringify({ defaultThreadEnvMode: "local" }),
      "utf8",
    );
    harness.config.threadEnvMode = "t3";

    const result = await createHandoverThread(harness.config, {
      cwd: harness.root,
      prompt: "Handover",
      dryRun: true,
      openMode: "none",
    });

    expect(result.settings).toMatchObject({
      effectiveThreadEnvMode: "local",
      threadEnvModeSource: "t3.json",
    });
    expect(result.thread.command).not.toHaveProperty("bootstrap");
  });

  it("uses the global checkout setting when the project and t3.json do not set one", async () => {
    const harness = await testHarness([], {
      settings: { defaultThreadEnvMode: "worktree" },
    });
    harness.config.threadEnvMode = "t3";

    const result = await createHandoverThread(harness.config, {
      cwd: harness.root,
      prompt: "Handover",
      dryRun: true,
      openMode: "none",
    });

    expect(result.settings).toMatchObject({
      effectiveThreadEnvMode: "worktree",
      threadEnvModeSource: "global",
    });
    expect(result.thread.command).toHaveProperty("bootstrap");
  });

  it("rejects worktree handovers against older T3 servers", async () => {
    const harness = await testHarness([], { serverVersion: "0.0.27" });

    await expect(
      createHandoverThread(harness.config, {
        cwd: harness.root,
        prompt: "Handover",
        threadEnvMode: "worktree",
        openMode: "none",
      }),
    ).rejects.toMatchObject({
      code: "WORKTREE_HANDOVER_UNSUPPORTED",
      details: { serverVersion: "0.0.27", minimumServerVersion: "0.0.28" },
    });
    expect(harness.commands).toHaveLength(0);
  });

  it("deletes a newly-created thread when its first turn fails", async () => {
    const harness = await testHarness([], { failTurn: true });

    await expect(
      createHandoverThread(harness.config, {
        cwd: harness.root,
        prompt: "Handover",
        openMode: "none",
      }),
    ).rejects.toMatchObject({
      code: "THREAD_START_FAILED",
      details: { cleanup: "deleted" },
    });
    expect(harness.commands.map((command) => command.type)).toEqual([
      "project.create",
      "thread.create",
      "thread.turn.start",
      "thread.delete",
    ]);
    expect(harness.threads).toHaveLength(0);
  });
});
