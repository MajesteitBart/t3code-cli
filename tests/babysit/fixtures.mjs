// Builders for babysit helper tests. Nothing here touches GitHub, T3, or a real home directory.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { main } from "../../skills/babysit/scripts/babysit.mjs";

export const HEAD = "a".repeat(40);
export const OLD_HEAD = "b".repeat(40);
export const BASE = "c".repeat(40);
export const REVIEWER = "chatgpt-codex-connector";
export const PR_URL = "https://github.com/acme/widgets/pull/5";

export function check(name, overrides = {}) {
  return {
    kind: "check_run",
    id: `check:${name}`,
    name,
    status: "COMPLETED",
    conclusion: "SUCCESS",
    state: null,
    required: true,
    app: "github-actions",
    url: `https://github.com/acme/widgets/actions/runs/${encodeURIComponent(name)}`,
    ...overrides,
  };
}

export function review(overrides = {}) {
  return {
    id: "review-1",
    author: REVIEWER,
    state: "COMMENTED",
    commitSha: HEAD,
    submittedAt: "2026-10-07T09:50:00Z",
    lastEditedAt: null,
    bodySha256: "body-1",
    url: `${PR_URL}#pullrequestreview-1`,
    ...overrides,
  };
}

export function comment(overrides = {}) {
  return {
    id: "comment-1",
    author: "someone",
    createdAt: "2026-10-07T09:40:00Z",
    lastEditedAt: null,
    bodySha256: "comment-body-1",
    url: `${PR_URL}#issuecomment-1`,
    ...overrides,
  };
}

export function thread(overrides = {}) {
  return {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: "src/app.ts",
    line: 12,
    comments: [comment({ id: "thread-comment-1", author: REVIEWER, url: `${PR_URL}#discussion_r1` })],
    ...overrides,
  };
}

/** A complete snapshot of an open pull request whose checks pass and whose head has a reviewer review. */
export function snapshot(pr = {}, extra = {}) {
  return {
    complete: true,
    error: null,
    pr: {
      number: 5,
      url: PR_URL,
      state: "OPEN",
      isDraft: false,
      headSha: HEAD,
      baseSha: BASE,
      baseRef: "main",
      headRef: "feat/widgets",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      updatedAt: "2026-10-07T09:58:00Z",
      autoMerge: null,
      mergeCommitSha: null,
      contexts: [check("ci / test")],
      reviews: [review()],
      threads: [],
      comments: [],
      reactions: [],
      rollupState: "SUCCESS",
      finalRollupState: "SUCCESS",
      ...pr,
    },
    finalCore: null,
    viewer: "agent-account",
    rateLimit: { remaining: 4000, resetAt: "2026-10-07T11:00:00Z" },
    fetchedAt: Date.parse("2026-10-07T10:00:00Z"),
    requests: 2,
    ...extra,
  };
}

export function failedSnapshot(code = "GITHUB_FETCH_FAILED", detail = "network down") {
  return { complete: false, error: { code, detail }, pr: null, finalCore: null, viewer: null, rateLimit: null, fetchedAt: Date.parse("2026-10-07T10:00:00Z"), requests: 1 };
}

/** Policy and evidence under which `snapshot()` is ready. */
export function watchState(overrides = {}) {
  return {
    prKey: "github.com/acme/widgets#5",
    pr: { host: "github.com", owner: "acme", repo: "widgets", number: 5, url: PR_URL },
    policy: { codeReviewers: [REVIEWER], securityCheckPatterns: [], requiredChecks: [], requireTestedHead: true },
    tested: { sha: HEAD, result: "pass", commands: ["pnpm check"], at: "2026-10-07T09:45:00Z" },
    reviewRequests: [],
    reviewEvidence: [{ head: HEAD, url: "https://chatgpt.com/codex/tasks/task_1", note: "Task finished at this head with no findings.", at: "2026-10-07T09:55:00Z" }],
    findingDecisions: {},
    ...overrides,
  };
}

export function codes(inspection) {
  return inspection.reasons.map((reason) => reason.code);
}

export function cliOk(request, extra = {}) {
  return {
    exitCode: 0,
    timedOut: false,
    stdout: JSON.stringify({
      ok: true,
      data: {
        message: { messageId: `message:${request.args[request.args.indexOf("--idempotency-key") + 1]}` },
        verification: { accepted: true },
        command: { commandId: "command-1" },
        idempotency: { deduplicated: "unknown" },
        ...extra,
      },
    }),
    stderr: "",
  };
}

export function cliError(code, exitCode = 4, message = "failed") {
  return { exitCode, timedOut: false, stdout: "", stderr: JSON.stringify({ ok: false, error: { code, message } }) };
}

/**
 * Runs helper commands against a temporary state directory, a fake clock, scripted GitHub snapshots,
 * and a scripted t3code CLI.
 */
export async function harness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "babysit-test-"));
  const stateDir = path.join(directory, "state");
  let clock = Date.parse("2026-10-07T10:00:00Z");
  const snapshots = [];
  const cliResults = [];
  const fetches = [];
  const sends = [];
  const deps = {
    now: () => clock,
    env: { PATH: "/usr/bin:/bin" },
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    helperPath: "C:\\skills\\babysit\\scripts\\babysit.mjs",
    bundledCli: path.join(directory, "dist", "cli.js"),
    homedir: directory,
    cwd: directory,
    pid: process.pid,
    hostname: "test-host",
    isAlive: () => true,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    fileExists: async () => true,
    fetchSnapshot: async (ref, state) => {
      fetches.push({ ref, policy: state.policy });
      const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
      if (!next) throw new Error("No scripted snapshot.");
      return structuredClone(typeof next === "function" ? next() : next);
    },
    runCli: async (request) => {
      sends.push(request);
      const next = cliResults.shift();
      return typeof next === "function" ? next(request) : (next ?? cliOk(request));
    },
    stdout: () => {},
    stderr: () => {},
  };
  return {
    directory,
    stateDir,
    deps,
    snapshots,
    cliResults,
    fetches,
    sends,
    advance: (milliseconds) => {
      clock += milliseconds;
    },
    now: () => clock,
    run: async (argv) => {
      const { exitCode, envelope } = await main([...argv, "--state-dir", stateDir], deps);
      return { code: exitCode, ...envelope };
    },
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
