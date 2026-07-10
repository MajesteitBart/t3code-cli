import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runProcess } from "./process.js";
import { resolveWorkspace } from "./workspace.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveWorkspace", () => {
  it("resolves a nested folder to the Git root in repo mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-workspace-"));
    cleanup.push(root);
    await runProcess("git", ["init", "-b", "main"], { cwd: root });
    const nested = path.join(root, "packages", "app");
    await mkdir(nested, { recursive: true });

    const resolution = await resolveWorkspace(nested, "repo");

    expect(resolution.workspaceRoot).toBe(await realpath(root));
    expect(resolution.isGitRepository).toBe(true);
    expect(resolution.branch).toBe("main");
  });

  it("keeps the exact nested folder in folder mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-folder-"));
    cleanup.push(root);
    await runProcess("git", ["init", "-b", "main"], { cwd: root });
    const nested = path.join(root, "packages", "app");
    await mkdir(nested, { recursive: true });

    const resolution = await resolveWorkspace(nested, "folder");

    expect(resolution.workspaceRoot).toBe(await realpath(nested));
    expect(resolution.isGitRepository).toBe(true);
  });
});
