// The release threshold: severity-rated findings, deferral, review rounds, and next actions.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reviewSeverity } from "../../skills/babysit/scripts/github.mjs";
import { classify, threadVersion } from "../../skills/babysit/scripts/inspect.mjs";
import { recordObservation } from "../../skills/babysit/scripts/wake.mjs";
import { codes, comment, harness, HEAD, OLD_HEAD, PR_URL, review, REVIEWER, snapshot, thread, watchState } from "./fixtures.mjs";

const PR = ["--pr", "acme/widgets#5"];

/** A review thread whose first comment carries Codex's priority badge. */
function rated(id, severity, overrides = {}) {
  return thread({
    id,
    comments: [comment({ id: `${id}-c1`, author: REVIEWER, severity, url: `${PR_URL}#discussion_${id}` })],
    ...overrides,
  });
}

describe("reviewSeverity", () => {
  it("reads the Codex priority badge and nothing else", () => {
    expect(reviewSeverity("**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Scope the lookup**")).toBe("P2");
    expect(reviewSeverity("![P0 Badge](x) Data loss")).toBe("P0");
    expect(reviewSeverity("This mentions P1 but has no badge.")).toBeNull();
    expect(reviewSeverity("![P7 Badge](x)")).toBeNull();
    expect(reviewSeverity(null)).toBeNull();
    // A badge buried deep in a reply is not the finding's rating.
    expect(reviewSeverity(`${"x".repeat(400)} ![P0 Badge](x)`)).toBeNull();
  });
});

describe("classify", () => {
  it("reports each open finding's severity in the finding and its reason", () => {
    const inspection = classify(snapshot({ threads: [rated("thread-1", "P1"), rated("thread-2", "P2"), rated("thread-3", null)] }), watchState());

    expect(inspection.readiness).toBe("blocked");
    expect(inspection.findings.open.map((finding) => [finding.threadId, finding.severity])).toEqual([
      ["thread-1", "P1"],
      ["thread-2", "P2"],
      ["thread-3", null],
    ]);
    expect(inspection.reasons.filter((reason) => reason.code === "FINDING_UNRESOLVED").map((reason) => reason.detail)).toEqual([
      "P1 src/app.ts:12",
      "P2 src/app.ts:12",
      "unrated src/app.ts:12",
    ]);
    expect(inspection.next.some((action) => /decide --decision deferred/u.test(action))).toBe(true);
  });

  it("ignores a priority badge that someone other than the reviewer wrote", () => {
    const quoted = thread({ id: "thread-1", comments: [comment({ id: "thread-1-c1", author: "some-human", severity: "P3" })] });
    const inspection = classify(snapshot({ threads: [quoted] }), watchState());

    expect(inspection.findings.open[0].severity).toBeNull();
  });

  it("still discharges decisions recorded before severities existed", () => {
    const open = rated("thread-1", "P2");
    const state = watchState({ findingDecisions: { "thread-1": { decision: "fixed", evidence: "Fixed.", threadVersion: threadVersion(open), at: "2026-10-07T09:56:00Z" } } });

    expect(classify(snapshot({ threads: [open] }), state).readiness).toBe("ready");
  });

  it("asks for a review of a repaired head without the opening-review caveat", () => {
    const opening = classify(snapshot({ reviews: [] }), watchState({ reviewEvidence: [] }));
    expect(opening.next.join(" ")).toMatch(/automatic review on PR open/u);
    const repaired = classify(snapshot({ reviews: [review({ commitSha: OLD_HEAD })] }), watchState({ reviewEvidence: [] }));
    expect(repaired.next.join(" ")).toMatch(/repaired head/u);
  });

  it("treats a deferred finding as decided, so it does not block readiness", () => {
    const open = rated("thread-1", "P2");
    const state = watchState({
      findingDecisions: { "thread-1": { decision: "deferred", evidence: "Follow-up in #14.", severity: "P2", threadVersion: threadVersion(open), at: "2026-10-07T09:56:00Z" } },
    });
    const inspection = classify(snapshot({ threads: [open] }), state);

    expect(inspection.readiness).toBe("ready");
    expect(inspection.findings.discharged).toMatchObject([{ threadId: "thread-1", decision: "deferred", severity: "P2" }]);
  });

  it("counts one review round per commit the reviewer reviewed", () => {
    const reviews = [
      review({ id: "r1", commitSha: OLD_HEAD }),
      review({ id: "r2", commitSha: OLD_HEAD }),
      review({ id: "r3", commitSha: HEAD }),
      review({ id: "r4", author: "someone-else", commitSha: "d".repeat(40) }),
    ];
    expect(classify(snapshot({ reviews }), watchState()).codeReview.rounds).toBe(2);
  });

  it("tells the agent to request a review when a repaired head has none", () => {
    const inspection = classify(snapshot({ reviews: [review({ commitSha: OLD_HEAD })] }), watchState({ reviewEvidence: [] }));

    expect(codes(inspection)).toContain("REVIEW_NOT_REQUESTED");
    expect(inspection.next.some((action) => /`@codex review`/u.test(action))).toBe(true);
  });

  it("has no next action when the pull request is ready", () => {
    expect(classify(snapshot(), watchState()).next).toEqual([]);
  });
});

describe("wake text", () => {
  it("summarizes open findings by severity, deferrals, rounds, and next actions", () => {
    const state = {
      ...watchState({ reviewEvidence: [] }),
      delivery: { type: "t3-thread", threadId: "thread-a", wakeSettled: false, cliPath: "/opt/t3code/dist/cli.js" },
      events: [],
      lastObservation: null,
      baselineSummary: null,
      health: { consecutiveFailures: 0 },
    };
    const context = { now: () => Date.parse("2026-10-07T10:00:00Z"), command: (name) => `helper ${name}` };
    const { event } = recordObservation(state, classify(snapshot({ threads: [rated("thread-1", "P1"), rated("thread-2", "P2"), rated("thread-3", "P2")] }), state), context);

    expect(event.text).toContain("Open findings: 3 (1 P1, 2 P2); deferred: 0;");
    expect(event.text).toContain("Review rounds so far: 1.");
    expect(event.text).toMatch(/Next:\n- /u);
  });
});

describe("decide --decision deferred", () => {
  let h;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.remove();
  });

  async function setup(threads) {
    h.snapshots.splice(0, h.snapshots.length, snapshot({ threads }));
    expect((await h.run(["init", ...PR, "--code-reviewer", REVIEWER, "--thread", "thread-a", "--wake-settled"])).code).toBe(0);
    expect((await h.run(["record", ...PR, "--tested", HEAD, "--result", "pass", "--command", "pnpm check"])).code).toBe(0);
    expect((await h.run(["record", ...PR, "--review-evidence", "--head", HEAD, "--url", "https://chatgpt.com/codex/tasks/task_1", "--note", "Review finished."])).code).toBe(0);
  }

  it("defers several P2/P3 findings in one call and then reports ready", async () => {
    await setup([rated("thread-1", "P2"), rated("thread-2", "P3")]);

    const decided = await h.run(["decide", ...PR, "--finding", "thread-1", "--finding", "thread-2", "--decision", "deferred", "--evidence", "Non-blocking; follow-up in #14."]);
    expect(decided).toMatchObject({ code: 0, data: { findings: [{ threadId: "thread-1", decision: "deferred", severity: "P2" }, { threadId: "thread-2", severity: "P3" }] } });

    const inspection = (await h.run(["inspect", ...PR])).data.inspection;
    expect(inspection.readiness).toBe("ready");
    expect(inspection.findings.discharged.map((finding) => finding.decision)).toEqual(["deferred", "deferred"]);
  });

  it("refuses to defer P0, P1, or unrated findings without the user's approval, and records nothing from a refused batch", async () => {
    await setup([rated("thread-1", "P2"), rated("thread-2", "P1"), rated("thread-3", null)]);

    const refused = await h.run(["decide", ...PR, "--finding", "thread-1", "--finding", "thread-2", "--decision", "deferred", "--evidence", "Later."]);
    expect(refused).toMatchObject({ code: 4, error: { code: "DEFERRAL_NEEDS_USER", details: { finding: "thread-2", severity: "P1" } } });
    expect((await h.run(["inspect", ...PR])).data.inspection.findings.discharged).toEqual([]);

    expect((await h.run(["decide", ...PR, "--finding", "thread-3", "--decision", "deferred", "--evidence", "Later."])).error.code).toBe("DEFERRAL_NEEDS_USER");

    const approved = await h.run(["decide", ...PR, "--finding", "thread-2", "--finding", "thread-3", "--decision", "deferred", "--user-approved", "--evidence", "Bart approved deferring these to #15."]);
    expect(approved).toMatchObject({ code: 0, data: { findings: [{ threadId: "thread-2", userApproved: true }, { threadId: "thread-3", userApproved: true }] } });
  });

  it("marks only the findings that needed approval as user-approved", async () => {
    await setup([rated("thread-1", "P1"), rated("thread-2", "P2")]);

    const decided = await h.run(["decide", ...PR, "--finding", "thread-1", "--finding", "thread-2", "--decision", "deferred", "--user-approved", "--evidence", "Approved for #15."]);
    expect(decided.data.findings.map((finding) => finding.userApproved ?? false)).toEqual([true, false]);
  });

  it("refuses to defer a badge quoted by someone other than the reviewer", async () => {
    await setup([thread({ id: "thread-1", comments: [comment({ id: "thread-1-c1", author: "some-human", severity: "P3" })] })]);

    expect((await h.run(["decide", ...PR, "--finding", "thread-1", "--decision", "deferred", "--evidence", "Later."])).error.code).toBe("DEFERRAL_NEEDS_USER");
  });

  it("records nothing when a batch names an unknown thread", async () => {
    await setup([rated("thread-1", "P2")]);

    expect((await h.run(["decide", ...PR, "--finding", "thread-1", "--finding", "thread-9", "--decision", "deferred", "--evidence", "Later."])).error.code).toBe("FINDING_NOT_FOUND");
    expect((await h.run(["inspect", ...PR])).data.inspection.findings.discharged).toEqual([]);
  });

  it("reopens a deferred P2 that the reviewer re-rates P1, and then needs approval to defer", async () => {
    await setup([rated("thread-1", "P2")]);
    expect((await h.run(["decide", ...PR, "--finding", "thread-1", "--decision", "deferred", "--evidence", "Follow-up in #14."])).code).toBe(0);

    const rerated = rated("thread-1", "P1");
    rerated.comments[0] = { ...rerated.comments[0], bodySha256: "edited", lastEditedAt: "2026-10-07T10:05:00Z" };
    h.snapshots.splice(0, h.snapshots.length, snapshot({ threads: [rerated] }));
    const inspection = (await h.run(["inspect", ...PR])).data.inspection;
    expect(inspection.reasons).toContainEqual(expect.objectContaining({ code: "FINDING_REOPENED", detail: "P1 src/app.ts:12" }));
    expect((await h.run(["decide", ...PR, "--finding", "thread-1", "--decision", "deferred", "--evidence", "Later."])).error.code).toBe("DEFERRAL_NEEDS_USER");
  });

  it("accepts --user-approved only with a deferral", async () => {
    await setup([rated("thread-1", "P1")]);

    const result = await h.run(["decide", ...PR, "--finding", "thread-1", "--decision", "fixed", "--user-approved", "--evidence", "Fixed."]);
    expect(result).toMatchObject({ code: 2, error: { code: "INVALID_USAGE" } });
  });

  it("reopens a deferred finding when the reviewer comments again", async () => {
    await setup([rated("thread-1", "P2")]);
    expect((await h.run(["decide", ...PR, "--finding", "thread-1", "--decision", "deferred", "--evidence", "Follow-up in #14."])).code).toBe(0);

    const replied = rated("thread-1", "P2");
    replied.comments.push(comment({ id: "thread-1-c2", author: REVIEWER }));
    h.snapshots.splice(0, h.snapshots.length, snapshot({ threads: [replied] }));
    expect(codes((await h.run(["inspect", ...PR])).data.inspection)).toContain("FINDING_REOPENED");
  });
});
