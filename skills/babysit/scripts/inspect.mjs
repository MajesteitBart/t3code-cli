import { cleanText, loginKey, sha256, stableStringify } from "./util.mjs";

export const INSPECTION_SCHEMA = "babysit.inspection/1";

export const REVIEW_CAVEAT =
  "A review submitted at this head proves only that it was submitted. GitHub has no marker for an exhaustive review, so readiness also needs review evidence recorded for this exact head (record --review-evidence).";
export const MERGE_GUARD = "This inspection is news, not merge approval. Re-read the live pull request and verify every gate immediately before merging.";

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const SKIPPED_CONCLUSIONS = new Set(["SKIPPED", "NEUTRAL"]);
const SUBMITTED_REVIEW_STATES = new Set(["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]);
const MERGEABLE_STATES = new Set(["CLEAN", "HAS_HOOKS"]);
/** Reviewer priorities an agent may defer on its own. P0, P1, and unrated findings need the user. */
export const DEFERRABLE_SEVERITIES = new Set(["P2", "P3"]);

/** What the agent should do about a reason, for the reasons agents have stalled on. */
const TRIAGE =
  "Triage open findings by severity: fix P0/P1; fix a P2/P3 only when you already push a commit for another reason and the fix is small and safe, otherwise decide --decision deferred.";
const NEXT_ACTIONS = {
  REVIEW_NOT_REQUESTED:
    "No review of this head is submitted or requested. Unless the automatic review on PR open is still running, comment `@codex review` once now and record it with record --review-request.",
  REVIEW_NOT_REQUESTED_REPAIRED:
    "This repaired head has no review and none is requested, and a push does not trigger one. Comment `@codex review` once now and record it with record --review-request.",
  REVIEW_COMPLETION_UNCORROBORATED: "A review of this head was submitted. Confirm the review task finished, then record --review-evidence.",
  FINDING_UNRESOLVED: TRIAGE,
  FINDING_REOPENED: TRIAGE,
  TESTED_HEAD_MISSING: "Run the verification commands at this head and record --tested.",
  TESTED_HEAD_MISMATCH: "Run the verification commands at this head and record --tested.",
  BRANCH_BEHIND: "Update the branch from its base, verify, and push.",
  CONFLICTS: "Resolve the conflicts with the base, verify, and push.",
};

function nextActions(reasons, repairedHead) {
  return [...new Set(reasons.map((reason) => NEXT_ACTIONS[reason.code === "REVIEW_NOT_REQUESTED" && repairedHead ? "REVIEW_NOT_REQUESTED_REPAIRED" : reason.code]).filter(Boolean))];
}

/**
 * A finding's priority: the badge on its first comment, and only when a configured reviewer wrote it.
 * A badge quoted by anyone else does not rate the finding.
 */
export function findingSeverity(thread, policy) {
  const first = thread.comments[0];
  const reviewers = new Set((policy?.codeReviewers ?? []).map(loginKey));
  return first && reviewers.has(loginKey(first.author)) ? (first.severity ?? null) : null;
}

/**
 * Whether a recorded deferral would still be allowed at the finding's current severity. A policy or badge
 * change can make a deferred P2 unrated or P1; the deferral then needs the user's approval for that severity.
 */
function deferralHolds(decision, severity) {
  if (decision.decision !== "deferred" || DEFERRABLE_SEVERITIES.has(severity)) return true;
  return decision.userApproved === true && (decision.severity ?? null) === severity;
}

/** pass, fail, skipped, pending, or unknown. Anything not finished is pending, never complete. */
export function checkOutcome(check) {
  if (check.kind === "status") {
    if (check.state === "SUCCESS") return "pass";
    if (check.state === "PENDING" || check.state === "EXPECTED") return "pending";
    if (check.state === "FAILURE" || check.state === "ERROR") return "fail";
    return "unknown";
  }
  if (check.status !== "COMPLETED") return "pending";
  if (check.conclusion === "SUCCESS") return "pass";
  if (SKIPPED_CONCLUSIONS.has(check.conclusion)) return "skipped";
  if (FAILED_CONCLUSIONS.has(check.conclusion)) return "fail";
  return "unknown";
}

/** The content of a review thread: any new comment, or an edit of one, changes it. */
export function threadVersion(thread) {
  return sha256(thread.comments.map((comment) => `${comment.id}|${comment.bodySha256}|${comment.lastEditedAt ?? ""}`).join("\n"));
}

function commentVersion(comment) {
  return `${comment.bodySha256}|${comment.lastEditedAt ?? ""}`;
}

/** Reactions have no commit or timestamp; evidence must cover their observed set explicitly. */
export function reviewerReactions(pr, policy) {
  const reviewers = new Set((policy.codeReviewers ?? []).map(loginKey));
  return [...new Set((pr.reactions ?? []).flatMap((group) =>
    group.logins.filter((login) => reviewers.has(loginKey(login))).map((login) => `${group.content}:${loginKey(login)}`),
  ))].sort();
}

/** A decision made before an observed resolution cannot discharge a later reopening. */
export function invalidateResolvedDecisions(snapshot, state, at) {
  if (!snapshot.complete || !snapshot.pr) return;
  for (const thread of snapshot.pr.threads) {
    const decision = state.findingDecisions?.[thread.id];
    if (thread.isResolved && decision && !decision.invalidatedAt) decision.invalidatedAt = at;
  }
}

function latest(...times) {
  return times.filter(Boolean).sort().at(-1) ?? null;
}

function prView(core) {
  return {
    number: core.number,
    url: core.url,
    state: core.state,
    isDraft: core.isDraft,
    headSha: core.headSha,
    baseSha: core.baseSha,
    baseRef: core.baseRef,
    headRef: core.headRef,
    mergeable: core.mergeable,
    mergeStateStatus: core.mergeStateStatus,
    reviewDecision: core.reviewDecision,
    autoMerge: core.autoMerge,
    mergeCommitSha: core.mergeCommitSha,
  };
}

function testedView(state, headSha) {
  const tested = state.tested ?? null;
  return { sha: tested?.sha ?? null, result: tested?.result ?? null, matchesHead: tested && headSha ? tested.sha === headSha : null };
}

function emptySections(state, headSha) {
  return {
    ci: { state: "unknown", rollupState: null, checks: [] },
    codeReview: {
      state: "unknown",
      completeness: null,
      caveat: REVIEW_CAVEAT,
      reviewers: [...(state.policy?.codeReviewers ?? [])],
      rounds: null,
      reviewsAtHead: [],
      staleReviews: [],
      requestsAtHead: [],
      evidenceAtHead: [],
      unboundSignals: [],
    },
    securityReview: { state: "unknown", checks: [] },
    findings: { open: [], discharged: [] },
    tested: testedView(state, headSha),
    next: [],
  };
}

export function reasonKey(reason) {
  return reason.subject ? `${reason.code}:${reason.subject}` : reason.code;
}

function hashSummary(summary) {
  return sha256(stableStringify(summary));
}

function checkKey(check) {
  return `${check.kind}:${check.name}:${check.app ?? ""}`;
}

/**
 * Classifies a snapshot from github.mjs against the watch's policy and recorded evidence.
 *
 * Readiness is `ready` only when nothing is blocked, pending, or unknown. Errors, incomplete reads,
 * missing or skipped required checks, unbound review signals, and review submissions without recorded
 * evidence for the exact head all keep it from being ready.
 */
export function classify(snapshot, state) {
  const policy = state.policy ?? {};
  const reviewers = new Set((policy.codeReviewers ?? []).map(loginKey));
  const securityPatterns = (policy.securityCheckPatterns ?? []).map((pattern) => new RegExp(pattern, "iu"));
  const core = snapshot.finalCore ?? snapshot.pr ?? null;
  const base = {
    schema: INSPECTION_SCHEMA,
    fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
    complete: snapshot.complete === true,
    error: snapshot.error ?? null,
    pr: core ? prView(core) : null,
    terminal: null,
    mergeGuard: MERGE_GUARD,
  };

  // The core fields arrive whole in a single response, so merge or closure is reliable even when a later page failed.
  if (core && (core.state === "MERGED" || core.state === "CLOSED")) {
    const terminal = core.state === "MERGED" ? "merged" : "closed";
    const summary = { terminal, headSha: core.headSha, mergeCommitSha: core.mergeCommitSha ?? null };
    return {
      ...base,
      terminal,
      readiness: null,
      reasons: [{ level: "terminal", code: terminal === "merged" ? "PR_MERGED" : "PR_CLOSED_UNMERGED" }],
      ...emptySections(state, core.headSha),
      summary,
      newsKey: hashSummary(summary),
      fingerprint: hashSummary(summary),
    };
  }

  if (!base.complete || !snapshot.pr) {
    const error = snapshot.error ?? { code: "FETCH_INCOMPLETE", detail: null };
    return {
      ...base,
      readiness: "unknown",
      reasons: [{ level: "unknown", code: error.code, ...(error.detail ? { detail: cleanText(error.detail, 200) } : {}) }],
      ...emptySections(state, core?.headSha ?? null),
      summary: null,
      newsKey: null,
      fingerprint: null,
    };
  }

  const pr = { ...snapshot.pr, ...(snapshot.finalCore ?? {}) };
  const head = pr.headSha;
  const reasons = [];
  const add = (level, code, subject, detail) =>
    reasons.push({ level, code, ...(subject ? { subject: cleanText(subject, 120) } : {}), ...(detail ? { detail: cleanText(detail, 200) } : {}) });

  // Pull request state
  if (pr.isDraft) add("blocked", "DRAFT");
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") add("blocked", "CONFLICTS");
  else if (pr.mergeable !== "MERGEABLE" || pr.mergeStateStatus === "UNKNOWN" || pr.mergeStateStatus == null) add("pending", "MERGEABILITY_COMPUTING");
  if (pr.mergeStateStatus === "BEHIND") add("blocked", "BRANCH_BEHIND");
  if (pr.reviewDecision === "CHANGES_REQUESTED") add("blocked", "CHANGES_REQUESTED");
  if (pr.reviewDecision === "REVIEW_REQUIRED") add("blocked", "HUMAN_APPROVAL_REQUIRED");

  // Checks
  const requiredChecks = new Set(policy.requiredChecks ?? []);
  const checks = pr.contexts.map((context) => ({
    ...context,
    required: requiredChecks.has(context.name) ? true : context.required,
    outcome: checkOutcome(context),
    security: securityPatterns.some((pattern) => pattern.test(context.name) || (context.app ? pattern.test(context.app) : false)),
    reviewer: context.app != null && reviewers.has(loginKey(context.app)),
  }));
  for (const check of checks) {
    switch (check.outcome) {
      case "pending":
        add("pending", check.reviewer ? "REVIEW_CHECK_IN_PROGRESS" : "CHECK_PENDING", check.name);
        break;
      case "fail":
        if (check.required === true) add("blocked", "REQUIRED_CHECK_FAILED", check.name);
        else if (check.required === false) add("unknown", "OPTIONAL_CHECK_FAILED", check.name);
        else add("unknown", "CHECK_FAILED_REQUIREMENT_UNKNOWN", check.name);
        break;
      case "skipped":
        if (check.required === true) add("unknown", "REQUIRED_CHECK_SKIPPED", check.name);
        else if (check.required !== false) add("unknown", "CHECK_SKIPPED_REQUIREMENT_UNKNOWN", check.name);
        break;
      case "unknown":
        add("unknown", "CHECK_STATE_UNKNOWN", check.name);
        break;
      default:
        if (check.required !== true && check.required !== false) add("unknown", "CHECK_REQUIREMENT_UNKNOWN", check.name);
    }
  }
  for (const name of requiredChecks) {
    if (!checks.some((check) => check.name === name)) add("pending", "REQUIRED_CHECK_MISSING", name);
  }
  if (checks.length === 0) add("unknown", "CI_NONE");
  else if (pr.finalRollupState !== "SUCCESS" && !checks.some((check) => check.outcome === "fail" || check.outcome === "pending")) {
    add("unknown", "CI_ROLLUP_INCONSISTENT", null, `GitHub reports the check rollup as ${pr.finalRollupState ?? "missing"}.`);
  }
  const ciState =
    checks.length === 0
      ? "none"
      : checks.some((check) => check.outcome === "fail")
        ? "failing"
        : checks.some((check) => check.outcome === "pending")
          ? "pending"
          : reasons.some((reason) => reason.level === "unknown" && /CHECK|CI_/u.test(reason.code))
            ? "unknown"
            : "passing";

  // Security review: a finished security check never stands in for a code review.
  const securityChecks = checks.filter((check) => check.security);
  let securityState;
  if (securityPatterns.length === 0) securityState = "not_configured";
  else if (securityChecks.length === 0) {
    securityState = "none";
    add("unknown", "SECURITY_REVIEW_MISSING");
  } else if (securityChecks.some((check) => check.outcome === "fail")) {
    securityState = "failed";
    add("blocked", "SECURITY_REVIEW_FAILED");
  } else if (securityChecks.some((check) => check.outcome === "pending")) {
    securityState = "pending";
    add("pending", "SECURITY_REVIEW_PENDING");
  } else if (securityChecks.some((check) => check.outcome === "unknown" || check.outcome === "skipped")) {
    securityState = "unknown";
    add("unknown", "SECURITY_REVIEW_UNKNOWN");
  } else securityState = "completed";

  // Code review: only a review whose commit is the exact head counts for this head.
  const isReviewer = (login) => reviewers.has(loginKey(login));
  const reviewerReviews = pr.reviews.filter((review) => isReviewer(review.author) && SUBMITTED_REVIEW_STATES.has(review.state));
  const reviewsAtHead = reviewerReviews.filter((review) => review.commitSha === head);
  const staleReviews = reviewerReviews.filter((review) => review.commitSha !== head);
  const requestsAtHead = (state.reviewRequests ?? []).filter((request) => request.head === head);
  const evidenceAtHead = (state.reviewEvidence ?? []).filter((evidence) => evidence.head === head);
  const reviewerComments = pr.comments.filter((comment) => isReviewer(comment.author));
  // Comments and reactions carry no commit, so they are never assigned to a head by their time.
  const unboundSignals = [
    ...reviewerComments.map((comment) => ({ type: "comment", author: comment.author, id: comment.id, url: comment.url, at: latest(comment.createdAt, comment.lastEditedAt) })),
    ...pr.reactions.flatMap((group) =>
      group.logins.filter(isReviewer).map((login) => ({ type: "reaction", author: login, content: group.content })),
    ),
  ];
  if (reviewsAtHead.some((review) => review.state === "CHANGES_REQUESTED")) add("blocked", "REVIEWER_CHANGES_REQUESTED");
  if (evidenceAtHead.length === 0) {
    if (reviewsAtHead.length > 0) add("unknown", "REVIEW_COMPLETION_UNCORROBORATED");
    else if (unboundSignals.length > 0) add("unknown", "REVIEW_EVIDENCE_UNBOUND");
    else if (requestsAtHead.length > 0) add("pending", "REVIEW_REQUESTED_AWAITING");
    else add("pending", "REVIEW_NOT_REQUESTED");
  } else {
    // Times only ever withdraw evidence here; they never attach anything to a head.
    const recordedAt = Math.max(...evidenceAtHead.map((evidence) => Date.parse(evidence.at)));
    const activity = [
      ...reviewsAtHead.map((review) => latest(review.submittedAt, review.lastEditedAt)),
      ...reviewerComments.map((comment) => latest(comment.createdAt, comment.lastEditedAt)),
      ...pr.threads.flatMap((thread) => thread.comments.filter((comment) => isReviewer(comment.author)).map((comment) => latest(comment.createdAt, comment.lastEditedAt))),
    ];
    if (!Number.isFinite(recordedAt) || activity.some((time) => time && Date.parse(time) > recordedAt)) add("unknown", "REVIEW_ACTIVITY_AFTER_EVIDENCE");
    const reactions = reviewerReactions(pr, policy);
    const newestEvidence = evidenceAtHead.filter((evidence) => Date.parse(evidence.at) === recordedAt);
    if (pr.reactions.some((group) => group.truncated) || !newestEvidence.some((evidence) =>
      reactions.every((reaction) => (evidence.reactions ?? []).includes(reaction)),
    )) add("unknown", "REVIEW_REACTIONS_AFTER_EVIDENCE");
  }
  const reviewState = reviewsAtHead.length > 0 ? "submitted" : requestsAtHead.length > 0 ? "requested" : unboundSignals.length > 0 ? "unbound_signal" : "none";
  // One round per commit the reviewer submitted a review for.
  const rounds = new Set(reviewerReviews.map((review) => review.commitSha).filter(Boolean)).size;

  // Findings: every unresolved thread blocks until a decision (fixed, refuted, or deferred) matches its current content,
  // and a deferral also its current severity.
  const decisions = state.findingDecisions ?? {};
  const open = [];
  const discharged = [];
  for (const thread of pr.threads) {
    if (thread.isResolved) continue;
    const version = threadVersion(thread);
    const first = thread.comments[0] ?? null;
    const entry = {
      threadId: thread.id,
      author: first?.author ?? null,
      severity: findingSeverity(thread, policy),
      path: thread.path,
      line: thread.line,
      isOutdated: thread.isOutdated,
      url: first?.url ?? null,
      lastCommentAt: latest(...thread.comments.flatMap((comment) => [comment.createdAt, comment.lastEditedAt])),
      comments: thread.comments.length,
      version,
    };
    const decision = decisions[thread.id];
    if (decision && !decision.invalidatedAt && decision.isResolved !== true && decision.threadVersion === version && deferralHolds(decision, entry.severity)) {
      discharged.push({ ...entry, decision: decision.decision, evidence: decision.evidence, commit: decision.commit ?? null });
    } else {
      open.push({ ...entry, reopened: Boolean(decision) });
      const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}${thread.isOutdated ? " (outdated)" : ""}` : null;
      add("blocked", decision ? "FINDING_REOPENED" : "FINDING_UNRESOLVED", thread.id, [entry.severity ?? "unrated", where].filter(Boolean).join(" "));
    }
  }

  // Local verification of this exact head
  const tested = state.tested ?? null;
  if (!tested) add("unknown", "TESTED_HEAD_MISSING");
  else if (tested.sha !== head) add("unknown", "TESTED_HEAD_MISMATCH", null, `tested ${tested.sha.slice(0, 12)}, head ${head.slice(0, 12)}`);
  else if (tested.result !== "pass") add("blocked", "TESTS_FAILED");

  if (reasons.length === 0 && !MERGEABLE_STATES.has(pr.mergeStateStatus)) add("unknown", "MERGE_STATE_UNEXPLAINED", pr.mergeStateStatus ?? "missing");

  const readiness = reasons.some((reason) => reason.level === "blocked")
    ? "blocked"
    : reasons.some((reason) => reason.level === "pending")
      ? "pending"
      : reasons.some((reason) => reason.level === "unknown")
        ? "unknown"
        : "ready";

  // What changed for the agent: in-progress check status is left out, so polls stay quiet.
  const viewer = loginKey(snapshot.viewer);
  const completedChecks = {};
  for (const check of checks) {
    if (check.outcome === "pending") continue;
    const key = checkKey(check);
    const previous = completedChecks[key];
    completedChecks[key] = { name: check.name, outcome: previous ? [previous.outcome, check.outcome].sort().join("+") : check.outcome };
  }
  const summary = {
    terminal: null,
    readiness,
    reasons: [...new Set(reasons.map(reasonKey))].sort(),
    headSha: head,
    baseSha: pr.baseSha,
    reviews: Object.fromEntries(
      pr.reviews
        .filter((review) => review.commitSha === head && review.state !== "PENDING")
        .map((review) => [review.id, { v: `${review.state}|${review.bodySha256}|${review.lastEditedAt ?? ""}`, author: review.author, state: review.state, url: review.url }]),
    ),
    comments: Object.fromEntries(
      pr.comments
        .filter((comment) => !viewer || loginKey(comment.author) !== viewer)
        .map((comment) => [comment.id, { v: commentVersion(comment), author: comment.author, url: comment.url }]),
    ),
    findings: Object.fromEntries([
      ...open.map((finding) => [finding.threadId, { v: finding.version, status: finding.reopened ? "reopened" : "open", url: finding.url }]),
      ...discharged.map((finding) => [finding.threadId, { v: finding.version, status: "discharged", url: finding.url }]),
    ]),
    checks: completedChecks,
    reactions: [...new Set(unboundSignals.filter((signal) => signal.type === "reaction").map((signal) => `${signal.content}:${loginKey(signal.author)}`))].sort(),
  };

  const view = (check) => ({
    kind: check.kind,
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    state: check.state,
    required: check.required,
    app: check.app,
    url: check.url,
    outcome: check.outcome,
    security: check.security,
    reviewer: check.reviewer,
  });
  const reviewView = (review) => ({ id: review.id, author: review.author, state: review.state, commitSha: review.commitSha, submittedAt: review.submittedAt, url: review.url });

  return {
    ...base,
    readiness,
    reasons,
    ci: { state: ciState, rollupState: pr.finalRollupState ?? pr.rollupState ?? null, checks: checks.map(view) },
    codeReview: {
      state: reviewState,
      completeness: evidenceAtHead.length > 0 ? "agent_recorded_evidence" : reviewsAtHead.length > 0 ? "submitted_review_at_head" : null,
      caveat: REVIEW_CAVEAT,
      reviewers: [...(policy.codeReviewers ?? [])],
      rounds,
      reviewsAtHead: reviewsAtHead.map(reviewView),
      staleReviews: staleReviews.map(reviewView),
      requestsAtHead,
      evidenceAtHead,
      unboundSignals,
    },
    securityReview: {
      state: securityState,
      checks: securityChecks.map(view),
      note: "A security check never counts as the code review.",
    },
    findings: { open, discharged },
    tested: testedView(state, head),
    next: nextActions(reasons, staleReviews.length > 0),
    summary,
    newsKey: hashSummary(summary),
    fingerprint: sha256(
      stableStringify({
        summary,
        checks: checks.map((check) => [check.kind, check.name, check.status, check.conclusion, check.state]),
        merge: [pr.mergeable, pr.mergeStateStatus, pr.reviewDecision, pr.updatedAt],
      }),
    ),
  };
}
