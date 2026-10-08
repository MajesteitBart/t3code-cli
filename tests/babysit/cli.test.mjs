import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { quotePowerShell, quoteShell } from "../../skills/babysit/scripts/schedule.mjs";
import { lockPathFor, statePathFor } from "../../skills/babysit/scripts/state.mjs";
import { check, cliError, failedSnapshot, harness, HEAD, snapshot, thread } from "./fixtures.mjs";

const PR = ["--pr", "acme/widgets#5"];
const REVIEWER_LOGIN = "chatgpt-codex-connector[bot]";

let h;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.remove();
});

function script(...snapshots) {
  h.snapshots.splice(0, h.snapshots.length, ...snapshots);
}

function statePath() {
  return statePathFor(h.stateDir, { host: "github.com", owner: "acme", repo: "widgets", number: 5 });
}

async function readStateFile() {
  return JSON.parse(await readFile(statePath(), "utf8"));
}

async function init(extra = ["--thread", "thread-a", "--wake-settled"]) {
  const result = await h.run(["init", ...PR, "--code-reviewer", REVIEWER_LOGIN, ...extra]);
  expect(result.code, JSON.stringify(result.error)).toBe(0);
  return result;
}

/** Records local verification and review evidence for HEAD, so `snapshot()` is ready. */
async function recordReadyEvidence() {
  expect((await h.run(["record", ...PR, "--tested", HEAD, "--result", "pass", "--command", "pnpm check"])).code).toBe(0);
  const evidence = await h.run(["record", ...PR, "--review-evidence", "--head", HEAD, "--url", "https://chatgpt.com/codex/tasks/task_1", "--note", "Task finished with no findings."]);
  expect(evidence.code).toBe(0);
}

describe("init", () => {
  it("requires an explicit code reviewer and writes nothing without one", async () => {
    const result = await h.run(["init", ...PR, "--thread", "thread-a"]);

    expect(result).toMatchObject({ code: 2, ok: false, error: { code: "CODE_REVIEWER_REQUIRED" } });
    await expect(readFile(statePath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records a baseline so the current state is not news later", async () => {
    script(snapshot({ reviews: [] }));
    const result = await init();

    expect(result.data).toMatchObject({ command: "init", created: true, pr: "acme/widgets#5", warnings: [] });
    expect(result.data.delivery).toEqual({ type: "t3-thread", threadId: "thread-a", wakeSettled: true, cliPath: h.deps.bundledCli });
    expect(result.data.inspection.readiness).toBe("pending");
    const tick = await h.run(["tick", ...PR]);
    expect(tick.data.newEvent).toBeNull();
    expect(h.sends).toEqual([]);
  });

  it("refuses to point a live watch at another thread, and finds the same state under any capitalization", async () => {
    script(snapshot());
    await init();

    expect(await h.run(["init", ...PR, "--code-reviewer", REVIEWER_LOGIN, "--thread", "thread-b"])).toMatchObject({ code: 4, error: { code: "STATE_TARGET_CONFLICT" } });
    const again = await h.run(["init", "--pr", "https://github.com/Acme/Widgets/pull/5", "--code-reviewer", REVIEWER_LOGIN, "--thread", "thread-a", "--wake-settled"]);
    expect(again).toMatchObject({ code: 0, data: { created: false } });
  });

  it("warns that a settled thread would reject wakes without --wake-settled", async () => {
    script(snapshot());
    const result = await init(["--thread", "thread-a"]);

    expect(result.data.warnings).toEqual([expect.stringContaining("--wake-settled")]);
  });
});

describe("tick", () => {
  it("delivers news once, never acknowledges it, and leaves acknowledgement to ack", async () => {
    script(snapshot({ reviews: [] }));
    await init();
    await recordReadyEvidence();
    script(snapshot());

    const first = await h.run(["tick", ...PR]);
    expect(first.code).toBe(0);
    expect(first.data.newEvent).toMatchObject({ readiness: "ready", status: "delivered", attempts: 1 });
    expect(first.data.deliveries).toEqual([expect.objectContaining({ result: "ok", eventId: first.data.newEvent.id })]);
    expect(h.sends).toHaveLength(1);
    const state = await readStateFile();
    const event = state.events.at(-1);
    expect(event.status).toBe("delivered");
    expect(h.sends[0].input).toBe(event.text);
    expect(h.sends[0].args).toContain(event.idempotencyKey);
    expect(h.sends[0].args).toContain("--wake-settled");

    const quiet = await h.run(["tick", ...PR]);
    expect(quiet.data).toMatchObject({ newEvent: null, deliveries: [] });
    expect(h.sends).toHaveLength(1);

    const status = await h.run(["status", ...PR]);
    expect(status.data.events.unacknowledged.map((entry) => entry.id)).toEqual([event.id]);

    const acked = await h.run(["ack", ...PR, "--event", event.id, "--note", "Merged after re-checking."]);
    expect(acked.data).toMatchObject({ acknowledged: [{ id: event.id, previousStatus: "delivered", status: "acked" }], unacknowledged: [] });
    expect((await h.run(["ack", ...PR, "--event", "evt_unknown"])).error.code).toBe("EVENT_NOT_FOUND");
  });

  it("exits 3 when T3 rejects a wake, does not retry it, and redelivers only on request", async () => {
    script(snapshot({ reviews: [] }));
    await init();
    script(snapshot());
    h.cliResults.push(cliError("THREAD_COMMAND_REJECTED", 4, "T3 rejected message.dispatch"));

    const rejected = await h.run(["tick", ...PR]);
    expect(rejected).toMatchObject({ code: 3, ok: false, error: { code: "DELIVERY_REJECTED" } });
    expect(rejected.error.details.deliveries[0]).toMatchObject({ result: "rejected", code: "THREAD_COMMAND_REJECTED" });
    const eventId = rejected.error.details.newEvent.id;

    expect((await h.run(["tick", ...PR])).code).toBe(0);
    expect(h.sends).toHaveLength(1);
    expect((await h.run(["status", ...PR])).data.events.rejected.map((entry) => entry.id)).toEqual([eventId]);

    const redelivered = await h.run(["wake", ...PR, "--redeliver", eventId]);
    expect(redelivered).toMatchObject({ code: 0, data: { event: { id: `${eventId}.r1`, redeliveryOf: eventId, status: "delivered" } } });
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1].args.find((arg) => arg.startsWith("babysit:"))).toMatch(new RegExp(`:${eventId}\\.r1$`, "u"));
  });

  it("retries an ambiguous delivery with the same key and text after its backoff", async () => {
    script(snapshot({ reviews: [] }));
    await init();
    script(snapshot());
    h.cliResults.push({ exitCode: null, timedOut: true, stdout: "", stderr: "" });

    const ambiguous = await h.run(["tick", ...PR]);
    expect(ambiguous).toMatchObject({ code: 5, error: { code: "DELIVERY_PENDING_RETRY" } });

    expect((await h.run(["tick", ...PR])).data.deliveries).toEqual([]);
    h.advance(61_000);
    const retried = await h.run(["tick", ...PR]);
    expect(retried.code).toBe(0);
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1].input).toBe(h.sends[0].input);
    expect(h.sends[1].args).toEqual(h.sends[0].args);
  });

  it("skips while a live process holds the lock, and reports a lock held for over an hour", async () => {
    script(snapshot());
    await init();
    const fetches = h.fetches.length;
    const lock = (acquiredAt) => JSON.stringify({ pid: 999_999, hostname: "test-host", token: "someone-else", acquiredAt });
    await writeFile(lockPathFor(statePath()), lock(new Date(h.now() - 60_000).toISOString()));

    expect(await h.run(["tick", ...PR])).toMatchObject({ code: 0, data: { skipped: "locked", lock: { why: "owner-alive" } } });
    await writeFile(lockPathFor(statePath()), lock(new Date(h.now() - 2 * 3_600_000).toISOString()));
    expect(await h.run(["tick", ...PR])).toMatchObject({ code: 4, error: { code: "LOCK_STUCK" } });
    expect(h.fetches).toHaveLength(fetches);
    expect(JSON.parse(await readFile(lockPathFor(statePath()), "utf8")).token).toBe("someone-else");
  });

  it("delivers the merge, stops, and still retries the final wake without reading GitHub", async () => {
    script(snapshot());
    await init();
    script(snapshot({ state: "MERGED", mergeCommitSha: "d".repeat(40) }));
    h.cliResults.push(cliError("T3_RUNTIME_UNAVAILABLE", 1));

    const merged = await h.run(["tick", ...PR]);
    expect(merged).toMatchObject({ code: 5, error: { details: { terminal: "merged", stopped: { reason: "merged" } } } });
    const fetches = h.fetches.length;

    h.advance(61_000);
    const retried = await h.run(["tick", ...PR]);
    expect(retried).toMatchObject({ code: 0, data: { skipped: "stopped", deliveries: [expect.objectContaining({ result: "ok" })] } });
    expect(h.fetches).toHaveLength(fetches);
    expect(h.sends[1].input).toContain("finished: merged");
  });

  it("refuses to tick without a thread to wake", async () => {
    script(snapshot());
    await init([]);

    expect(await h.run(["tick", ...PR])).toMatchObject({ code: 2, error: { code: "NO_DELIVERY_TARGET" } });
  });

  it("leaves a damaged state file alone", async () => {
    script(snapshot());
    await init();
    await writeFile(statePath(), "{ broken");

    expect(await h.run(["tick", ...PR])).toMatchObject({ code: 1, error: { code: "STATE_CORRUPT" } });
    expect(await readFile(statePath(), "utf8")).toBe("{ broken");
  });

  it("backs off until GitHub's rate limit resets", async () => {
    script(snapshot());
    await init();
    const resetAt = new Date(h.now() + 30 * 60_000).toISOString();
    script({ ...failedSnapshot("GITHUB_RATE_LIMITED", "API rate limit exceeded"), rateLimit: { remaining: 0, resetAt } });

    expect((await h.run(["tick", ...PR])).data.nextTickNotBefore).toBe(resetAt);
    const fetches = h.fetches.length;
    expect((await h.run(["tick", ...PR])).data.skipped).toBe("github-backoff");
    expect(h.fetches).toHaveLength(fetches);
  });

  it("marks a recorded watcher verified after its first complete observation", async () => {
    script(snapshot());
    await init();
    await h.run(["record", ...PR, "--watcher", "os-schedule", "--watcher-id", "\\babysit\\task", "--cancel-command", "Unregister-ScheduledTask x"]);
    expect((await h.run(["status", ...PR])).data.watcher.verified).toBe(false);

    await h.run(["tick", ...PR]);
    expect((await h.run(["status", ...PR])).data.watcher).toMatchObject({ verified: true, firstTickHeadSha: HEAD });
  });
});

describe("wait", () => {
  it("returns news to this session and counts the session as its recipient", async () => {
    const base = snapshot({ reviews: [] });
    script(base, base, snapshot({ contexts: [check("ci / test", { conclusion: "FAILURE" })], finalRollupState: "FAILURE" }));
    await init([]);

    const result = await h.run(["wait", ...PR, "--timeout", "10m", "--interval", "60s"]);

    expect(result.code).toBe(0);
    expect(result.data.event).toMatchObject({ readiness: "blocked", status: "delivered" });
    expect(result.data.event.text).toContain("REQUIRED_CHECK_FAILED");
    expect(h.sends).toEqual([]);
    expect(result.data.unacknowledged.map((entry) => entry.id)).toEqual([result.data.event.id]);
  });

  it("times out without news, saying monitoring ends with it", async () => {
    script(snapshot());
    await init([]);

    const result = await h.run(["wait", ...PR, "--timeout", "3m", "--interval", "60s"]);

    expect(result).toMatchObject({ code: 6, error: { code: "WAIT_TIMEOUT" } });
    expect(h.fetches.length).toBeGreaterThanOrEqual(3);
  });
});

describe("decide", () => {
  it("binds a decision to the thread's current content", async () => {
    script(snapshot({ threads: [thread()] }));
    await init();
    await recordReadyEvidence();

    const decided = await h.run(["decide", ...PR, "--finding", "thread-1", "--decision", "refuted", "--evidence", "parse() validates the input."]);
    expect(decided).toMatchObject({ code: 0, data: { finding: { threadId: "thread-1", decision: "refuted", comments: 1 } } });
    expect((await h.run(["inspect", ...PR])).data.inspection).toMatchObject({ readiness: "ready", findings: { open: [], discharged: [{ threadId: "thread-1" }] } });

    expect((await h.run(["decide", ...PR, "--finding", "thread-9", "--decision", "fixed", "--evidence", "x"])).error.code).toBe("FINDING_NOT_FOUND");
    script(failedSnapshot("COUNT_MISMATCH"));
    expect(await h.run(["decide", ...PR, "--finding", "thread-1", "--decision", "fixed", "--evidence", "x"])).toMatchObject({ code: 5, error: { code: "GITHUB_INCOMPLETE" } });
  });
});

describe("record", () => {
  it("binds evidence to an exact full head SHA and a source", async () => {
    script(snapshot());
    await init();

    expect((await h.run(["record", ...PR, "--tested", "abc123", "--result", "pass", "--command", "pnpm check"])).error.code).toBe("FULL_SHA_REQUIRED");
    expect((await h.run(["record", ...PR, "--tested", HEAD, "--result", "pass"])).error.code).toBe("TEST_COMMAND_REQUIRED");
    expect((await h.run(["record", ...PR, "--review-evidence", "--head", HEAD, "--url", "https://chatgpt.com/codex/tasks/1"])).error.code).toBe("VALUE_REQUIRED");
    expect((await h.run(["record", ...PR, "--review-evidence", "--head", HEAD, "--url", "http://example.com", "--note", "x"])).error.code).toBe("INVALID_URL");
    expect((await h.run(["record", ...PR, "--review-request", "--head", HEAD, "--url", "https://github.com/acme/widgets/pull/6#issuecomment-1"])).error.code).toBe("URL_NOT_THIS_PR");
    expect((await h.run(["record", ...PR, "--review-request", "--review-evidence", "--head", HEAD])).error.code).toBe("RECORD_MODE_REQUIRED");
    expect((await h.run(["record", ...PR, "--review-request", "--head", HEAD, "--url", "https://github.com/acme/widgets/pull/5", "--note", "x"])).error.code).toBe("INVALID_USAGE");

    const request = await h.run(["record", ...PR, "--review-request", "--head", HEAD.toUpperCase(), "--url", "https://github.com/acme/widgets/pull/5#issuecomment-42"]);
    expect(request).toMatchObject({ code: 0, data: { recorded: { mode: "review-request", entry: { head: HEAD } }, matchesLastObservedHead: true } });
  });
});

describe("stop and schedule-command", () => {
  it("stops the watch, cancels undelivered wakes, and stops reading GitHub", async () => {
    script(snapshot({ reviews: [] }));
    await init();
    await h.run(["record", ...PR, "--watcher", "os-schedule", "--watcher-id", "\\babysit\\task", "--cancel-command", "Unregister-ScheduledTask x"]);
    script(snapshot());
    h.cliResults.push({ exitCode: null, timedOut: true, stdout: "", stderr: "" });
    await h.run(["tick", ...PR]);

    const stopped = await h.run(["stop", ...PR, "--reason", "cancelled"]);
    expect(stopped.data).toMatchObject({ stopped: { reason: "cancelled" }, watcher: { cancelCommand: "Unregister-ScheduledTask x" } });
    expect(stopped.data.cancelledEvents).toHaveLength(1);

    const fetches = h.fetches.length;
    h.advance(3_600_000);
    expect((await h.run(["tick", ...PR])).data).toMatchObject({ skipped: "stopped", deliveries: [] });
    expect(h.fetches).toHaveLength(fetches);
  });

  it("prints Windows task commands and writes a hidden launcher, without registering anything", async () => {
    script(snapshot());
    await init();

    const result = await h.run(["schedule-command", ...PR, "--interval", "10"]);

    expect(result.code).toBe(0);
    expect(result.data).toMatchObject({ platform: "win32", intervalMinutes: 10, executed: false, launcher: { written: true } });
    expect(result.data.register).toContain("Register-ScheduledTask -TaskPath '\\babysit\\'");
    expect(result.data.register).toContain("-WindowStyle Hidden");
    expect(result.data.register).toContain("-LogonType Interactive");
    expect(result.data.register).toContain("-RepetitionInterval (New-TimeSpan -Minutes 10)");
    expect(result.data.cancel).toMatch(/^Unregister-ScheduledTask .* -Confirm:\$false$/u);
    const launcher = await readFile(result.data.launcher.path, "utf8");
    expect(launcher).toContain(`$tickArgs = @('C:\\skills\\babysit\\scripts\\babysit.mjs', 'tick', '--pr', 'acme/widgets#5', '--state-dir', ${quotePowerShell(h.stateDir)})`);
    expect(result.data.afterRegistering.record).toEqual(expect.arrayContaining(["--watcher", "os-schedule", "--cancel-command", result.data.cancel]));
    expect(h.sends).toEqual([]);
  });

  it("prints a quoted cron line for POSIX systems", async () => {
    script(snapshot());
    await init();
    h.deps.env = { PATH: "/usr/bin:/opt/100%/bin" };

    const result = await h.run(["schedule-command", ...PR, "--platform", "linux"]);

    expect(result.data.launcher).toBeNull();
    expect(result.data.cronLine.startsWith("*/5 * * * * 'env' 'PATH=/usr/bin:/opt/100\\%/bin'")).toBe(true);
    expect(result.data.cronLine).toContain("'acme/widgets#5'");
    expect(result.data.register).toMatch(/\| crontab -$/u);
    expect(result.data.cancel).toContain("grep -vF '# babysit:");
  });

  it("quotes arguments for PowerShell and POSIX shells", () => {
    expect(quotePowerShell("C:\\Users\\o'brien\\$HOME")).toBe("'C:\\Users\\o''brien\\$HOME'");
    expect(quoteShell("it's $(rm -rf /)")).toBe("'it'\\''s $(rm -rf /)'");
  });
});

describe("usage", () => {
  it("reports unknown options, commands, and inspect without a policy", async () => {
    expect((await h.run(["tick", ...PR, "--force"])).error.code).toBe("INVALID_USAGE");
    expect((await h.run(["frobnicate", ...PR])).error.code).toBe("INVALID_USAGE");
    expect((await h.run(["tick", ...PR, "--event", "x"])).error.code).toBe("INVALID_USAGE");
    expect(await h.run(["inspect", ...PR])).toMatchObject({ code: 3, error: { code: "STATE_NOT_FOUND" } });
  });

  it("inspects without state when the policy is given on the command line", async () => {
    script(snapshot());

    const result = await h.run(["inspect", ...PR, "--code-reviewer", REVIEWER_LOGIN]);

    expect(result).toMatchObject({ code: 0, data: { statePath: null, inspection: { complete: true, readiness: "unknown" } } });
    await expect(readFile(statePath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
