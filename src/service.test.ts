import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { DEFAULT_CONFIG } from "./config.js";
import { CliError } from "./errors.js";
import { runProcess } from "./process.js";
import { createHandoverThread, normalizeRequestPath, resolveProject } from "./service.js";
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

async function addLinkedWorktree(repoRoot: string, branch: string): Promise<string> {
  await runProcess("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"], {
    cwd: repoRoot,
  });
  const parent = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-worktree-"));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const worktree = path.join(parent, "linked");
  await runProcess("git", ["worktree", "add", "-b", branch, worktree], { cwd: repoRoot });
  return worktree;
}

async function testHarness(
  initialProjects: T3Project[] = [],
  options: {
    failTurn?: boolean;
    failBootstrap?: string;
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
  const rpcCommands: Array<Record<string, unknown>> = [];
  const wsTicket = "mock-ws-ticket";
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
    if (request.method === "POST" && request.url === "/api/auth/websocket-ticket") {
      json(response, 200, { ticket: wsTicket, expiresAt: new Date(Date.now() + 60_000).toISOString() });
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
      // Like T3, the HTTP route ignores `bootstrap`, so a turn for a thread that does not exist fails.
      if (command.type === "thread.turn.start" && !threads.some((thread) => thread.id === command.threadId)) {
        json(response, 500, { error: `Thread '${String(command.threadId)}' does not exist for command 'thread.turn.start'.` });
        return;
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
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws" || url.searchParams.get("wsTicket") !== wsTicket) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (data) => {
        const message = JSON.parse(String(data)) as {
          _tag: string;
          id: string;
          tag: string;
          payload: Record<string, unknown>;
        };
        if (message._tag !== "Request" || message.tag !== "orchestration.dispatchCommand") return;
        const command = message.payload;
        rpcCommands.push(command);
        const bootstrap = command.bootstrap as { createThread?: Record<string, unknown> } | undefined;
        if (options.failBootstrap) {
          client.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: message.id,
              exit: {
                _tag: "Failure",
                cause: [
                  {
                    _tag: "Fail",
                    error: {
                      _tag: "OrchestrationDispatchCommandError",
                      message: options.failBootstrap,
                      bootstrapThreadDisposition: "not-created",
                    },
                  },
                ],
              },
            }),
          );
          return;
        }
        if (bootstrap?.createThread) {
          threads.push({
            id: command.threadId as string,
            projectId: bootstrap.createThread.projectId as string,
            title: bootstrap.createThread.title as string,
            archivedAt: null,
          });
        }
        client.send(
          JSON.stringify({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: { sequence: 1 } } }),
        );
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
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
  return { root, config, projects, threads, commands, rpcCommands };
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

    expect(harness.commands.map((command) => command.type)).toEqual(["project.create"]);
    expect(harness.rpcCommands.map((command) => command.type)).toEqual(["thread.turn.start"]);
    expect(harness.rpcCommands[0]).toEqual(result.thread.command);
    expect(result.thread.createDispatch).toBeNull();
    expect(result.thread.dispatch).toEqual({ sequence: 1 });
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
          requireWorktree: true,
        },
        runSetupScript: true,
      },
      runtimeMode: "full-access",
    });
    const prepareWorktree = (result.thread.command as { bootstrap: { prepareWorktree: { branch: string } } })
      .bootstrap.prepareWorktree;
    expect(prepareWorktree.branch).toMatch(/^t3code\/[0-9a-f]{8}$/u);
    expect(result.thread.command).toMatchObject({
      bootstrap: { createThread: { runtimeMode: "full-access" } },
    });
    expect(harness.threads).toHaveLength(1);
  });

  it("reports T3's reason when a worktree bootstrap fails", async () => {
    const harness = await testHarness([], {
      failBootstrap: "A separate worktree requires a Git repository and a base branch with a commit.",
    });

    const failure = await createHandoverThread(harness.config, {
      cwd: harness.root,
      prompt: "Handover",
      threadEnvMode: "worktree",
      openMode: "none",
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "THREAD_START_FAILED",
      details: { cleanup: "not-created" },
      cause: {
        code: "T3_RPC_FAILED",
        message: "A separate worktree requires a Git repository and a base branch with a commit.",
        details: { errorTag: "OrchestrationDispatchCommandError", bootstrapThreadDisposition: "not-created" },
      },
    });
    expect(harness.threads).toHaveLength(0);
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

  it("hands over into a linked worktree of an existing project", async () => {
    const harness = await testHarness();
    const worktree = await addLinkedWorktree(harness.root, "feature/linked");
    harness.projects.push({
      id: "project-main",
      title: "Main checkout",
      workspaceRoot: await realpath(harness.root),
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      deletedAt: null,
    });

    const resolved = await resolveProject(harness.config, { cwd: worktree });
    const result = await createHandoverThread(harness.config, {
      cwd: worktree,
      prompt: "Handover",
      projectPolicy: "existing",
      openMode: "none",
    });

    expect(resolved.project?.id).toBe("project-main");
    expect(resolved.workspace).toMatchObject({
      workspaceRoot: await realpath(worktree),
      mainWorktreeRoot: await realpath(harness.root),
    });
    expect(result.project.id).toBe("project-main");
    expect(harness.commands.map((command) => command.type)).toEqual(["thread.create", "thread.turn.start"]);
    expect(harness.commands[0]).toMatchObject({
      projectId: "project-main",
      branch: "feature/linked",
      worktreePath: await realpath(worktree),
    });
  });

  it("prepares new worktrees from the project checkout when started in a linked worktree", async () => {
    const harness = await testHarness();
    const worktree = await addLinkedWorktree(harness.root, "feature/linked");
    harness.projects.push({
      id: "project-main",
      title: "Main checkout",
      workspaceRoot: await realpath(harness.root),
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      deletedAt: null,
    });

    const result = await createHandoverThread(harness.config, {
      cwd: worktree,
      prompt: "Handover",
      threadEnvMode: "worktree",
      openMode: "none",
      dryRun: true,
    });

    expect(result.thread.command).toMatchObject({
      bootstrap: {
        createThread: { projectId: "project-main", worktreePath: null },
        prepareWorktree: { projectCwd: await realpath(harness.root), baseBranch: "feature/linked" },
      },
    });
  });

  it("names the main checkout when a linked worktree has no project", async () => {
    const harness = await testHarness();
    const worktree = await addLinkedWorktree(harness.root, "feature/linked");

    await expect(
      createHandoverThread(harness.config, {
        cwd: worktree,
        prompt: "Handover",
        projectPolicy: "existing",
        openMode: "none",
      }),
    ).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
      details: { workspaceRoot: await realpath(harness.root), linkedWorktree: await realpath(worktree) },
    });
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

describe("normalizeRequestPath", () => {
  it("accepts paths with or without a leading slash", () => {
    expect(normalizeRequestPath("/api/orchestration/shell")).toBe("/api/orchestration/shell");
    expect(normalizeRequestPath("api/orchestration/shell")).toBe("/api/orchestration/shell");
  });

  it("explains Git Bash path conversion", () => {
    expect(() => normalizeRequestPath("C:/Program Files/Git/api/orchestration/shell")).toThrow(/MSYS_NO_PATHCONV/u);
  });

  it("rejects paths that would leave the T3 origin", () => {
    for (const requestPath of ["//example.com/api", "/\\example.com/api", "\\\\example.com/api"]) {
      expect(() => normalizeRequestPath(requestPath)).toThrow(CliError);
    }
  });
});
