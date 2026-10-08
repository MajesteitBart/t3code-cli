import { execFile } from "node:child_process";

import { cleanText, sha256 } from "./util.mjs";

/** The whole read, every page included, must finish within this budget. */
export const DEFAULT_FETCH_BUDGET_MS = 120_000;
export const DEFAULT_MAX_REQUESTS = 50;
const CALL_TIMEOUT_MS = 30_000;
const PAGE = 100;
const THREAD_PAGE = 50;

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const CONTEXT_NODES = `nodes {
  __typename
  ... on CheckRun { id name status conclusion isRequired(pullRequestNumber: $number) detailsUrl checkSuite { app { slug } } }
  ... on StatusContext { id context state isRequired(pullRequestNumber: $number) targetUrl }
}`;
const REVIEW_NODES = "nodes { id author { login } state submittedAt lastEditedAt body url commit { oid } }";
const COMMENT_NODES = "nodes { id author { login } body createdAt lastEditedAt url }";
const THREAD_NODES = `nodes { id isResolved isOutdated path line originalLine comments(first: ${PAGE}) { totalCount ${PAGE_INFO} ${COMMENT_NODES} } }`;
const CORE =
  "number url state isDraft headRefOid baseRefOid baseRefName headRefName mergeable mergeStateStatus reviewDecision updatedAt autoMergeRequest { enabledAt mergeMethod } mergeCommit { oid }";
const PR_VARIABLES = "$owner: String!, $name: String!, $number: Int!";
const onPullRequest = (body) => `repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${body} } }`;

export const QUERIES = {
  main: `query(${PR_VARIABLES}) {
  viewer { login }
  rateLimit { remaining resetAt }
  ${onPullRequest(`${CORE}
    reactionGroups { content reactors(first: ${PAGE}) { totalCount nodes { ... on Actor { login } } } }
    commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: ${PAGE}) { totalCount ${PAGE_INFO} ${CONTEXT_NODES} } } } } }
    reviews(first: ${PAGE}) { totalCount ${PAGE_INFO} ${REVIEW_NODES} }
    reviewThreads(first: ${THREAD_PAGE}) { totalCount ${PAGE_INFO} ${THREAD_NODES} }
    comments(first: ${PAGE}) { totalCount ${PAGE_INFO} ${COMMENT_NODES} }`)}
}`,
  contexts: `query(${PR_VARIABLES}, $after: String!) {
  ${onPullRequest(`commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: ${PAGE}, after: $after) { totalCount ${PAGE_INFO} ${CONTEXT_NODES} } } } } }`)}
}`,
  reviews: `query(${PR_VARIABLES}, $after: String!) {
  ${onPullRequest(`reviews(first: ${PAGE}, after: $after) { totalCount ${PAGE_INFO} ${REVIEW_NODES} }`)}
}`,
  threads: `query(${PR_VARIABLES}, $after: String!) {
  ${onPullRequest(`reviewThreads(first: ${THREAD_PAGE}, after: $after) { totalCount ${PAGE_INFO} ${THREAD_NODES} }`)}
}`,
  comments: `query(${PR_VARIABLES}, $after: String!) {
  ${onPullRequest(`comments(first: ${PAGE}, after: $after) { totalCount ${PAGE_INFO} ${COMMENT_NODES} }`)}
}`,
  threadComments: `query($id: ID!, $after: String!) {
  node(id: $id) { ... on PullRequestReviewThread { comments(first: ${PAGE}, after: $after) { totalCount ${PAGE_INFO} ${COMMENT_NODES} } } }
}`,
  core: `query(${PR_VARIABLES}) {
  rateLimit { remaining resetAt }
  ${onPullRequest(`${CORE} commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 1) { totalCount } } } } }`)}
}`,
};

/** Why a read is incomplete. Any of these makes readiness unknown. */
class Incomplete extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ?? code);
    this.code = code;
    this.detail = detail ?? null;
    this.extra = extra;
  }
}

function classifyGhFailure(stderr) {
  if (/rate limit/iu.test(stderr)) return "GITHUB_RATE_LIMITED";
  if (/HTTP 401|bad credentials|gh auth login|not logged in|authentication/iu.test(stderr)) return "GITHUB_AUTH_FAILED";
  return "GITHUB_FETCH_FAILED";
}

/**
 * Runs GraphQL through the `gh` CLI, which keeps its own credentials. Arguments go straight to the
 * process, with no shell, and no token passes through this helper.
 */
export function ghRunner({ ghPath = "gh", host = "github.com", execFileImpl = execFile, env = process.env } = {}) {
  return (query, variables, { timeoutMs }) =>
    new Promise((resolve) => {
      const args = ["api", "graphql"];
      if (host !== "github.com") args.push("--hostname", host);
      args.push("-f", `query=${query.replace(/\s+/gu, " ").trim()}`);
      for (const [name, value] of Object.entries(variables)) {
        // -F converts numbers; -f keeps strings raw, so an owner such as "123" stays a string.
        args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
      }
      execFileImpl(
        ghPath,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
          env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
        },
        (error, stdout, stderr) => {
          let body = null;
          try {
            body = stdout ? JSON.parse(stdout) : null;
          } catch {
            body = null;
          }
          if (!error) {
            resolve(body ? { status: "ok", body } : { status: "error", code: "GITHUB_INVALID_RESPONSE", detail: "gh returned no JSON." });
            return;
          }
          if (error.code === "ENOENT") {
            resolve({ status: "error", code: "GH_NOT_FOUND", detail: `Could not run ${ghPath}; install the GitHub CLI or pass --gh.` });
            return;
          }
          if (error.killed || error.signal) {
            resolve({ status: "error", code: "GITHUB_TIMEOUT", detail: `gh did not answer within ${timeoutMs} ms.` });
            return;
          }
          // gh exits 1 when GraphQL reports errors; the caller reads them from the body.
          if (Array.isArray(body?.errors)) {
            resolve({ status: "ok", body });
            return;
          }
          const text = String(stderr ?? "");
          resolve({ status: "error", code: classifyGhFailure(text), detail: cleanText(text, 300) || "gh failed without a message." });
        },
      );
    });
}

function normalizeCore(raw) {
  if (typeof raw?.headRefOid !== "string" || typeof raw?.baseRefOid !== "string" || typeof raw?.state !== "string") {
    throw new Incomplete("GITHUB_INVALID_RESPONSE", "GitHub returned a pull request without its head, base, or state.");
  }
  return {
    number: raw.number,
    url: typeof raw.url === "string" ? raw.url : null,
    state: raw.state,
    isDraft: raw.isDraft === true,
    headSha: raw.headRefOid.toLowerCase(),
    baseSha: raw.baseRefOid.toLowerCase(),
    baseRef: raw.baseRefName ?? null,
    headRef: raw.headRefName ?? null,
    mergeable: raw.mergeable ?? null,
    mergeStateStatus: raw.mergeStateStatus ?? null,
    reviewDecision: raw.reviewDecision ?? null,
    updatedAt: raw.updatedAt ?? null,
    autoMerge: raw.autoMergeRequest ? { enabledAt: raw.autoMergeRequest.enabledAt ?? null, mergeMethod: raw.autoMergeRequest.mergeMethod ?? null } : null,
    mergeCommitSha: raw.mergeCommit?.oid ?? null,
  };
}

function required(value) {
  return typeof value === "boolean" ? value : null;
}

function normalizeContext(node) {
  if (node.__typename === "StatusContext") {
    return {
      kind: "status",
      id: node.id ?? null,
      name: cleanText(node.context, 200),
      status: null,
      conclusion: null,
      state: node.state ?? null,
      required: required(node.isRequired),
      app: null,
      url: node.targetUrl ?? null,
    };
  }
  if (node.__typename === "CheckRun") {
    return {
      kind: "check_run",
      id: node.id ?? null,
      name: cleanText(node.name, 200),
      status: node.status ?? null,
      conclusion: node.conclusion ?? null,
      state: null,
      required: required(node.isRequired),
      app: node.checkSuite?.app?.slug ?? null,
      url: node.detailsUrl ?? null,
    };
  }
  throw new Incomplete("GITHUB_INVALID_RESPONSE", `GitHub returned an unknown check type ${cleanText(node.__typename, 60)}.`);
}

// Bodies are hashed, not kept: edits stay detectable, and no comment text reaches state or wake messages.
// The one exception is a review comment's priority badge, reduced to P0-P3.
function normalizeReview(node) {
  return {
    id: node.id,
    author: node.author?.login ?? null,
    state: node.state ?? null,
    commitSha: node.commit?.oid?.toLowerCase() ?? null,
    submittedAt: node.submittedAt ?? null,
    lastEditedAt: node.lastEditedAt ?? null,
    bodySha256: sha256(node.body ?? ""),
    url: node.url ?? null,
  };
}

/**
 * The priority badge a Codex review comment opens with, such as `![P2 Badge](…)`: P0 to P3, or null.
 * Only an opening badge counts, inside the bold and `<sub>` wrappers Codex puts around it. A badge quoted
 * in prose, a blockquote, or code does not rate the finding. Only this token is kept, never the text around it.
 */
export function reviewSeverity(body) {
  const match = /^\s*(?:(?:\*\*|__|<(?:sub|sup|b|strong)>)\s*)*!\[(P[0-3]) Badge\]\(/u.exec(String(body ?? ""));
  return match ? match[1] : null;
}

function normalizeComment(node) {
  return {
    id: node.id,
    author: node.author?.login ?? null,
    createdAt: node.createdAt ?? null,
    lastEditedAt: node.lastEditedAt ?? null,
    bodySha256: sha256(node.body ?? ""),
    severity: reviewSeverity(node.body),
    url: node.url ?? null,
  };
}

function normalizeReactions(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => {
    const logins = (group?.reactors?.nodes ?? []).flatMap((node) => (typeof node?.login === "string" ? [node.login] : []));
    const totalCount = typeof group?.reactors?.totalCount === "number" ? group.reactors.totalCount : logins.length;
    return { content: group?.content ?? null, logins, totalCount, truncated: totalCount > logins.length };
  });
}

/** Reads every page of a connection and checks the item count GitHub reported. */
async function collect(connection, fetchNext) {
  if (!connection) throw new Incomplete("CONNECTION_UNREADABLE", "GitHub omitted a list it should have returned.");
  const total = connection.totalCount;
  const items = [];
  let page = connection;
  for (;;) {
    if (!Array.isArray(page.nodes) || page.nodes.some((node) => node == null)) {
      throw new Incomplete("NODE_UNREADABLE", "GitHub returned an item it could not read.");
    }
    items.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage) break;
    const cursor = page.pageInfo.endCursor;
    if (typeof cursor !== "string" || cursor.length === 0) throw new Incomplete("PAGINATION_FAILED", "GitHub returned no cursor for the next page.");
    page = await fetchNext(cursor);
    if (!page) throw new Incomplete("PAGINATION_FAILED", "GitHub returned no next page.");
  }
  if (typeof total === "number" && items.length !== total) {
    throw new Incomplete("COUNT_MISMATCH", `GitHub reported ${total} items but returned ${items.length}; the list changed while it was read.`);
  }
  return items;
}

function coreChanged(before, after) {
  return before.headSha !== after.headSha || before.baseSha !== after.baseSha || before.state !== after.state || before.updatedAt !== after.updatedAt;
}

/**
 * Reads a pull request with every page of its checks, reviews, review threads, thread comments, and
 * comments, then reads its core fields again. The result is `complete` only when every page arrived,
 * every count matched, and nothing moved during the read; a mixed snapshot is never complete.
 */
export async function fetchPullRequestSnapshot(ref, options) {
  const now = options.now ?? Date.now;
  const run = options.run;
  const budgetMs = options.budgetMs ?? DEFAULT_FETCH_BUDGET_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const startedAt = now();
  const deadline = startedAt + budgetMs;
  const variables = { owner: ref.owner, name: ref.repo, number: ref.number };
  const result = { complete: false, error: null, pr: null, finalCore: null, viewer: null, rateLimit: null, fetchedAt: startedAt, requests: 0 };

  const call = async (query, callVariables) => {
    if (result.requests >= maxRequests) throw new Incomplete("PAGINATION_LIMIT", `Stopped after ${maxRequests} GitHub requests; the pull request is too large to read whole.`);
    const remaining = deadline - now();
    if (remaining <= 0) throw new Incomplete("GITHUB_TIMEOUT", `Reading the pull request took longer than ${budgetMs} ms.`);
    result.requests += 1;
    let response;
    try {
      response = await run(query, callVariables, { timeoutMs: Math.min(CALL_TIMEOUT_MS, remaining) });
    } catch (error) {
      throw new Incomplete("GITHUB_FETCH_FAILED", cleanText(error?.message ?? error, 300));
    }
    if (response?.status !== "ok") throw new Incomplete(response?.code ?? "GITHUB_FETCH_FAILED", response?.detail ?? null);
    const body = response.body;
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const limited = body.errors.some((error) => error?.type === "RATE_LIMITED");
      throw new Incomplete(limited ? "GITHUB_RATE_LIMITED" : "GITHUB_GRAPHQL_ERROR", cleanText(body.errors.map((error) => error?.message ?? "").join("; "), 300));
    }
    if (!body?.data) throw new Incomplete("GITHUB_INVALID_RESPONSE", "GitHub returned no data.");
    if (body.data.rateLimit) result.rateLimit = { remaining: body.data.rateLimit.remaining ?? null, resetAt: body.data.rateLimit.resetAt ?? null };
    return body.data;
  };
  const pullRequestOf = (data) => data?.repository?.pullRequest ?? null;

  try {
    const data = await call(QUERIES.main, variables);
    result.viewer = data.viewer?.login ?? null;
    const raw = pullRequestOf(data);
    if (!raw) throw new Incomplete("PR_NOT_FOUND", `GitHub has no pull request ${ref.owner}/${ref.repo}#${ref.number} that this account can read.`);
    const core = normalizeCore(raw);
    result.pr = {
      ...core,
      contexts: [],
      reviews: [],
      threads: [],
      comments: [],
      reactions: normalizeReactions(raw.reactionGroups),
      rollupState: null,
      finalRollupState: null,
    };

    const commit = raw.commits?.nodes?.[0]?.commit ?? null;
    if (!commit || typeof commit.oid !== "string") throw new Incomplete("HEAD_COMMIT_UNREADABLE", "GitHub returned no head commit.");
    if (commit.oid.toLowerCase() !== core.headSha) throw new Incomplete("SNAPSHOT_CHANGED", "The head commit changed while the pull request was read.");
    result.pr.rollupState = commit.statusCheckRollup?.state ?? null;
    const contexts = commit.statusCheckRollup
      ? await collect(commit.statusCheckRollup.contexts, async (after) => {
          const pageCommit = pullRequestOf(await call(QUERIES.contexts, { ...variables, after }))?.commits?.nodes?.[0]?.commit;
          if (!pageCommit || String(pageCommit.oid).toLowerCase() !== core.headSha) {
            throw new Incomplete("SNAPSHOT_CHANGED", "The head commit changed while its checks were read.");
          }
          return pageCommit.statusCheckRollup?.contexts ?? null;
        })
      : [];
    result.pr.contexts = contexts.map(normalizeContext);

    const reviews = await collect(raw.reviews, async (after) => pullRequestOf(await call(QUERIES.reviews, { ...variables, after }))?.reviews ?? null);
    result.pr.reviews = reviews.map(normalizeReview);

    const threads = await collect(raw.reviewThreads, async (after) => pullRequestOf(await call(QUERIES.threads, { ...variables, after }))?.reviewThreads ?? null);
    for (const thread of threads) {
      const comments = await collect(thread.comments, async (after) => (await call(QUERIES.threadComments, { id: thread.id, after })).node?.comments ?? null);
      result.pr.threads.push({
        id: thread.id,
        isResolved: thread.isResolved === true,
        isOutdated: thread.isOutdated === true,
        path: thread.path ?? null,
        line: thread.line ?? thread.originalLine ?? null,
        comments: comments.map(normalizeComment),
      });
    }

    const comments = await collect(raw.comments, async (after) => pullRequestOf(await call(QUERIES.comments, { ...variables, after }))?.comments ?? null);
    result.pr.comments = comments.map(normalizeComment);

    const finalRaw = pullRequestOf(await call(QUERIES.core, variables));
    if (!finalRaw) throw new Incomplete("PR_NOT_FOUND", "The pull request could not be read again after its pages.");
    result.finalCore = normalizeCore(finalRaw);
    const finalCommit = finalRaw.commits?.nodes?.[0]?.commit ?? null;
    result.pr.finalRollupState = finalCommit?.statusCheckRollup?.state ?? null;
    if (coreChanged(core, result.finalCore) || String(finalCommit?.oid ?? "").toLowerCase() !== core.headSha) {
      throw new Incomplete("SNAPSHOT_CHANGED", "The pull request changed while it was read; read it again.");
    }
    if ((finalCommit?.statusCheckRollup?.contexts?.totalCount ?? 0) !== result.pr.contexts.length) {
      throw new Incomplete("SNAPSHOT_CHANGED", "The number of checks changed while they were read.");
    }
    result.complete = true;
  } catch (error) {
    result.complete = false;
    result.error =
      error instanceof Incomplete
        ? { code: error.code, detail: error.detail }
        : // A helper bug must not look like a readable pull request either.
          { code: "HELPER_ERROR", detail: cleanText(error?.message ?? error, 300) };
  }
  return result;
}
