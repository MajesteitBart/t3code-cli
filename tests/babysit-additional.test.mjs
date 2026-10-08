import { describe, expect, it } from "vitest";
import { classify } from "../skills/babysit/scripts/inspect.mjs";
import { classifyCliResult } from "../skills/babysit/scripts/wake.mjs";
import { redeliveryOf } from "../skills/babysit/scripts/wake.mjs";
import { scheduleCommands } from "../skills/babysit/scripts/schedule.mjs";
import { main } from "../skills/babysit/scripts/babysit.mjs";
import { harness, snapshot as fixtureSnapshot, REVIEWER, PR_URL, comment } from "./babysit/fixtures.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const state = () => ({
  policy: { codeReviewers: ["chatgpt-codex-connector[bot]"], securityCheckPatterns: [] },
  tested: { sha: HEAD, result: "pass" }, reviewRequests: [], findingDecisions: {},
  reviewEvidence: [{ head: HEAD, at: "2026-10-07T12:00:00Z", url: "https://example.com/review-task", note: "Verified exact head and completed task" }],
});

describe("durable recovery and scheduling guards", () => {
  it("preserves redelivery identity after history pruning and names the new ack event", () => {
    const original = { id: "evt_original", status: "delivered", text: "news\nAfter handling it: ack --event evt_original" };
    const s = { prKey: "owner/repo#1", pr: { owner: "owner", repo: "repo", number: 1 }, events: [original] };
    const context = { now: () => 1000, command: (name, args) => [name, ...args].join(" ") };
    const first = redeliveryOf(s, original.id, context);
    expect(first.text).toContain("ack --event evt_original.r1");
    expect(first.text).not.toContain("After handling it: ack --event evt_original\n");
    s.events = [original]; // Acknowledged history can be pruned.
    const second = redeliveryOf(s, original.id, context);
    expect(second.id).toBe("evt_original.r2");
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });
  it("stops an already merged PR at initialization and does no future API read", async () => {
    const h = await harness();
    try {
      h.snapshots.push(fixtureSnapshot({ state: "MERGED", mergeCommitSha: BASE }));
      expect((await h.run(["init", "--pr", PR_URL, "--code-reviewer", REVIEWER])).ok).toBe(true);
      const stopped = await h.run(["tick", "--pr", PR_URL]);
      expect(stopped.data.skipped).toBe("stopped");
      expect(h.fetches).toHaveLength(1);
      expect(h.sends).toHaveLength(0);
    } finally { await h.remove(); }
  });
  it("persists the configured delivery instance without persisting tokens", async () => {
    const h = await harness();
    try {
      h.deps.env.T3CODE_CLI_ORIGIN = "http://127.0.0.1:3999";
      h.deps.env.T3CODE_CLI_CONFIG = "isolated-config.json";
      h.deps.env.T3_AUTH_TOKEN = "must-never-be-saved";
      h.snapshots.push(fixtureSnapshot(), fixtureSnapshot({ comments: [comment()] }));
      await h.run(["init", "--pr", PR_URL, "--code-reviewer", REVIEWER, "--thread", "target"]);
      await h.run(["tick", "--pr", PR_URL]);
      expect(h.sends[0].env).toMatchObject({ T3CODE_CLI_ORIGIN: "http://127.0.0.1:3999" });
      expect(h.sends[0].env.T3CODE_CLI_CONFIG).toContain("isolated-config.json");
      expect(JSON.stringify(h.sends[0].env)).not.toContain("must-never-be-saved");
    } finally { await h.remove(); }
  });
  it("provides help without accessing state, GitHub, or T3", async () => {
    const result = await main(["--help"], { stdout: () => {}, stderr: () => {}, fetchSnapshot: () => { throw Error("must not run"); } });
    expect(result.exitCode).toBe(0);
    expect(result.envelope.data.commands.tick).toContain("pr");
  });
  it("generates replaceable schedules and rejects inaccurate cron intervals", () => {
    const options = { execPath: "node", helperPath: "helper.mjs", stateDir: "state", statePath: "state/pr.json", state: { prKey: "acme/widgets#5", pr: { owner: "acme", repo: "widgets", number: 5 } }, intervalMinutes: 5, env: {} };
    const windows = scheduleCommands({ ...options, platform: "win32" });
    expect(windows.register).toContain("CreateFolder('babysit')");
    expect(windows.register).toContain("-Force");
    expect(windows.register).toContain("-WindowStyle Hidden");
    expect(scheduleCommands({ ...options, platform: "linux" }).register).toContain("grep -vF");
    expect(() => scheduleCommands({ ...options, platform: "linux", intervalMinutes: 7 })).toThrow(/divide 60/u);
  });
});
const snapshot = () => ({
  complete: true, fetchedAt: Date.parse("2026-10-07T12:01:00Z"), viewer: "owner",
  pr: {
    state: "OPEN", number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: false,
    headSha: HEAD, baseSha: BASE, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
    finalRollupState: "SUCCESS", rollupState: "SUCCESS",
    contexts: [{ kind: "check_run", name: "tests", status: "COMPLETED", conclusion: "SUCCESS", required: true, app: "github-actions" }],
    reviews: [{ id: "review-1", author: "chatgpt-codex-connector", commitSha: HEAD, state: "APPROVED", submittedAt: "2026-10-07T11:00:00Z" }],
    reactions: [], threads: [], comments: [],
  },
});

describe("additional historical failure guards", () => {
  it("matches REST-style bot configuration to GitHub GraphQL's bot login", () => {
    expect(classify(snapshot(), state()).readiness).toBe("ready");
  });
  it("requires corroboration even for an approved review at the exact head", () => {
    const s = state(); s.reviewEvidence = [];
    const result = classify(snapshot(), s);
    expect(result.readiness).toBe("unknown");
    expect(result.reasons.some((reason) => reason.code === "REVIEW_COMPLETION_UNCORROBORATED")).toBe(true);
  });
  it("reports an unbound thumbs-up as unknown instead of completion", () => {
    const p = snapshot(); p.pr.reviews = []; p.pr.reactions = [{ content: "THUMBS_UP", logins: ["chatgpt-codex-connector"] }];
    const s = state(); s.reviewEvidence = [];
    expect(classify(p, s).readiness).toBe("unknown");
  });
  it("does not count a skipped security check as completed security review", () => {
    const p = snapshot(); p.pr.contexts.push({ kind: "check_run", name: "security", status: "COMPLETED", conclusion: "SKIPPED", required: false });
    const s = state(); s.policy.securityCheckPatterns = ["security"];
    const result = classify(p, s);
    expect(result.securityReview.state).toBe("unknown");
    expect(result.readiness).toBe("unknown");
  });
  it("keeps a queued code-review check pending despite a passed security check", () => {
    const p = snapshot(); p.pr.contexts.push({ kind: "check_run", name: "Code review", status: "QUEUED", conclusion: null, required: false, app: "chatgpt-codex-connector" });
    p.pr.contexts.push({ kind: "check_run", name: "security", status: "COMPLETED", conclusion: "SUCCESS", required: false });
    p.pr.finalRollupState = "PENDING";
    const s = state(); s.policy.securityCheckPatterns = ["security"];
    expect(classify(p, s).readiness).toBe("pending");
  });
  it("does not accept a claimed CLI success without explicit verification", () => {
    const output = (verification) => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, data: { message: { messageId: "message-1" }, verification } }) });
    expect(classifyCliResult(output(undefined)).result).toBe("ambiguous");
    expect(classifyCliResult(output({ accepted: false })).result).toBe("ambiguous");
    expect(classifyCliResult(output({ accepted: true })).result).toBe("ok");
  });
});
