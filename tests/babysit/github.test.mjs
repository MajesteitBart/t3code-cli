import { describe, expect, it } from "vitest";

import { fetchPullRequestSnapshot, ghRunner, QUERIES } from "../../skills/babysit/scripts/github.mjs";
import { classify } from "../../skills/babysit/scripts/inspect.mjs";
import { BASE, HEAD, REVIEWER, watchState } from "./fixtures.mjs";

const REF = { host: "github.com", owner: "acme", repo: "widgets", number: 5 };
const RATE = { remaining: 4000, resetAt: "2026-10-07T11:00:00Z" };

function rawCore(overrides = {}) {
  return {
    number: 5,
    url: "https://github.com/acme/widgets/pull/5",
    state: "OPEN",
    isDraft: false,
    headRefOid: HEAD,
    baseRefOid: BASE,
    baseRefName: "main",
    headRefName: "feat/widgets",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    updatedAt: "2026-10-07T09:58:00Z",
    autoMergeRequest: null,
    mergeCommit: null,
    ...overrides,
  };
}

const checkRun = (name, overrides = {}) => ({
  __typename: "CheckRun",
  id: `check:${name}`,
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  isRequired: true,
  detailsUrl: `https://github.com/acme/widgets/actions/${name}`,
  checkSuite: { app: { slug: "github-actions" } },
  ...overrides,
});
const commentNode = (id, overrides = {}) => ({ id, author: { login: "someone" }, body: `body of ${id}`, createdAt: "2026-10-07T09:40:00Z", lastEditedAt: null, url: `https://github.com/acme/widgets/pull/5#${id}`, ...overrides });
const reviewNode = (id, overrides = {}) => ({
  id,
  author: { login: REVIEWER },
  state: "COMMENTED",
  submittedAt: "2026-10-07T09:50:00Z",
  lastEditedAt: null,
  body: `review ${id}`,
  url: `https://github.com/acme/widgets/pull/5#${id}`,
  commit: { oid: HEAD },
  ...overrides,
});

function lists() {
  return {
    contexts: [checkRun("build"), checkRun("test"), { __typename: "StatusContext", id: "status:deploy", context: "deploy", state: "SUCCESS", isRequired: false, targetUrl: null }],
    reviews: [reviewNode("review-1"), reviewNode("review-2"), reviewNode("review-3")],
    threads: [
      { id: "thread-1", isResolved: false, isOutdated: false, path: "a.ts", line: 3, originalLine: 3, comments: [commentNode("t1-c1", { body: "![P1 Badge](https://img.shields.io/badge/P1-orange) body of t1-c1" }), commentNode("t1-c2"), commentNode("t1-c3")] },
      { id: "thread-2", isResolved: true, isOutdated: false, path: "b.ts", line: null, originalLine: 9, comments: [commentNode("t2-c1")] },
      { id: "thread-3", isResolved: true, isOutdated: true, path: "c.ts", line: 1, originalLine: 1, comments: [commentNode("t3-c1")] },
    ],
    comments: [commentNode("comment-1"), commentNode("comment-2"), commentNode("comment-3")],
  };
}

/** A fake GitHub GraphQL endpoint that serves every list two items per page. */
function fakeGitHub(options = {}) {
  const data = options.data ?? lists();
  const calls = [];
  const page = (items, after, extraCount = 0) => {
    const start = after ? Number(after.split(":")[1]) : 0;
    const nodes = items.slice(start, start + 2);
    const end = start + nodes.length;
    return { totalCount: items.length + extraCount, pageInfo: { hasNextPage: end < items.length, endCursor: end < items.length ? `cursor:${end}` : null }, nodes };
  };
  const threadsPage = (after) => {
    const result = page(data.threads, after);
    return { ...result, nodes: result.nodes.map((thread) => ({ ...thread, comments: page(thread.comments) })) };
  };
  const ok = (dataBody) => ({ status: "ok", body: { data: { rateLimit: RATE, ...dataBody } } });
  const onPr = (pullRequest) => ok({ repository: { pullRequest } });
  const run = async (query, variables, { timeoutMs }) => {
    calls.push({ query, variables, timeoutMs });
    const intercepted = options.intercept?.(query, variables, calls.length);
    if (intercepted !== undefined) return intercepted;
    const core = rawCore(options.core?.(query, calls.length) ?? {});
    const commit = (contexts) => ({ nodes: [{ commit: { oid: core.headRefOid, statusCheckRollup: { state: "SUCCESS", contexts } } }] });
    switch (query) {
      case QUERIES.main:
        return ok({
          viewer: { login: "agent-account" },
          repository: {
            pullRequest: {
              ...core,
              reactionGroups: [{ content: "THUMBS_UP", reactors: { totalCount: 1, nodes: [{ login: REVIEWER }] } }],
              commits: commit(page(data.contexts)),
              reviews: page(data.reviews, undefined, options.extraReviews ?? 0),
              reviewThreads: threadsPage(),
              comments: page(data.comments),
            },
          },
        });
      case QUERIES.contexts:
        return onPr({ commits: commit(page(data.contexts, variables.after)) });
      case QUERIES.reviews:
        return onPr({ reviews: page(data.reviews, variables.after, options.extraReviews ?? 0) });
      case QUERIES.threads:
        return onPr({ reviewThreads: threadsPage(variables.after) });
      case QUERIES.comments:
        return onPr({ comments: page(data.comments, variables.after) });
      case QUERIES.threadComments:
        return ok({ node: { comments: page(data.threads.find((thread) => thread.id === variables.id).comments, variables.after) } });
      case QUERIES.core:
        return onPr({ ...core, commits: { nodes: [{ commit: { oid: core.headRefOid, statusCheckRollup: { state: "SUCCESS", contexts: { totalCount: data.contexts.length } } } }] } });
      default:
        throw new Error("unexpected query");
    }
  };
  return { run, calls };
}

describe("fetchPullRequestSnapshot", () => {
  it("reads every page of checks, reviews, review threads, thread comments, and comments", async () => {
    const github = fakeGitHub();
    const snapshot = await fetchPullRequestSnapshot(REF, { run: github.run, now: () => 0 });

    expect(snapshot.error).toBeNull();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.pr.contexts.map((context) => [context.kind, context.name, context.required])).toEqual([
      ["check_run", "build", true],
      ["check_run", "test", true],
      ["status", "deploy", false],
    ]);
    expect(snapshot.pr.reviews).toHaveLength(3);
    expect(snapshot.pr.threads.map((thread) => thread.comments.length)).toEqual([3, 1, 1]);
    expect(snapshot.pr.threads[1].line).toBe(9);
    expect(snapshot.pr.comments).toHaveLength(3);
    expect(snapshot.pr.reactions).toEqual([{ content: "THUMBS_UP", logins: [REVIEWER], totalCount: 1, truncated: false }]);
    expect(snapshot.viewer).toBe("agent-account");
    expect(snapshot.rateLimit).toEqual(RATE);
    // Bodies are hashed, never kept.
    expect(JSON.stringify(snapshot)).not.toContain("body of");
    expect(snapshot.pr.comments[0].bodySha256).toMatch(/^[0-9a-f]{64}$/u);
    // Only the priority badge survives from a body.
    expect(snapshot.pr.threads[0].comments.map((comment) => comment.severity)).toEqual(["P1", null, null]);
    expect(github.calls.map((call) => call.query)).toEqual([
      QUERIES.main,
      QUERIES.contexts,
      QUERIES.reviews,
      QUERIES.threads,
      QUERIES.threadComments,
      QUERIES.comments,
      QUERIES.core,
    ]);
    expect(classify(snapshot, watchState()).complete).toBe(true);
  });

  it("stops at the request limit and reports the read as incomplete", async () => {
    const snapshot = await fetchPullRequestSnapshot(REF, { run: fakeGitHub().run, now: () => 0, maxRequests: 3 });

    expect(snapshot.complete).toBe(false);
    expect(snapshot.error.code).toBe("PAGINATION_LIMIT");
    expect(classify(snapshot, watchState()).readiness).toBe("unknown");
  });

  it("never returns a mixed snapshot when the pull request moves during the read", async () => {
    const pushed = fakeGitHub({ core: (query) => (query === QUERIES.core ? { headRefOid: "d".repeat(40) } : {}) });
    const moved = await fetchPullRequestSnapshot(REF, { run: pushed.run, now: () => 0 });
    expect(moved).toMatchObject({ complete: false, error: { code: "SNAPSHOT_CHANGED" } });
    expect(classify(moved, watchState()).readiness).toBe("unknown");

    const commented = fakeGitHub({ core: (query) => (query === QUERIES.core ? { updatedAt: "2026-10-07T10:01:00Z" } : {}) });
    expect((await fetchPullRequestSnapshot(REF, { run: commented.run, now: () => 0 })).error.code).toBe("SNAPSHOT_CHANGED");

    const merged = fakeGitHub({ core: (query) => (query === QUERIES.core ? { state: "MERGED", mergeCommit: { oid: "e".repeat(40) } } : {}) });
    const snapshot = await fetchPullRequestSnapshot(REF, { run: merged.run, now: () => 0 });
    expect(snapshot.complete).toBe(false);
    expect(classify(snapshot, watchState()).terminal).toBe("merged");
  });

  it("is incomplete when a list's count does not match the items read", async () => {
    const snapshot = await fetchPullRequestSnapshot(REF, { run: fakeGitHub({ extraReviews: 1 }).run, now: () => 0 });

    expect(snapshot).toMatchObject({ complete: false, error: { code: "COUNT_MISMATCH" } });
  });

  it("reports GraphQL errors, rate limits, failed requests, and missing pull requests", async () => {
    const graphqlError = fakeGitHub({ intercept: (query) => (query === QUERIES.reviews ? { status: "ok", body: { errors: [{ message: "Field 'isRequired' is unknown" }] } } : undefined) });
    expect((await fetchPullRequestSnapshot(REF, { run: graphqlError.run, now: () => 0 })).error).toEqual({ code: "GITHUB_GRAPHQL_ERROR", detail: "Field 'isRequired' is unknown" });

    const limited = fakeGitHub({ intercept: () => ({ status: "ok", body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] } }) });
    expect((await fetchPullRequestSnapshot(REF, { run: limited.run, now: () => 0 })).error.code).toBe("GITHUB_RATE_LIMITED");

    const auth = fakeGitHub({ intercept: () => ({ status: "error", code: "GITHUB_AUTH_FAILED", detail: "HTTP 401" }) });
    expect((await fetchPullRequestSnapshot(REF, { run: auth.run, now: () => 0 })).error.code).toBe("GITHUB_AUTH_FAILED");

    const thrown = fakeGitHub({
      intercept: () => {
        throw new Error("socket hang up");
      },
    });
    expect((await fetchPullRequestSnapshot(REF, { run: thrown.run, now: () => 0 })).error).toEqual({ code: "GITHUB_FETCH_FAILED", detail: "socket hang up" });

    const missing = fakeGitHub({ intercept: () => ({ status: "ok", body: { data: { viewer: { login: "x" }, repository: { pullRequest: null } } } }) });
    expect((await fetchPullRequestSnapshot(REF, { run: missing.run, now: () => 0 })).error.code).toBe("PR_NOT_FOUND");
  });

  it("bounds the whole read by its time budget", async () => {
    let clock = 0;
    const github = fakeGitHub();
    const slow = async (...args) => {
      clock += 50_000;
      return await github.run(...args);
    };
    const snapshot = await fetchPullRequestSnapshot(REF, { run: slow, now: () => clock, budgetMs: 120_000 });

    expect(snapshot).toMatchObject({ complete: false, error: { code: "GITHUB_TIMEOUT" } });
    expect(github.calls.every((call) => call.timeoutMs <= 30_000)).toBe(true);
  });
});

describe("ghRunner", () => {
  function fakeExecFile(result) {
    const calls = [];
    const execFileImpl = (file, args, options, callback) => {
      calls.push({ file, args, options });
      const { error = null, stdout = "", stderr = "" } = typeof result === "function" ? result() : result;
      callback(error, stdout, stderr);
    };
    return { calls, execFileImpl };
  }

  it("passes the query and variables as separate arguments, with no shell", async () => {
    const exec = fakeExecFile({ stdout: JSON.stringify({ data: { ok: true } }) });
    const run = ghRunner({ execFileImpl: exec.execFileImpl, env: {} });
    const result = await run("query($owner: String!) {\n  x\n}", { owner: "123", name: "a b; rm -rf /", number: 5 }, { timeoutMs: 1_000 });

    expect(result).toEqual({ status: "ok", body: { data: { ok: true } } });
    const [call] = exec.calls;
    expect(call.file).toBe("gh");
    expect(call.args).toEqual(["api", "graphql", "-f", "query=query($owner: String!) { x }", "-f", "owner=123", "-f", "name=a b; rm -rf /", "-F", "number=5"]);
    expect(call.options).toMatchObject({ timeout: 1_000, windowsHide: true, env: { GH_PROMPT_DISABLED: "1" } });
    expect(call.options.shell).toBeUndefined();
  });

  it("names the host for GitHub Enterprise", async () => {
    const exec = fakeExecFile({ stdout: "{}" });
    await ghRunner({ host: "github.example.com", execFileImpl: exec.execFileImpl, env: {} })("query { x }", {}, { timeoutMs: 1_000 });

    expect(exec.calls[0].args.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.example.com"]);
  });

  it("classifies a missing gh, timeouts, authentication, and rate limits", async () => {
    const outcome = async (result) => await ghRunner({ execFileImpl: fakeExecFile(result).execFileImpl, env: {} })("query { x }", {}, { timeoutMs: 1_000 });

    expect((await outcome({ error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) })).code).toBe("GH_NOT_FOUND");
    expect((await outcome({ error: Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }) })).code).toBe("GITHUB_TIMEOUT");
    expect((await outcome({ error: Object.assign(new Error("exit 1"), { code: 1 }), stderr: "HTTP 401: Bad credentials" })).code).toBe("GITHUB_AUTH_FAILED");
    expect((await outcome({ error: Object.assign(new Error("exit 1"), { code: 1 }), stderr: "API rate limit exceeded" })).code).toBe("GITHUB_RATE_LIMITED");
    expect(await outcome({ error: Object.assign(new Error("exit 1"), { code: 1 }), stdout: JSON.stringify({ errors: [{ message: "bad" }] }) })).toEqual({
      status: "ok",
      body: { errors: [{ message: "bad" }] },
    });
  });
});
