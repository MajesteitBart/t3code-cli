import { describe, expect, it } from "vitest";

import { checkOutcome, classify, threadVersion } from "../../skills/babysit/scripts/inspect.mjs";
import { check, codes, comment, failedSnapshot, HEAD, OLD_HEAD, review, REVIEWER, snapshot, thread, watchState } from "./fixtures.mjs";

describe("readiness", () => {
  it("is ready only with passing required checks, a tested head, and review evidence recorded for that head", () => {
    const inspection = classify(snapshot(), watchState());

    expect(inspection.readiness).toBe("ready");
    expect(inspection.reasons).toEqual([]);
    expect(inspection.codeReview).toMatchObject({ state: "submitted", completeness: "agent_recorded_evidence" });
    expect(inspection.codeReview.caveat).toMatch(/only that it was submitted/u);
    expect(inspection.mergeGuard).toMatch(/not merge approval/u);
  });

  it("keeps the code review pending while only the security review has finished", () => {
    // ownkey-keyboard #20: a completed security row was mistaken for the code review.
    const state = watchState({ policy: { codeReviewers: [REVIEWER], securityCheckPatterns: ["security"], requiredChecks: [] }, reviewEvidence: [] });
    const inspection = classify(
      snapshot({
        contexts: [
          check("ci / test"),
          check("Codex security review", { app: REVIEWER, required: false }),
          check("Codex code review", { app: REVIEWER, status: "IN_PROGRESS", conclusion: null, required: false }),
        ],
        reviews: [],
      }),
      state,
    );

    expect(inspection.readiness).toBe("pending");
    expect(inspection.securityReview.state).toBe("completed");
    expect(inspection.codeReview.state).toBe("none");
    expect(codes(inspection)).toEqual(expect.arrayContaining(["REVIEW_CHECK_IN_PROGRESS", "REVIEW_NOT_REQUESTED"]));
  });

  it("never counts a review or evidence of an earlier head", () => {
    const inspection = classify(
      snapshot({ reviews: [review({ commitSha: OLD_HEAD })] }),
      watchState({ reviewEvidence: [{ head: OLD_HEAD, url: "https://chatgpt.com/codex/tasks/old", note: "clean", at: "2026-10-07T09:55:00Z" }] }),
    );

    expect(inspection.readiness).not.toBe("ready");
    expect(inspection.codeReview.reviewsAtHead).toEqual([]);
    expect(inspection.codeReview.staleReviews).toHaveLength(1);
    expect(inspection.codeReview.evidenceAtHead).toEqual([]);
    expect(codes(inspection)).toContain("REVIEW_NOT_REQUESTED");
  });

  it("reports a reviewer thumbs-up and comment without a commit as unbound, never as a head review", () => {
    const inspection = classify(
      snapshot({
        reviews: [],
        reactions: [{ content: "THUMBS_UP", logins: [REVIEWER], totalCount: 1, truncated: false }],
        comments: [comment({ author: REVIEWER })],
      }),
      watchState({ reviewEvidence: [], reviewRequests: [{ head: HEAD, url: "https://github.com/acme/widgets/pull/5#issuecomment-9", at: "2026-10-07T09:30:00Z" }] }),
    );

    expect(inspection.readiness).toBe("unknown");
    expect(inspection.codeReview.state).toBe("requested");
    expect(inspection.codeReview.unboundSignals).toHaveLength(2);
    expect(codes(inspection)).toContain("REVIEW_EVIDENCE_UNBOUND");
  });

  it("does not treat a submitted head review as complete without recorded evidence", () => {
    const inspection = classify(snapshot(), watchState({ reviewEvidence: [] }));

    expect(inspection.readiness).toBe("unknown");
    expect(inspection.codeReview.completeness).toBe("submitted_review_at_head");
    expect(codes(inspection)).toEqual(["REVIEW_COMPLETION_UNCORROBORATED"]);
  });

  it("withdraws recorded evidence when the reviewer is active again afterwards", () => {
    const inspection = classify(snapshot({ reviews: [review(), review({ id: "review-2", submittedAt: "2026-10-07T09:59:00Z" })] }), watchState());

    expect(inspection.readiness).toBe("unknown");
    expect(codes(inspection)).toContain("REVIEW_ACTIVITY_AFTER_EVIDENCE");
  });

  it("matches reviewer logins without case or the [bot] suffix", () => {
    const inspection = classify(snapshot({ reviews: [review({ author: "ChatGPT-Codex-Connector" })] }), watchState({ policy: { codeReviewers: [`${REVIEWER}[bot]`] } }));

    expect(inspection.codeReview.reviewsAtHead).toHaveLength(1);
    expect(inspection.readiness).toBe("ready");
  });

  it("blocks on changes requested by the reviewer at the head", () => {
    const inspection = classify(snapshot({ reviews: [review({ state: "CHANGES_REQUESTED" })] }), watchState());

    expect(inspection.readiness).toBe("blocked");
    expect(codes(inspection)).toContain("REVIEWER_CHANGES_REQUESTED");
  });
});

describe("checks", () => {
  it("treats queued and running checks as pending, not finished", () => {
    for (const status of ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED", null]) {
      expect(checkOutcome(check("x", { status, conclusion: null }))).toBe("pending");
    }
    const inspection = classify(snapshot({ contexts: [check("ci / test", { status: "QUEUED", conclusion: null })] }), watchState());
    expect(inspection.readiness).toBe("pending");
    expect(inspection.ci.state).toBe("pending");
  });

  it("is unknown with no checks at all", () => {
    const inspection = classify(snapshot({ contexts: [] }), watchState());

    expect(inspection.readiness).toBe("unknown");
    expect(inspection.ci.state).toBe("none");
    expect(codes(inspection)).toContain("CI_NONE");
  });

  it("blocks on a failed required check and is unknown for a skipped one", () => {
    expect(classify(snapshot({ contexts: [check("ci / test", { conclusion: "FAILURE" })] }), watchState()).readiness).toBe("blocked");
    expect(classify(snapshot({ contexts: [check("ci / test", { kind: "status", status: null, conclusion: null, state: "ERROR" })] }), watchState()).readiness).toBe("blocked");

    const skipped = classify(snapshot({ contexts: [check("ci / test", { conclusion: "SKIPPED" })] }), watchState());
    expect(skipped.readiness).toBe("unknown");
    expect(codes(skipped)).toContain("REQUIRED_CHECK_SKIPPED");
  });

  it("is unknown when a check's requirement or an optional check's failure is unexplained", () => {
    const unknownRequirement = classify(snapshot({ contexts: [check("ci / test", { required: null })] }), watchState());
    expect(unknownRequirement.readiness).toBe("unknown");
    expect(codes(unknownRequirement)).toContain("CHECK_REQUIREMENT_UNKNOWN");

    const optional = classify(snapshot({ contexts: [check("ci / test"), check("lint", { required: false, conclusion: "FAILURE" })], finalRollupState: "FAILURE" }), watchState());
    expect(optional.readiness).toBe("unknown");
    expect(codes(optional)).toContain("OPTIONAL_CHECK_FAILED");
  });

  it("waits for a required check named in the policy that has not reported", () => {
    const inspection = classify(snapshot(), watchState({ policy: { codeReviewers: [REVIEWER], requiredChecks: ["ci / e2e"] } }));

    expect(inspection.readiness).toBe("pending");
    expect(inspection.reasons).toContainEqual({ level: "pending", code: "REQUIRED_CHECK_MISSING", subject: "ci / e2e" });
  });

  it.each([
    ["SKIPPED", "unknown", "REQUIRED_CHECK_SKIPPED"],
    ["NEUTRAL", "unknown", "REQUIRED_CHECK_SKIPPED"],
    ["FAILURE", "blocked", "REQUIRED_CHECK_FAILED"],
  ])("enforces policy-required %s checks even when GitHub reports them as optional", (conclusion, readiness, reason) => {
    const inspection = classify(
      snapshot({ contexts: [check("ci / test", { required: false, conclusion })] }),
      watchState({ policy: { codeReviewers: [REVIEWER], requiredChecks: ["ci / test"] } }),
    );

    expect(inspection.readiness).toBe(readiness);
    expect(codes(inspection)).toContain(reason);
    expect(inspection.ci.checks[0].required).toBe(true);
  });

  it("is unknown when GitHub's rollup disagrees with the checks it listed", () => {
    const inspection = classify(snapshot({ finalRollupState: "FAILURE" }), watchState());

    expect(inspection.readiness).toBe("unknown");
    expect(codes(inspection)).toContain("CI_ROLLUP_INCONSISTENT");
  });
});

describe("findings", () => {
  it("blocks on unresolved threads, including outdated ones", () => {
    const inspection = classify(snapshot({ threads: [thread(), thread({ id: "thread-2", isOutdated: true }), thread({ id: "thread-3", isResolved: true })] }), watchState());

    expect(inspection.readiness).toBe("blocked");
    expect(inspection.findings.open.map((finding) => finding.threadId)).toEqual(["thread-1", "thread-2"]);
    expect(inspection.reasons.filter((reason) => reason.code === "FINDING_UNRESOLVED")).toHaveLength(2);
  });

  it("discharges a finding whose decision matches the thread's current content, and reopens it on a new or edited comment", () => {
    const open = thread();
    const decision = { decision: "refuted", evidence: "The input is validated in parse().", threadVersion: threadVersion(open), at: "2026-10-07T09:56:00Z" };
    const state = watchState({ findingDecisions: { "thread-1": decision } });

    const discharged = classify(snapshot({ threads: [open] }), state);
    expect(discharged.readiness).toBe("ready");
    expect(discharged.findings.discharged).toHaveLength(1);

    const replied = thread({ comments: [...open.comments, comment({ id: "thread-comment-2", author: "someone-else" })] });
    const reopened = classify(snapshot({ threads: [replied] }), state);
    expect(reopened.readiness).toBe("blocked");
    expect(codes(reopened)).toContain("FINDING_REOPENED");
    expect(reopened.findings.open[0].reopened).toBe(true);

    const edited = thread({ comments: [{ ...open.comments[0], bodySha256: "edited", lastEditedAt: "2026-10-07T09:57:00Z" }] });
    expect(codes(classify(snapshot({ threads: [edited] }), state))).toContain("FINDING_REOPENED");
  });
});

describe("tested head and pull request state", () => {
  it.each([
    [{ mergeStateStatus: "BLOCKED" }, "unknown", "MERGE_STATE_UNEXPLAINED"],
    [{ reviewDecision: "REVIEW_REQUIRED" }, "blocked", "HUMAN_APPROVAL_REQUIRED"],
    [{ isDraft: true }, "blocked", "DRAFT"],
    [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, "blocked", "CONFLICTS"],
  ])("uses the final merge gates when the head, base, state, and updatedAt stay unchanged: %j", (gates, readiness, reason) => {
    const initial = snapshot();
    const { contexts, reviews, threads, comments, reactions, rollupState, finalRollupState, ...core } = initial.pr;
    const inspection = classify({ ...initial, finalCore: { ...core, ...gates } }, watchState());

    expect(inspection.readiness).toBe(readiness);
    expect(codes(inspection)).toContain(reason);
    expect(inspection.pr).toMatchObject(gates);
    expect(inspection.ci.checks).toHaveLength(contexts.length);
    expect(inspection.codeReview.reviewsAtHead).toHaveLength(reviews.length);
  });

  it("is not ready when the tested commit is not the head, and blocks when tests failed at the head", () => {
    const mismatch = classify(snapshot(), watchState({ tested: { sha: OLD_HEAD, result: "pass", commands: ["pnpm check"] } }));
    expect(mismatch.readiness).toBe("unknown");
    expect(codes(mismatch)).toContain("TESTED_HEAD_MISMATCH");

    expect(codes(classify(snapshot(), watchState({ tested: null })))).toContain("TESTED_HEAD_MISSING");
    expect(classify(snapshot(), watchState({ tested: { sha: HEAD, result: "fail", commands: ["pnpm check"] } })).readiness).toBe("blocked");
  });

  it("blocks drafts, conflicts, and required human approval, and waits while mergeability is computed", () => {
    expect(codes(classify(snapshot({ isDraft: true }), watchState()))).toContain("DRAFT");
    expect(codes(classify(snapshot({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), watchState()))).toContain("CONFLICTS");
    expect(codes(classify(snapshot({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" }), watchState()))).toContain("HUMAN_APPROVAL_REQUIRED");
    expect(classify(snapshot({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }), watchState()).readiness).toBe("pending");
  });

  it("is unknown when GitHub blocks the merge for a reason it did not show", () => {
    const inspection = classify(snapshot({ mergeStateStatus: "BLOCKED" }), watchState());

    expect(inspection.readiness).toBe("unknown");
    expect(codes(inspection)).toEqual(["MERGE_STATE_UNEXPLAINED"]);
  });
});

describe("incomplete reads and terminal states", () => {
  it("is unknown, with no news key, when the read failed or was cut short", () => {
    for (const code of ["GITHUB_FETCH_FAILED", "PAGINATION_LIMIT", "SNAPSHOT_CHANGED", "GITHUB_AUTH_FAILED"]) {
      const inspection = classify(failedSnapshot(code), watchState());
      expect(inspection.readiness).toBe("unknown");
      expect(inspection.newsKey).toBeNull();
      expect(codes(inspection)).toEqual([code]);
    }
    const partial = classify({ ...snapshot(), complete: false, error: { code: "COUNT_MISMATCH", detail: "changed" } }, watchState());
    expect(partial.readiness).toBe("unknown");
  });

  it("reports a merge or closure even when a later page failed", () => {
    const merged = classify(snapshot({ state: "MERGED", mergeCommitSha: "d".repeat(40) }), watchState());
    expect(merged).toMatchObject({ terminal: "merged", readiness: null });

    const closedDuringRead = classify(
      { ...snapshot(), complete: false, error: { code: "SNAPSHOT_CHANGED", detail: null }, finalCore: { ...snapshot().pr, state: "CLOSED" } },
      watchState(),
    );
    expect(closedDuringRead).toMatchObject({ terminal: "closed", readiness: null });
    expect(codes(closedDuringRead)).toEqual(["PR_CLOSED_UNMERGED"]);
  });
});

describe("news keys", () => {
  it("changes when a comment is edited in place, but not for the agent's own comments or check progress", () => {
    const base = classify(snapshot({ comments: [comment({ author: REVIEWER })] }), watchState());
    const edited = classify(snapshot({ comments: [comment({ author: REVIEWER, bodySha256: "rewritten", lastEditedAt: "2026-10-07T09:59:00Z" })] }), watchState());
    expect(edited.newsKey).not.toBe(base.newsKey);

    const plain = classify(snapshot(), watchState());
    const own = classify(snapshot({ comments: [comment({ author: "agent-account" })] }), watchState());
    expect(own.newsKey).toBe(plain.newsKey);

    const queued = classify(snapshot({ contexts: [check("ci / test"), check("e2e", { status: "QUEUED", conclusion: null })] }), watchState());
    const running = classify(snapshot({ contexts: [check("ci / test"), check("e2e", { status: "IN_PROGRESS", conclusion: null })] }), watchState());
    expect(running.newsKey).toBe(queued.newsKey);
    expect(running.fingerprint).not.toBe(queued.fingerprint);
  });

  it("is stable for equal input", () => {
    expect(classify(snapshot(), watchState()).newsKey).toBe(classify(snapshot(), watchState()).newsKey);
  });
});
