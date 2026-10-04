import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, test } from "vitest";

import { T3Api } from "./api.js";
import { doctor } from "./doctor.js";
import { CliError } from "./errors.js";
import { readResponseText, withHttpResponse } from "./http.js";
import { resolveT3Invocation } from "./process.js";
import { discoverRuntime, requireSupportedProtocol } from "./runtime.js";
import { listThreads } from "./service.js";
import { FakeRpcFailure, startFakeT3, type FakeT3, type FakeT3Options } from "./testing/fakeT3.js";
import type { T3Runtime } from "./types.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function fakeT3(options: FakeT3Options = {}): Promise<FakeT3> {
  const fake = await startFakeT3({ gitRepo: false, ...options });
  cleanup.push(() => fake.close());
  return fake;
}

async function apiFor(fake: FakeT3): Promise<T3Api> {
  return new T3Api(await discoverRuntime(fake.config, { startDesktopIfNeeded: false }), "mock-token");
}

function runtimeAt(origin: string, overrides: Partial<T3Runtime> = {}): T3Runtime {
  return {
    origin,
    environmentId: "test",
    serverVersion: "test",
    orchestrationProtocolVersion: 2,
    stateDir: null,
    runtimeStatePath: null,
    settingsPath: null,
    capabilities: {},
    ...overrides,
  };
}

describe("HTTP transport", () => {
  test.each(["headers", "body"])("timeout closes the socket while waiting for %s", async (phase) => {
    const server = createHttpServer((_req, res) => {
      if (phase === "body") {
        res.writeHead(200, { "Content-Length": "100" });
        res.write("{");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const closed = once(server, "connection").then(([socket]) => once(socket, "close"));
    try {
      await expect(
        withHttpResponse(new URL(`http://127.0.0.1:${address.port}`), { signal: AbortSignal.timeout(100) }, undefined, readResponseText),
      ).rejects.toMatchObject({ code: "ABORT_ERR" });
      await closed;
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  test("POST keeps bearer authentication, the protocol header, the JSON payload, and response decoding", async () => {
    let received: unknown;
    const server = createHttpServer(async (req, res) => {
      received = {
        method: req.method,
        authorization: req.headers.authorization,
        protocol: req.headers["x-t3-orchestration-protocol"],
        contentType: req.headers["content-type"],
        body: JSON.parse(await readResponseText(req)),
      };
      res.end(JSON.stringify({ accepted: "é😀" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    try {
      const api = new T3Api(runtimeAt(`http://127.0.0.1:${address.port}`), "fixture-token");
      expect(await api.request("POST", "/api/projects/mutate", { text: "é😀" })).toEqual({ accepted: "é😀" });
      expect(received).toEqual({
        method: "POST",
        authorization: "Bearer fixture-token",
        protocol: "2",
        contentType: "application/json",
        body: { text: "é😀" },
      });
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  test("truncated response bodies become T3_REQUEST_FAILED", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{}"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const api = new T3Api(runtimeAt(`http://127.0.0.1:${address.port}`), "fixture-token");
    try {
      await expect(api.request("GET", "/snapshot")).rejects.toMatchObject({ code: "T3_REQUEST_FAILED" });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("refuses a request path that leaves the T3 origin", async () => {
    const api = new T3Api(runtimeAt("http://127.0.0.1:9"), "fixture-token");

    await expect(api.request("GET", "//example.com/api")).rejects.toMatchObject({ code: "INVALID_REQUEST_PATH" });
  });
});

describe("T3Api against an orchestration V2 server", () => {
  it("names protocol 2 on every orchestration request", async () => {
    const fake = await fakeT3();
    const { thread } = fake.addThread({ turns: 1 });
    const api = await apiFor(fake);

    await api.shellSnapshot();
    await api.threadDetail(thread.id);
    await api.threadDetail(thread.id, { bounded: true });
    await api.projects();

    const orchestration = fake.httpRequests.filter((request) => request.url.startsWith("/api/orchestration/"));
    expect(orchestration.map((request) => request.url)).toEqual([
      "/api/orchestration/shell",
      `/api/orchestration/threads/${thread.id}`,
      `/api/orchestration/threads/${thread.id}/bounded`,
    ]);
    expect(fake.httpRequests.filter((request) => request.url.startsWith("/api/")).every((request) => request.protocolHeader === "2")).toBe(true);
  });

  it("connects its WebSocket with protocol 2 and a fresh ticket per call", async () => {
    const fake = await fakeT3();
    const api = await apiFor(fake);

    await api.rpc("server.getConfig", {});
    await api.dispatchCommand({ type: "thread.pin", commandId: "c1", threadId: fake.addThread().thread.id });

    expect(fake.wsUpgrades).toHaveLength(2);
    for (const upgrade of fake.wsUpgrades) {
      const url = new URL(upgrade, "http://fake");
      expect(url.pathname).toBe("/ws");
      expect(url.searchParams.get("orchestrationProtocol")).toBe("2");
      expect(url.searchParams.get("wsTicket")).toMatch(/^[0-9a-f-]{36}$/u);
    }
    expect(new Set(fake.wsUpgrades).size).toBe(2);
    expect(fake.httpRequests.filter((request) => request.url === "/api/auth/websocket-ticket")).toHaveLength(2);
  });

  it("reads a shell snapshot, a thread projection, and the projects", async () => {
    const fake = await fakeT3();
    fake.addProject({ id: "kept" });
    fake.addProject({ id: "deleted", deletedAt: "2026-10-01T10:00:00.000Z" });
    const { thread } = fake.addThread({ turns: 1 });
    fake.addThread({ archivedAt: "2026-10-01T10:00:00.000Z" });
    const api = await apiFor(fake);

    const shell = await api.shellSnapshot();
    const detail = await api.threadDetail(thread.id);

    expect(shell.threads.map((candidate) => candidate.id)).toEqual([thread.id]);
    expect(shell.archivedThreads).toHaveLength(1);
    expect(shell.snapshotSequence).toBe(fake.sequence);
    expect(detail.projection.runs).toHaveLength(1);
    expect((await api.projects()).map((project) => project.id)).toEqual(["kept"]);
  });

  it("fills in projection lists an older server leaves out", async () => {
    const fake = await fakeT3();
    const projection = fake.addThread();
    for (const key of ["runs", "runtimeRequests", "messages", "turnItems"] as const) {
      delete (projection as Partial<typeof projection>)[key];
    }
    const api = await apiFor(fake);

    const detail = await api.threadDetail(projection.thread.id);

    expect(detail.projection).toMatchObject({ runs: [], runtimeRequests: [], messages: [], turnItems: [] });
  });

  it("turns a missing thread into THREAD_NOT_FOUND and other HTTP errors into T3_API_ERROR", async () => {
    const fake = await fakeT3();
    const api = await apiFor(fake);

    const missing = await api.threadDetail("missing").catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(CliError);
    expect(missing).toMatchObject({ code: "THREAD_NOT_FOUND", exitCode: 3, details: { threadId: "missing" } });

    await expect(api.request("GET", "/api/unknown")).rejects.toMatchObject({
      code: "T3_API_ERROR",
      details: { status: 404, body: { error: "not found" } },
    });
    await expect(new T3Api(api.runtime, "wrong-token").shellSnapshot()).rejects.toMatchObject({
      code: "T3_API_ERROR",
      details: { status: 401 },
    });
  });

  it("returns the launched thread and the event sequence of a command", async () => {
    const fake = await fakeT3();
    const project = fake.addProject();
    const api = await apiFor(fake);

    const launched = await api.launchThread({
      commandId: "launch-1",
      threadId: "thread-launched",
      projectId: project.id,
      title: "Launched",
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: "message-1", text: "Go", attachments: [] },
    });
    const dispatched = await api.dispatchCommand({ type: "thread.pin", commandId: "pin-1", threadId: "thread-launched" });

    expect(launched).toMatchObject({ threadId: "thread-launched", resumed: false, projection: { thread: { id: "thread-launched" } } });
    expect(dispatched).toEqual({ sequence: fake.sequence });
  });

  it("refuses RPC answers without the expected fields", async () => {
    const fake = await fakeT3({
      rpcHandlers: {
        "orchestration.dispatchCommand": () => ({ accepted: true }),
        "orchestration.launchThread": () => ({ resumed: false }),
      },
    });
    const api = await apiFor(fake);

    await expect(api.dispatchCommand({ type: "thread.pin", commandId: "c1" })).rejects.toMatchObject({ code: "T3_INVALID_DISPATCH" });
    await expect(api.launchThread({})).rejects.toMatchObject({ code: "T3_INVALID_DISPATCH" });
  });
});

describe("RPC failures", () => {
  async function failWith(cause: unknown[]): Promise<CliError> {
    const fake = await fakeT3({
      rpcHandlers: {
        "orchestration.dispatchCommand": () => {
          throw new FakeRpcFailure(cause);
        },
      },
    });
    const api = await apiFor(fake);
    return (await api.dispatchCommand({ type: "thread.settle", commandId: "c1" }).catch((error: unknown) => error)) as CliError;
  }

  it("prefers the failure's detail, then its message", async () => {
    const detailed = await failWith([
      { _tag: "Fail", error: { _tag: "OrchestrationV2DispatchCommandError", commandType: "thread.settle", message: "Rejected", detail: "Thread has active work." } },
    ]);
    expect(detailed).toMatchObject({
      code: "T3_RPC_FAILED",
      message: "Thread has active work.",
      details: { rpc: "orchestration.dispatchCommand", errorTag: "OrchestrationV2DispatchCommandError", commandType: "thread.settle" },
    });

    const plain = await failWith([{ _tag: "Fail", error: { message: "Unknown thread." } }]);
    expect(plain.message).toBe("Unknown thread.");
    expect(plain.details).not.toHaveProperty("errorTag");
  });

  it("adds the reason a launch step failed, once", async () => {
    const withCause = await failWith([
      { _tag: "Fail", error: { _tag: "LaunchError", message: "Could not prepare the worktree", cause: { message: "fatal: invalid reference" } } },
    ]);
    expect(withCause.message).toBe("Could not prepare the worktree: fatal: invalid reference");

    const repeated = await failWith([
      { _tag: "Fail", error: { detail: "Could not prepare the worktree: fatal: invalid reference", cause: { message: "fatal: invalid reference" } } },
    ]);
    expect(repeated.message).toBe("Could not prepare the worktree: fatal: invalid reference");
  });

  it("reports a defect, or names the RPC when T3 gives no reason", async () => {
    expect((await failWith([{ _tag: "Die", defect: "Server crashed." }])).message).toBe("Server crashed.");
    const silent = await failWith([{ _tag: "Interrupt" }]);
    expect(silent).toMatchObject({
      code: "T3_RPC_FAILED",
      message: "T3 rejected orchestration.dispatchCommand.",
      details: { cause: [{ _tag: "Interrupt" }] },
    });
  });
});

describe("orchestration protocol", () => {
  it("refuses a V1 server before issuing a session or calling the API", async () => {
    const fake = await fakeT3({ protocol: 1, serverVersion: "0.0.45" });

    const refused = await listThreads(fake.config).catch((error: unknown) => error);

    expect(refused).toMatchObject({
      code: "T3_PROTOCOL_UNSUPPORTED",
      exitCode: 4,
      message: "T3 0.0.45 runs orchestrator V1. This CLI needs orchestrator V2; use @bvdm/t3code-cli@0.2 for this T3 build.",
      details: { serverVersion: "0.0.45", orchestrationProtocolVersion: 1, supportedProtocolVersion: 2 },
    });
    expect(fake.httpRequests.map((request) => request.url)).toEqual(["/.well-known/t3/environment"]);
    // Only doctor looks past the protocol.
    await expect(discoverRuntime(fake.config, { startDesktopIfNeeded: false, allowUnsupportedProtocol: true })).resolves.toMatchObject({
      orchestrationProtocolVersion: 1,
    });
  });

  it("names the remedy for an unknown or newer protocol", () => {
    expect(() => requireSupportedProtocol(runtimeAt("http://t3", { orchestrationProtocolVersion: null, serverVersion: "0.0.30" }))).toThrow(
      "T3 0.0.30 runs orchestrator V1.",
    );
    expect(() => requireSupportedProtocol(runtimeAt("http://t3", { orchestrationProtocolVersion: 3, serverVersion: "0.1.0" }))).toThrow(
      "T3 0.1.0 speaks orchestration protocol 3, which this CLI does not know yet. Update @bvdm/t3code-cli.",
    );
    const supported = runtimeAt("http://t3");
    expect(requireSupportedProtocol(supported)).toBe(supported);
  });

  it("reports the server's protocol in doctor, even when the CLI cannot use it", async () => {
    const legacy = await fakeT3({ protocol: 1, serverVersion: "0.0.45" });
    const current = await fakeT3();

    const old = await doctor(legacy.config, "config.json", false);
    const ready = await doctor(current.config, "config.json", false);

    expect(old.ok).toBe(false);
    expect(old.checks.t3Server).toEqual({ ok: true, origin: legacy.origin, environmentId: "environment-1", version: "0.0.45" });
    expect(old.checks.orchestrationProtocol).toEqual({ ok: false, server: 1, supported: 2, hint: "Use @bvdm/t3code-cli@0.2 for this T3 build." });
    // The mock `t3` prints no version, so doctor cannot tell whether it matches.
    expect(old.checks.t3Cli).toMatchObject({ ok: true, source: "configured", version: null, matchesServer: null });
    expect(ready.checks.orchestrationProtocol).toEqual({ ok: true, server: 2, supported: 2 });
    expect(ready.checks.config).toEqual({ ok: true, path: "config.json", exists: false });
    // doctor reads only the environment descriptor; it opens no session.
    expect(legacy.httpRequests.map((request) => request.url)).toEqual(["/.well-known/t3/environment"]);
  });

  it("reports a missing server in doctor", async () => {
    const fake = await fakeT3();
    const config = { ...fake.config, origin: "http://127.0.0.1:9", t3Home: path.join(fake.root, "no-home") };

    const result = await doctor(config, "config.json", true);

    expect(result.ok).toBe(false);
    expect(result.checks.t3Server).toEqual({ ok: false, origin: null, environmentId: null, version: null });
    expect(result.checks.orchestrationProtocol).toEqual({ ok: false, server: null, supported: 2 });
    expect(result.checks.t3Home.ok).toBe(false);
  });
});

describe("resolveT3Invocation", () => {
  it("prefers a configured command", async () => {
    await expect(resolveT3Invocation([process.execPath, "t3.mjs", "--flag"], "0.0.46")).resolves.toEqual({
      command: process.execPath,
      argsPrefix: ["t3.mjs", "--flag"],
      source: "configured",
      version: null,
    });
    await expect(resolveT3Invocation([""], "0.0.46")).rejects.toMatchObject({ code: "INVALID_T3_COMMAND" });
  });

  // The desktop app runs its bundled server as Node, so a copy of Node stands in for it here.
  it.runIf(process.platform === "win32")("finds the installed desktop app that matches the server", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-desktop-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const programs = path.join(root, "Programs");
    // Windows scans each new executable on its first run, so the installs share one copy of Node.
    const node = path.join(root, "node.exe");
    await copyFile(process.execPath, node);
    const install = async (folder: string, version: string) => {
      const installPath = path.join(programs, folder);
      const entryDir = path.join(installPath, "resources", "server.asar", "apps", "server", "dist");
      await mkdir(entryDir, { recursive: true });
      await writeFile(path.join(entryDir, "bin.mjs"), `console.log(${JSON.stringify(`t3 v${version}`)});\n`, "utf8");
      const executable = path.join(installPath, `${folder}.exe`);
      await link(node, executable).catch(() => copyFile(node, executable));
      return installPath;
    };
    const stable = await install("T3 Code", "0.0.45");
    const nightly = await install("T3 Code (Nightly)", "0.0.46-nightly.20261003.2600");
    await writeFile(path.join(nightly, "Uninstall T3 Code (Nightly).exe"), "", "utf8");
    // A folder without the server archive is not an install.
    await mkdir(path.join(programs, "T3 Code (Leftover)"), { recursive: true });
    await writeFile(path.join(programs, "T3 Code (Leftover)", "T3 Code (Leftover).exe"), "", "utf8");

    const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, ProgramFiles: process.env.ProgramFiles, "ProgramFiles(x86)": process.env["ProgramFiles(x86)"] };
    process.env.LOCALAPPDATA = root;
    process.env.ProgramFiles = path.join(root, "missing");
    process.env["ProgramFiles(x86)"] = path.join(root, "missing-x86");
    try {
      const matching = await resolveT3Invocation(undefined, "0.0.46-nightly.20261003.2600");
      const unpinned = await resolveT3Invocation(undefined, null);

      expect(matching).toEqual({
        command: path.join(nightly, "T3 Code (Nightly).exe"),
        argsPrefix: [path.join(nightly, "resources", "server.asar", "apps", "server", "dist", "bin.mjs")],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        source: "desktop",
        version: "0.0.46-nightly.20261003.2600",
        installPath: nightly,
      });
      // Without a server version to match, the first install wins.
      expect(unpinned).toMatchObject({ source: "desktop", installPath: stable, version: "0.0.45" });
      // Each version is cached until the executable changes.
      const cache = JSON.parse(await readFile(path.join(root, "t3code-cli", "t3-versions.json"), "utf8")) as Record<string, { version: string }>;
      expect(cache[path.join(nightly, "T3 Code (Nightly).exe")]?.version).toBe("0.0.46-nightly.20261003.2600");
      expect(cache[path.join(stable, "T3 Code.exe")]?.version).toBe("0.0.45");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // A Node process that runs a file named like the server's entry stands in for the running server.
  it.runIf(process.platform === "linux")("uses the running server's own executable on Linux", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const entry = path.join(root, "resources", "app.asar", "apps", "server", "dist", "bin.mjs");
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "setInterval(() => {}, 1000);\n", "utf8");
    const { spawn } = await import("node:child_process");
    const server = spawn(process.execPath, [entry, "--bootstrap-fd", "3"], { stdio: "ignore" });
    cleanup.push(async () => {
      server.kill();
    });
    const runtimeStatePath = path.join(root, "server-runtime.json");
    await writeFile(runtimeStatePath, JSON.stringify({ version: 1, pid: server.pid, port: 3773, origin: "http://127.0.0.1:3773", startedAt: new Date().toISOString() }), "utf8");

    const invocation = await resolveT3Invocation(undefined, "0.0.46-nightly.20261003.2610", runtimeStatePath);

    expect(invocation).toEqual({
      command: await realpath(process.execPath),
      argsPrefix: [entry],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      source: "server",
      version: "0.0.46-nightly.20261003.2610",
    });
    // A runtime file whose process is gone falls through to the other ways of finding `t3`.
    await writeFile(runtimeStatePath, JSON.stringify({ version: 1, pid: 2 ** 22 + 7 }), "utf8");
    await expect(resolveT3Invocation(undefined, "0.0.46", runtimeStatePath)).resolves.not.toMatchObject({ source: "server" });
  });

  // `node ./apps/server/dist/bin.mjs serve`, started from the app folder while the CLI runs elsewhere.
  it.runIf(process.platform === "linux")("resolves a relative server entry against the server's working directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const appDir = path.join(root, "opt", "t3");
    const entry = path.join(appDir, "apps", "server", "dist", "bin.mjs");
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "setInterval(() => {}, 1000);\n", "utf8");
    const { spawn } = await import("node:child_process");
    const server = spawn(process.execPath, ["./apps/server/dist/bin.mjs", "serve"], { cwd: appDir, stdio: "ignore" });
    cleanup.push(async () => {
      server.kill();
    });
    const runtimeStatePath = path.join(root, "server-runtime.json");
    await writeFile(runtimeStatePath, JSON.stringify({ version: 1, pid: server.pid }), "utf8");
    expect(process.cwd()).not.toBe(appDir);

    const invocation = await resolveT3Invocation(undefined, "0.0.46", runtimeStatePath);

    expect(invocation).toMatchObject({ source: "server", argsPrefix: [path.join(await realpath(appDir), "apps", "server", "dist", "bin.mjs")] });
  });

  // A copy of Node stands in for `t3` on PATH, and answers --version with its own version.
  it("uses `t3` on PATH only when its version matches the server", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "t3code-cli-path-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "bin");
    await mkdir(bin, { recursive: true });
    const name = process.platform === "win32" ? "t3.exe" : "t3";
    await link(process.execPath, path.join(bin, name)).catch(() => copyFile(process.execPath, path.join(bin, name)));
    const saved = {
      PATH: process.env.PATH,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      ProgramFiles: process.env.ProgramFiles,
      "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
    };
    // Without desktop installs, PATH is the next place to look.
    process.env.LOCALAPPDATA = path.join(root, "no-apps");
    process.env.ProgramFiles = path.join(root, "no-apps");
    process.env["ProgramFiles(x86)"] = path.join(root, "no-apps");
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    try {
      const matching = await resolveT3Invocation(undefined, process.versions.node);
      expect(matching).toMatchObject({ source: "path", version: process.versions.node });
      // Windows may report the temp folder by its short 8.3 name, so compare the part this test made.
      expect(matching.command.toLowerCase().endsWith(path.join(path.basename(root), "bin", name).toLowerCase())).toBe(true);

      // Another version would write the session to a database this server does not read.
      const other = await resolveT3Invocation(undefined, "0.0.46-nightly.20261003.2600").catch((error: unknown) => error);
      expect(other).not.toMatchObject({ source: "path" });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
