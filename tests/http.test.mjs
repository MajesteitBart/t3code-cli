import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const exec = promisify(execFile);
let directory;
let build;
beforeAll(async () => {
  directory = await mkdtemp(path.resolve(".http-test-"));
  build = path.join(directory, "dist");
  await exec(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--outDir", build]);
}, 20_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

for (const framing of ["length", "eof", "chunked", "truncated-length", "truncated-chunked"]) {
  test(`child survives backpressure and socket FIN: ${framing}`, async () => {
    const result = await exec(process.execPath, ["tests/fixtures/http-backpressure.mjs", path.join(build, "http.js"), framing], { timeout: 5000 });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ framing, backpressured: true });
  });
}

for (const mode of ["large", "truncated", "http-error"]) {
  test(`built CLI preserves envelope and revokes session: ${mode}`, async () => {
    const data = { text: "a😀é".repeat(1024 * 1024) };
    const authLog = path.join(directory, `${mode}.log`);
    const authScript = path.join(directory, `${mode}-auth.mjs`);
    await writeFile(authScript, `
      import { appendFileSync } from 'node:fs';
      const args = process.argv.slice(2);
      appendFileSync(${JSON.stringify(authLog)}, JSON.stringify(args) + '\\n');
      if (args.includes('issue')) console.log(JSON.stringify({ sessionId: 'fixture-session', token: 'fixture-token' }));
    `);
    let authorized = false;
    const server = createServer((req, res) => {
      if (req.url === "/.well-known/t3/environment") {
        res.end(JSON.stringify({ environmentId: "test", serverVersion: "test" }));
        return;
      }
      authorized = req.headers.authorization === "Bearer fixture-token";
      if (mode === "truncated") {
        res.writeHead(200, { "Content-Length": "100", Connection: "close" });
        res.end("{}");
      } else if (mode === "http-error") {
        res.writeHead(503);
        res.end(JSON.stringify({ reason: "unavailable" }));
      } else {
        res.end(JSON.stringify(data));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const config = path.join(directory, `${mode}.json`);
    await writeFile(config, JSON.stringify({
      origin: `http://127.0.0.1:${server.address().port}`,
      t3Home: directory,
      t3Command: [process.execPath, authScript],
    }));
    try {
      const result = await exec(process.execPath, [path.join(build, "cli.js"), "--config", config, "--json", "request", "get", "/snapshot"],
        { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }).then(
          value => ({ ...value, code: 0 }),
          error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }),
        );
      expect(authorized).toBe(true);
      if (mode === "large") {
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        const envelope = JSON.parse(result.stdout);
        expect(envelope.ok).toBe(true);
        expect(envelope.data.response).toEqual(data);
      } else {
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: {
          code: mode === "truncated" ? "T3_REQUEST_FAILED" : "T3_API_ERROR",
        } });
      }
      expect(result.stdout + result.stderr).not.toContain("fixture-token");
      const calls = (await readFile(authLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls).toHaveLength(2);
      expect(calls[0].slice(0, 3)).toEqual(["auth", "session", "issue"]);
      expect(calls[1].slice(0, 4)).toEqual(["auth", "session", "revoke", "fixture-session"]);
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });
}
