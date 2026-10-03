import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "./errors.js";
import { runProcess } from "./process.js";
import { createHandoverThread, ensureProject, listProjects, normalizeRequestPath, rawGet, resolveProject } from "./service.js";
import { DEFAULT_PROVIDERS, FakeRpcFailure, startFakeT3, type FakeT3, type FakeT3Options } from "./testing/fakeT3.js";
import { configForWait } from "./threadSupport.js";
import type { ModelSelection, T3Project } from "./types.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function fakeT3(options: FakeT3Options = {}): Promise<FakeT3> {
  const fake = await startFakeT3(options);
  cleanup.push(() => fake.close());
  return fake;
}

/** Adds a project at the fake's repository, as T3 records it: by its canonical path. */
async function addRootProject(fake: FakeT3, project: Partial<T3Project> = {}): Promise<T3Project> {
  return fake.addProject({ id: "project-main", title: "Main checkout", workspaceRoot: await realpath(fake.root), ...project });
}

async function addLinkedWorktree(repoRoot: string, branch: string): Promise<string> {
  await runProcess("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"], {
    cwd: repoRoot,
  });
  const parent = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-worktree-"));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const worktree = path.join(parent, "linked");
  await runProcess("git", ["worktree", "add", "-b", branch, worktree], { cwd: repoRoot });
  return await realpath(worktree);
}

/** Writes the state folder a local T3 server keeps, so the CLI finds its settings and projections. */
async function installState(fake: FakeT3, settings?: Record<string, unknown>): Promise<string> {
  const stateDir = path.join(fake.config.t3Home!, "userdata");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "server-runtime.json"),
    JSON.stringify({ version: 1, pid: process.pid, port: Number(new URL(fake.origin).port), origin: fake.origin, startedAt: new Date().toISOString() }),
    "utf8",
  );
  if (settings) await writeFile(path.join(stateDir, "settings.json"), JSON.stringify(settings), "utf8");
  return stateDir;
}

function writeProjectDatabase(file: string, projects: Array<{ id: string; title: string; workspaceRoot: string; model?: ModelSelection; deleted?: boolean }>) {
  const database = new DatabaseSync(file);
  try {
    database.exec(
      `CREATE TABLE projection_projects (
         project_id TEXT, title TEXT, workspace_root TEXT, default_model_selection_json TEXT,
         default_thread_env_mode TEXT, scripts_json TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)`,
    );
    const insert = database.prepare("INSERT INTO projection_projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const project of projects) {
      insert.run(
        project.id,
        project.title,
        project.workspaceRoot,
        project.model ? JSON.stringify(project.model) : null,
        "worktree",
        "[]",
        "2026-10-01T10:00:00.000Z",
        "2026-10-01T10:00:00.000Z",
        project.deleted ? "2026-10-02T10:00:00.000Z" : null,
      );
    }
  } finally {
    database.close();
  }
}

function launchCalls(fake: FakeT3) {
  return fake.rpcCalls.filter((call) => call.tag === "orchestration.launchThread");
}

const apiPaths = (fake: FakeT3) => fake.httpRequests.map((request) => `${request.method} ${request.url}`).filter((entry) => entry.includes(" /api/"));

describe("createHandoverThread", () => {
  it("launches at the project root with the project's model", async () => {
    const fake = await fakeT3();
    const model = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "max" }] };
    const project = await addRootProject(fake, { defaultModelSelection: model });
    const prompt = `Continue the ${"very ".repeat(20)}long handover.\nSecond line with details.`;

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt, threadEnvMode: "local" });

    expect(result).toMatchObject({
      dryRun: false,
      projectCreated: false,
      projectCommand: null,
      projectDispatch: null,
      project: { id: project.id },
      settings: { effectiveThreadEnvMode: "local", threadEnvModeSource: "request" },
      opened: { kind: "none", url: null },
    });
    const launch = result.thread.launch;
    expect(launch).toEqual({
      commandId: expect.any(String),
      threadId: result.thread.id,
      projectId: project.id,
      title: `${prompt.split("\n")[0]!.slice(0, 79)}…`,
      generateTitle: true,
      modelSelection: model,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: result.thread.messageId, text: prompt, attachments: [] },
    });
    expect(result.thread.title).toHaveLength(80);
    expect(launchCalls(fake).map((call) => call.payload)).toEqual([launch]);
    expect(result.thread.resumed).toBe(false);
    // T3 started the first turn with the prompt.
    expect(fake.projection(result.thread.id).messages[0]).toMatchObject({ id: result.thread.messageId, role: "user", text: prompt });
    expect(fake.commands.map((command) => command.type)).toEqual(["launch"]);
  });

  it("creates a missing project through the project mutation route, then launches in it", async () => {
    const fake = await fakeT3();
    const root = await realpath(fake.root);

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", threadEnvMode: "local" });

    expect(fake.commands.map((command) => command.type)).toEqual(["project.create", "launch"]);
    expect(fake.commands[0]).toEqual({
      type: "project.create",
      commandId: expect.any(String),
      projectId: result.project.id,
      title: path.basename(root),
      workspaceRoot: root,
      createWorkspaceRootIfMissing: false,
    });
    expect(result).toMatchObject({ projectCreated: true, projectDispatch: { id: result.project.id, workspaceRoot: root } });
    expect(result.thread.launch.projectId).toBe(result.project.id);
    expect(fake.projects.map((project) => project.id)).toEqual([result.project.id]);
    // A new project has no model of its own, so T3's catalog default applies.
    expect(result.thread.launch.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6-astra" });
  });

  it.each([
    ["the Codex default", DEFAULT_PROVIDERS, { instanceId: "codex", model: "gpt-6-astra" }],
    [
      "the first enabled provider's default when Codex is off",
      DEFAULT_PROVIDERS.map((provider) => (provider.instanceId === "codex" ? { ...provider, enabled: false } : provider)),
      { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    ],
  ])("uses %s from T3's catalog when the project has no model", async (_name, providers, expected) => {
    const fake = await fakeT3({ providers });
    await addRootProject(fake);

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", dryRun: true });

    expect(result.thread.launch.modelSelection).toEqual(expected);
  });

  it("falls back to a built-in model when T3 does not serve its catalog", async () => {
    const fake = await fakeT3({
      rpcHandlers: {
        "server.getConfig": () => {
          throw new Error("catalog unavailable");
        },
      },
    });
    await addRootProject(fake);

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", dryRun: true });

    expect(result.thread.launch.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.6-sol" });
  });

  it("sets every known effort option when T3 does not serve its catalog", async () => {
    const fake = await fakeT3({
      rpcHandlers: {
        "server.getConfig": () => {
          throw new Error("no catalog");
        },
      },
    });
    await addRootProject(fake, { defaultModelSelection: { instanceId: "codex", model: "gpt-6-astra" } });

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", thinkingEffort: "high", dryRun: true });

    expect(result.thread.launch.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-6-astra",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "effort", value: "high" },
        { id: "reasoning", value: "high" },
      ],
    });
  });

  it("applies config and flag overrides to the model, permission, and mode, using the options the model has", async () => {
    const fake = await fakeT3();
    await addRootProject(fake, { defaultModelSelection: { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "low" }] } });
    const config = { ...fake.config, model: "gpt-6-astra", thinkingEffort: "low" };

    const result = await createHandoverThread(config, {
      cwd: fake.root,
      prompt: "Handover",
      thinkingEffort: "high",
      speedMode: "fast",
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });

    expect(result.thread.launch).toMatchObject({
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    // T3's catalog names the options gpt-6-astra uses, so only those are written.
    const options = result.thread.launch.modelSelection.options ?? [];
    expect(options).toEqual(
      expect.arrayContaining([
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ]),
    );
    expect(options.map((option) => option.id).sort()).toEqual(["reasoningEffort", "serviceTier"]);
    expect(fake.projection(result.thread.id).thread).toMatchObject({ runtimeMode: "approval-required", interactionMode: "plan" });

    await expect(createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", provider: "claudeAgent", dryRun: true })).rejects.toMatchObject({
      code: "MODEL_REQUIRED_FOR_PROVIDER",
    });
  });

  it("keeps working in the linked worktree it was started from", async () => {
    const fake = await fakeT3();
    await addRootProject(fake);
    const worktree = await addLinkedWorktree(fake.root, "feature/linked");

    const resolved = await resolveProject(fake.config, { cwd: worktree });
    const result = await createHandoverThread(fake.config, { cwd: worktree, prompt: "Handover", projectPolicy: "existing", threadEnvMode: "local" });

    expect(resolved.project?.id).toBe("project-main");
    expect(resolved.workspace).toMatchObject({ workspaceRoot: worktree, mainWorktreeRoot: await realpath(fake.root), branch: "feature/linked" });
    expect(result.project.id).toBe("project-main");
    expect(result.thread.launch.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: worktree });
    expect(fake.projection(result.thread.id).thread.worktreePath).toBe(worktree);
  });

  it("starts a new worktree from the current branch on a temporary branch", async () => {
    const fake = await fakeT3();
    await addRootProject(fake);

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", threadEnvMode: "worktree" });

    expect(result.thread.launch.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "main",
      branch: expect.stringMatching(/^t3code\/[0-9a-f]{8}$/u),
      startFromOrigin: true,
    });
    expect(result.settings).toMatchObject({ effectiveThreadEnvMode: "worktree", newWorktreesStartFromOrigin: true });
    expect(launchCalls(fake)).toHaveLength(1);
  });

  it("bases a new worktree on the linked worktree's branch and the project's checkout", async () => {
    const fake = await fakeT3();
    await addRootProject(fake);
    const worktree = await addLinkedWorktree(fake.root, "feature/linked");

    const result = await createHandoverThread(fake.config, { cwd: worktree, prompt: "Handover", threadEnvMode: "worktree", dryRun: true });

    expect(result.thread.launch).toMatchObject({
      projectId: "project-main",
      workspaceStrategy: { type: "worktree", baseRef: "feature/linked", startFromOrigin: true },
    });
  });

  it("honors the installation's setting for starting worktrees from origin", async () => {
    const fake = await fakeT3();
    await addRootProject(fake);
    await installState(fake, { newWorktreesStartFromOrigin: false });

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", threadEnvMode: "worktree", dryRun: true });

    expect(result.thread.launch.workspaceStrategy).toMatchObject({ type: "worktree", startFromOrigin: false });
    expect(result.settings.newWorktreesStartFromOrigin).toBe(false);
  });

  it("prefers the project's checkout setting over t3.json and the global setting", async () => {
    const fake = await fakeT3();
    await installState(fake, { defaultThreadEnvMode: "worktree" });
    await writeFile(path.join(fake.root, "t3.json"), JSON.stringify({ defaultThreadEnvMode: "worktree" }), "utf8");
    await addRootProject(fake, { defaultThreadEnvMode: "local" });

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", dryRun: true });

    expect(result.settings).toMatchObject({ effectiveThreadEnvMode: "local", threadEnvModeSource: "project", projectFileDefaultThreadEnvMode: "worktree" });
    expect(result.thread.launch.workspaceStrategy).toEqual({ type: "root" });
  });

  it("prefers t3.json's checkout setting over the global setting", async () => {
    const fake = await fakeT3();
    await installState(fake, { defaultThreadEnvMode: "worktree" });
    await writeFile(path.join(fake.root, "t3.json"), JSON.stringify({ defaultThreadEnvMode: "local" }), "utf8");
    await addRootProject(fake);

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", dryRun: true });

    expect(result.settings).toMatchObject({ effectiveThreadEnvMode: "local", threadEnvModeSource: "t3.json" });
    expect(result.thread.launch.workspaceStrategy).toEqual({ type: "root" });
  });

  it("uses the global checkout setting when the project and t3.json do not set one", async () => {
    const fake = await fakeT3();
    await installState(fake, { defaultThreadEnvMode: "worktree" });
    await addRootProject(fake);

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", dryRun: true });

    expect(result.settings).toMatchObject({ defaultThreadEnvMode: "worktree", effectiveThreadEnvMode: "worktree", threadEnvModeSource: "global" });
    expect(result.thread.launch.workspaceStrategy).toMatchObject({ type: "worktree" });
  });

  it("needs a Git branch for a new worktree", async () => {
    const fake = await fakeT3({ gitRepo: false });
    await addRootProject(fake);

    await expect(createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", threadEnvMode: "worktree" })).rejects.toMatchObject({
      code: "WORKTREE_REQUIRES_BRANCH",
      details: { isGitRepository: false, currentBranch: null },
    });
    expect(launchCalls(fake)).toEqual([]);
    expect(fake.commands).toEqual([]);
  });

  it("honors the existing-only project policy", async () => {
    const fake = await fakeT3();

    await expect(
      createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", projectPolicy: "existing" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND", details: { workspaceRoot: await realpath(fake.root), projectPolicy: "existing" } } satisfies Partial<CliError>);
    expect(fake.commands).toEqual([]);
    expect(launchCalls(fake)).toEqual([]);
  });

  it("names the main checkout when a linked worktree has no project", async () => {
    const fake = await fakeT3();
    const worktree = await addLinkedWorktree(fake.root, "feature/linked");

    await expect(createHandoverThread(fake.config, { cwd: worktree, prompt: "Handover", projectPolicy: "existing" })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
      details: { workspaceRoot: await realpath(fake.root), linkedWorktree: worktree },
    });
  });

  it("plans a dry run without creating a project or starting a thread", async () => {
    const fake = await fakeT3();

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", dryRun: true, openMode: "browser" });

    expect(result).toMatchObject({
      dryRun: true,
      projectCreated: true,
      projectCommand: { type: "project.create" },
      projectDispatch: null,
      thread: { resumed: false, launch: { workspaceStrategy: { type: "root" } } },
      // A dry run opens nothing, whatever the open mode.
      opened: { mode: "browser", kind: "none", url: null },
    });
    expect(fake.commands).toEqual([]);
    expect(launchCalls(fake)).toEqual([]);
    expect(fake.threads.size).toBe(0);
  });

  it("uses the process working directory when cwd is omitted", async () => {
    const fake = await fakeT3();

    const result = await createHandoverThread(fake.config, { prompt: "Handover", dryRun: true });

    expect(result.workspace.inputPath).toBe(await realpath(process.cwd()));
  });

  it("waits for the first turn and returns its reply without the prompt", async () => {
    const fake = await fakeT3();
    await addRootProject(fake);

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Which tests fail?", wait: { timeoutMs: 10_000 } });

    expect(result.wait).toMatchObject({ outcome: "completed", turnIndex: 1, statusAfter: "active" });
    expect(result.reply?.messages.map((message) => [message.role, message.text])).toEqual([["assistant", "Reply to: Which tests fail?"]]);
    expect(result.pendingRequests).toEqual([]);
  });

  it("tells the caller not to hand over again when the first turn outlasts the wait", async () => {
    const fake = await fakeT3({ runBehavior: "hold" });
    await addRootProject(fake);

    const failure = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", wait: { timeoutMs: 50 } }).catch(
      (error: unknown) => error,
    );

    const threadId = launchCalls(fake)[0]?.payload.threadId;
    expect(failure).toMatchObject({ code: "THREAD_WAIT_TIMEOUT", exitCode: 6, details: { threadId, sent: true } });
    expect((failure as Error).message).toContain("Do not hand over again");
  });

  it("reports T3's reason when it cannot launch the thread", async () => {
    const fake = await fakeT3({
      rpcHandlers: {
        "orchestration.launchThread": () => {
          throw new FakeRpcFailure([
            {
              _tag: "Fail",
              error: {
                _tag: "OrchestrationV2LaunchThreadError",
                message: "Could not prepare the worktree",
                cause: { message: "fatal: 'main' is already used by worktree" },
              },
            },
          ]);
        },
      },
    });
    await addRootProject(fake);

    const failure = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover", threadEnvMode: "worktree" }).catch(
      (error: unknown) => error,
    );

    const launch = launchCalls(fake)[0]?.payload;
    expect(failure).toMatchObject({
      code: "THREAD_START_FAILED",
      message: "T3 could not launch the handover thread: Could not prepare the worktree: fatal: 'main' is already used by worktree",
      details: { threadId: launch?.threadId, cleanup: "server-managed", launchCommandId: launch?.commandId },
      cause: { code: "T3_RPC_FAILED", details: { rpc: "orchestration.launchThread", errorTag: "OrchestrationV2LaunchThreadError" } },
    });
  });

  it("needs a prompt", async () => {
    const fake = await fakeT3();

    await expect(createHandoverThread(fake.config, { cwd: fake.root, prompt: "  \n " })).rejects.toMatchObject({ code: "PROMPT_REQUIRED" });
  });

  it("finds the project in T3's local V2 projection without asking the server", async () => {
    const fake = await fakeT3();
    const stateDir = await installState(fake);
    const model = { instanceId: "codex", model: "gpt-6-luna" };
    writeProjectDatabase(path.join(stateDir, "statev2.sqlite"), [{ id: "project-local", title: "Local", workspaceRoot: await realpath(fake.root), model }]);

    const result = await createHandoverThread(fake.config, { cwd: fake.root, prompt: "Handover" });

    expect(result).toMatchObject({ projectCreated: false, project: { id: "project-local", defaultThreadEnvMode: "worktree" } });
    expect(result.thread.launch).toMatchObject({ projectId: "project-local", modelSelection: model });
    expect(apiPaths(fake)).not.toContain("GET /api/projects");
  });
});

describe("projects", () => {
  it("lists projects from the server when no local projection exists", async () => {
    const fake = await fakeT3();
    fake.addProject({ id: "kept", title: "Kept" });
    fake.addProject({ id: "deleted", title: "Deleted", deletedAt: "2026-10-02T10:00:00.000Z" });

    const result = await listProjects(fake.config);

    expect(result.auth.source).toBe("configured");
    expect(result.projects.map((project) => project.id)).toEqual(["kept"]);
    expect(apiPaths(fake)).toContain("GET /api/projects");
  });

  it("reads V2's statev2.sqlite and ignores the V1 state.sqlite it was copied from", async () => {
    const fake = await fakeT3();
    fake.addProject({ id: "from-server", title: "Server" });
    const stateDir = await installState(fake);

    writeProjectDatabase(path.join(stateDir, "state.sqlite"), [{ id: "from-v1", title: "V1", workspaceRoot: fake.root }]);
    const v1Only = await listProjects(fake.config);
    expect(v1Only.projects.map((project) => project.id)).toEqual(["from-server"]);

    writeProjectDatabase(path.join(stateDir, "statev2.sqlite"), [
      { id: "from-v2", title: "V2", workspaceRoot: fake.root, model: { instanceId: "codex", model: "gpt-6-astra" } },
      { id: "deleted-v2", title: "Gone", workspaceRoot: fake.root, deleted: true },
    ]);
    const requestsBefore = fake.httpRequests.length;
    const local = await listProjects(fake.config);

    expect(local.auth).toEqual({ source: "local-sqlite", version: "0.0.46-nightly.20261003.2600" });
    expect(local.projects).toEqual([
      expect.objectContaining({ id: "from-v2", defaultModelSelection: { instanceId: "codex", model: "gpt-6-astra" }, defaultThreadEnvMode: "worktree" }),
    ]);
    // Only the environment descriptor was read; the local projection answered the rest.
    expect(fake.httpRequests.slice(requestsBefore).map((request) => request.url)).toEqual(["/.well-known/t3/environment"]);
  });

  it("resolves a folder to its project, or to none", async () => {
    const fake = await fakeT3();

    expect((await resolveProject(fake.config, { cwd: fake.root })).project).toBeNull();
    await addRootProject(fake);
    expect((await resolveProject(fake.config, { cwd: fake.root })).project?.id).toBe("project-main");
  });

  it("ensures a project according to the policy", async () => {
    const fake = await fakeT3();

    const planned = await ensureProject(fake.config, { cwd: fake.root, dryRun: true });
    expect(planned).toMatchObject({ created: true, command: { type: "project.create" }, dispatch: null });
    expect(fake.commands).toEqual([]);
    await expect(ensureProject(fake.config, { cwd: fake.root, projectPolicy: "existing" })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });

    const created = await ensureProject(fake.config, { cwd: fake.root });
    expect(created).toMatchObject({ created: true, dispatch: { id: created.project.id } });
    expect(fake.commands.map((command) => command.type)).toEqual(["project.create"]);

    const existing = await ensureProject(fake.config, { cwd: fake.root });
    expect(existing).toMatchObject({ created: false, command: null, project: { id: created.project.id } });
    expect(fake.commands).toHaveLength(1);
  });
});

describe("raw requests", () => {
  it("reads a T3 API path with the orchestration protocol header", async () => {
    const fake = await fakeT3();
    fake.addThread();

    const result = await rawGet(fake.config, "api/orchestration/shell");

    expect(result.response).toMatchObject({ threads: [expect.objectContaining({ status: "idle" })] });
    expect(fake.httpRequests.find((request) => request.url === "/api/orchestration/shell")?.protocolHeader).toBe("2");
  });

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

describe("configForWait", () => {
  it("issues a session that outlives the wait", () => {
    const fake = { sessionTtl: "2m" } as Parameters<typeof configForWait>[0];

    expect(configForWait(fake, { timeoutMs: 600_000 }).sessionTtl).toBe("12m");
    expect(configForWait(fake, { timeoutMs: 1_000 }).sessionTtl).toBe("3m");
    expect(configForWait(fake, undefined)).toBe(fake);
  });
});
