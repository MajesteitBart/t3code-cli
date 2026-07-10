import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { launchT3CodeHandover } from "./launchT3CodeHandover.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("launchT3CodeHandover", () => {
  it("passes options as arguments and the prompt over stdin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "t3code-button-"));
    cleanup.push(root);
    const recordPath = path.join(root, "record.json");
    const fakeCli = path.join(root, "fake-cli.mjs");
    await writeFile(
      fakeCli,
      `import { writeFileSync } from "node:fs";
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(process.env.T3CODE_BUTTON_RECORD, JSON.stringify({ args: process.argv.slice(2), prompt }));
process.stdout.write(JSON.stringify({ ok: true, data: { project: { id: "project-1" }, thread: { id: "thread-1" }, opened: { kind: "none", exactThread: false, url: null } } }));
`,
      "utf8",
    );

    const previousRecord = process.env.T3CODE_BUTTON_RECORD;
    process.env.T3CODE_BUTTON_RECORD = recordPath;
    try {
      const result = await launchT3CodeHandover({
        cwd: root,
        prompt: "Continue safely & literally",
        command: [process.execPath, fakeCli],
        open: "none",
        provider: "codex",
        model: "gpt-5.6-sol",
        speed: "fast",
        thinkingEffort: "xhigh",
        permission: "full-access",
        mode: "plan",
        checkout: "current",
      });
      const record = JSON.parse(await readFile(recordPath, "utf8"));

      expect(result.data.thread.id).toBe("thread-1");
      expect(record.prompt).toBe("Continue safely & literally");
      expect(record.args).toEqual([
        "--json",
        "handover",
        "--cwd",
        path.resolve(root),
        "--stdin",
        "--open",
        "none",
        "--provider",
        "codex",
        "--model",
        "gpt-5.6-sol",
        "--speed",
        "fast",
        "--thinking-effort",
        "xhigh",
        "--permission",
        "full-access",
        "--mode",
        "plan",
        "--checkout",
        "current",
      ]);
    } finally {
      if (previousRecord === undefined) delete process.env.T3CODE_BUTTON_RECORD;
      else process.env.T3CODE_BUTTON_RECORD = previousRecord;
    }
  });

  it("surfaces the CLI error envelope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "t3code-button-error-"));
    cleanup.push(root);
    const fakeCli = path.join(root, "fake-error.mjs");
    await writeFile(
      fakeCli,
      `process.stderr.write(JSON.stringify({ ok: false, error: { code: "NOPE", message: "Handover rejected." } })); process.exitCode = 1;`,
      "utf8",
    );

    await expect(
      launchT3CodeHandover({
        cwd: root,
        prompt: "Handover",
        command: [process.execPath, fakeCli],
      }),
    ).rejects.toThrow("Handover rejected.");
  });
});
