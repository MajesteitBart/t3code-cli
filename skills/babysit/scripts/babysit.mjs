#!/usr/bin/env node
// Deterministic PR babysitting: inspect GitHub, keep durable per-PR state, and deliver wake messages
// to a T3 thread through `t3code threads send --idempotency-key`. Every command prints one JSON
// envelope: `{ ok: true, data }` on stdout, or `{ ok: false, error }` on stderr with a non-zero exit.
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { fetchPullRequestSnapshot, ghRunner } from "./github.mjs";
import { classify, DEFERRABLE_SEVERITIES, findingSeverity, invalidateResolvedDecisions, reviewerReactions, threadVersion } from "./inspect.mjs";
import { quotePowerShell, quoteShell, scheduleCommands } from "./schedule.mjs";
import {
  describeLock,
  displayRef,
  isProcessAlive,
  lockPathFor,
  parsePrRef,
  prKey,
  readLockInfo,
  readState,
  STATE_SCHEMA,
  statePathFor,
  withLock,
  writeFileAtomic,
  writeState,
} from "./state.mjs";
import { BabysitError, cleanText, iso, parseDuration, requireFullSha, sleep, usage } from "./util.mjs";
import { deliverEvent, recordObservation, redeliveryOf, spawnCli, unacknowledged } from "./wake.mjs";

const HELPER_PATH = fileURLToPath(import.meta.url);
/** The t3code CLI this skill ships with: skills/babysit/scripts -> package root -> dist/cli.js. */
export const BUNDLED_CLI = path.resolve(path.dirname(HELPER_PATH), "../../../dist/cli.js");
/** A tick that finds the lock held for longer than this exits 4, so the scheduler's history shows it. */
const LOCK_STUCK_MS = 60 * 60_000;
const RATE_LIMIT_FLOOR = 100;
const RATE_LIMIT_FALLBACK_MS = 15 * 60_000;
const WATCHERS = new Set(["t3-native", "os-schedule", "session-wait", "none"]);
const STOP_REASONS = new Set(["merged", "closed", "cancelled"]);
const DECISIONS = new Set(["fixed", "refuted", "deferred"]);
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u;

const OPTIONS = {
  pr: { type: "string" },
  "state-dir": { type: "string" },
  "code-reviewer": { type: "string", multiple: true },
  "security-check": { type: "string", multiple: true },
  "required-check": { type: "string", multiple: true },
  thread: { type: "string" },
  "wake-settled": { type: "boolean" },
  "t3code-cli": { type: "string" },
  gh: { type: "string" },
  task: { type: "string" },
  cwd: { type: "string" },
  branch: { type: "string" },
  tested: { type: "string" },
  result: { type: "string" },
  command: { type: "string", multiple: true },
  "review-request": { type: "boolean" },
  "review-evidence": { type: "boolean" },
  head: { type: "string" },
  url: { type: "string" },
  note: { type: "string" },
  watcher: { type: "string" },
  "watcher-id": { type: "string" },
  "cancel-command": { type: "string" },
  finding: { type: "string", multiple: true },
  decision: { type: "string" },
  "user-approved": { type: "boolean" },
  evidence: { type: "string" },
  commit: { type: "string" },
  event: { type: "string", multiple: true },
  redeliver: { type: "string" },
  reason: { type: "string" },
  timeout: { type: "string" },
  interval: { type: "string" },
  platform: { type: "string" },
};

const COMMON = ["pr", "state-dir"];
const POLICY = ["code-reviewer", "security-check", "required-check"];
const ALLOWED = {
  init: [...COMMON, ...POLICY, "thread", "wake-settled", "t3code-cli", "gh", "task", "cwd", "branch"],
  inspect: [...COMMON, ...POLICY, "gh"],
  record: [...COMMON, "tested", "result", "command", "review-request", "review-evidence", "head", "url", "note", "watcher", "watcher-id", "cancel-command"],
  decide: [...COMMON, "finding", "decision", "evidence", "commit", "user-approved"],
  tick: COMMON,
  wait: [...COMMON, "timeout", "interval"],
  ack: [...COMMON, "event", "note"],
  status: COMMON,
  wake: [...COMMON, "redeliver"],
  stop: [...COMMON, "reason"],
  "schedule-command": [...COMMON, "interval", "platform"],
};
const RECORD_MODES = {
  tested: ["tested", "result", "command"],
  "review-request": ["review-request", "head", "url"],
  "review-evidence": ["review-evidence", "head", "url", "note"],
  watcher: ["watcher", "watcher-id", "cancel-command"],
};

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function defaultDeps() {
  const now = () => Date.now();
  return {
    now,
    env: process.env,
    platform: process.platform,
    execPath: process.execPath,
    helperPath: HELPER_PATH,
    bundledCli: BUNDLED_CLI,
    homedir: os.homedir(),
    cwd: process.cwd(),
    pid: process.pid,
    hostname: os.hostname(),
    isAlive: isProcessAlive,
    sleep,
    fileExists,
    runCli: spawnCli,
    fetchSnapshot: (ref, state) => fetchPullRequestSnapshot(ref, { run: ghRunner({ ghPath: state?.github?.ghPath ?? "gh", host: ref.host }), now }),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

// Arguments

function parseCommand(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw usage("INVALID_USAGE", cleanText(error?.message ?? error, 300));
  }
  const [command, ...extra] = parsed.positionals;
  if (!command || !Object.hasOwn(ALLOWED, command)) {
    throw usage("INVALID_USAGE", `Name one command: ${Object.keys(ALLOWED).join(", ")}.`);
  }
  if (extra.length > 0) throw usage("INVALID_USAGE", `Unexpected argument ${JSON.stringify(extra[0])}.`);
  const values = parsed.values;
  const unexpected = Object.keys(values).filter((name) => !ALLOWED[command].includes(name));
  if (unexpected.length > 0) throw usage("INVALID_USAGE", `${command} does not take --${unexpected[0]}.`);
  return { command, values };
}

function text(value, flag, limit) {
  const result = String(value ?? "").trim();
  if (!result) throw usage("VALUE_REQUIRED", `${flag} needs a non-empty value.`);
  if (result.length > limit) throw usage("VALUE_TOO_LONG", `${flag} is limited to ${limit} characters.`);
  return result;
}

function githubExecutable(value, cwd) {
  const executable = text(value, "--gh", 1000);
  return /[\\/]/u.test(executable) ? path.resolve(cwd, executable) : executable;
}

function httpsUrl(value, flag) {
  const raw = text(value, flag, 2000);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw usage("INVALID_URL", `${flag} needs an https URL, not ${JSON.stringify(raw)}.`);
  }
  if (url.protocol !== "https:") throw usage("INVALID_URL", `${flag} needs an https URL, not ${JSON.stringify(raw)}.`);
  return url;
}

/** A link into this pull request, such as the `@codex review` comment. */
function pullRequestUrl(value, pr) {
  const url = httpsUrl(value, "--url");
  const host = url.host.toLowerCase() === "www.github.com" ? "github.com" : url.host.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  const matches =
    host === pr.host &&
    parts.length >= 4 &&
    parts[0].toLowerCase() === pr.owner.toLowerCase() &&
    parts[1].toLowerCase() === pr.repo.toLowerCase() &&
    parts[2] === "pull" &&
    parts[3] === String(pr.number);
  if (!matches) throw usage("URL_NOT_THIS_PR", `--url must link into ${displayRef(pr)}, such as the review request comment.`);
  return url.href;
}

function policyFrom(values) {
  const codeReviewers = (values["code-reviewer"] ?? []).map((login) => login.trim()).filter(Boolean);
  if (codeReviewers.length === 0) {
    throw usage("CODE_REVIEWER_REQUIRED", "Name the code reviewer's GitHub login with --code-reviewer, for example chatgpt-codex-connector[bot]. There is no default.");
  }
  for (const login of codeReviewers) {
    if (!LOGIN.test(login)) throw usage("INVALID_LOGIN", `${JSON.stringify(login)} is not a GitHub login.`);
  }
  const securityCheckPatterns = (values["security-check"] ?? []).map((pattern) => text(pattern, "--security-check", 200));
  for (const pattern of securityCheckPatterns) {
    try {
      new RegExp(pattern, "iu");
    } catch {
      throw usage("INVALID_PATTERN", `--security-check ${JSON.stringify(pattern)} is not a valid regular expression.`);
    }
  }
  const requiredChecks = (values["required-check"] ?? []).map((name) => cleanText(text(name, "--required-check", 200), 200));
  return { codeReviewers: [...new Set(codeReviewers)], securityCheckPatterns, requiredChecks, requireTestedHead: true };
}

function intervalMinutes(raw) {
  const value = String(raw ?? "5").trim();
  const minutes = /^\d+$/u.test(value) ? Number(value) : (parseDuration(value) ?? NaN) / 60_000;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw usage("INVALID_INTERVAL", `--interval needs whole minutes from 1 to 60, such as 5 or 10m, not ${JSON.stringify(raw)}.`);
  }
  return minutes;
}

function durationOption(raw, flag, fallback, minimum, maximum) {
  const value = parseDuration(raw ?? fallback);
  if (value === null || value < minimum || value > maximum) {
    throw usage("INVALID_DURATION", `${flag} needs a duration from ${minimum / 1000}s to ${maximum / 3_600_000}h, such as 90s, 30m, or 2h.`);
  }
  return value;
}

// Context

function contextFor(values, deps) {
  const ref = parsePrRef(values.pr);
  const configured = values["state-dir"] ?? deps.env.BABYSIT_STATE_DIR ?? path.join(deps.homedir, ".babysit", "v1");
  const stateDir = path.resolve(deps.cwd, configured);
  return { ref, stateDir, statePath: statePathFor(stateDir, ref) };
}

function lockDeps(deps) {
  return { now: deps.now, isAlive: deps.isAlive, hostname: deps.hostname, pid: deps.pid };
}

async function loadRequired(context) {
  const state = await readState(context.statePath);
  if (!state) {
    throw new BabysitError("STATE_NOT_FOUND", `No babysit state exists for ${displayRef(context.ref)} at ${context.statePath}. Run init first.`, {
      exitCode: 3,
      details: { statePath: context.statePath },
    });
  }
  if (state.prKey !== prKey(context.ref)) {
    throw new BabysitError("STATE_CORRUPT", `The state file ${context.statePath} belongs to ${state.prKey}, not ${prKey(context.ref)}. It was left untouched.`, {
      details: { statePath: context.statePath },
    });
  }
  return state;
}

async function underLock(context, deps, run) {
  const outcome = await withLock(context.statePath, run, lockDeps(deps));
  if (outcome.locked) {
    throw new BabysitError("STATE_LOCKED", `Another babysit process is working on ${displayRef(context.ref)}; try again shortly.`, {
      exitCode: 4,
      details: { lock: outcome.owner },
    });
  }
  return outcome.value;
}

function renderContext(context, deps, state, extra = {}) {
  const quote = deps.platform === "win32" ? quotePowerShell : quoteShell;
  return {
    now: deps.now,
    command: (name, args = []) => `${deps.platform === "win32" ? "& " : ""}${[deps.execPath, deps.helperPath, name, "--pr", displayRef(state.pr), "--state-dir", context.stateDir, ...args].map(quote).join(" ")}`,
    ...extra,
  };
}

async function save(context, state, lock, deps) {
  state.updatedAt = iso(deps.now());
  await writeState(context.statePath, state, lock.assertHeld);
}

function applyRateLimit(state, snapshot, now) {
  const resetAt = snapshot.rateLimit?.resetAt ?? null;
  const resetMs = resetAt ? Date.parse(resetAt) : NaN;
  if (snapshot.error?.code === "GITHUB_RATE_LIMITED") {
    state.nextTickNotBefore = Number.isFinite(resetMs) && resetMs > now ? resetAt : iso(now + RATE_LIMIT_FALLBACK_MS);
  } else if (typeof snapshot.rateLimit?.remaining === "number" && snapshot.rateLimit.remaining < RATE_LIMIT_FLOOR && Number.isFinite(resetMs) && resetMs > now) {
    state.nextTickNotBefore = resetAt;
  } else {
    state.nextTickNotBefore = null;
  }
}

/** Reads GitHub, classifies, and records the observation; may create a wake event. */
async function observe(state, context, deps, options = {}) {
  const snapshot = await deps.fetchSnapshot(context.ref, state);
  invalidateResolvedDecisions(snapshot, state, iso(deps.now()));
  const inspection = classify(snapshot, state);
  applyRateLimit(state, snapshot, deps.now());
  if (inspection.pr?.url) state.pr.url = inspection.pr.url;
  const { event } = recordObservation(state, inspection, renderContext(context, deps, state, { baseline: options.baseline === true }));
  const watcher = state.watcher;
  if (!options.baseline && watcher && watcher.mechanism !== "none" && !watcher.firstTickAt && (inspection.complete || inspection.terminal)) {
    watcher.firstTickAt = iso(deps.now());
    watcher.firstTickHeadSha = inspection.pr?.headSha ?? null;
  }
  return { inspection, event };
}

function eventView(event) {
  return {
    id: event.id,
    kind: event.kind,
    readiness: event.readiness ?? null,
    terminal: event.terminal ?? null,
    status: event.status,
    createdAt: event.createdAt,
    deliveredAt: event.deliveredAt ?? null,
    ackedAt: event.ackedAt ?? null,
    attempts: event.attempts.length,
    lastAttempt: event.attempts.at(-1) ?? null,
    nextAttemptAt: event.nextAttemptAt ?? null,
    idempotencyKey: event.idempotencyKey,
    ...(event.redeliveryOf ? { redeliveryOf: event.redeliveryOf } : {}),
    ...(event.supersededBy ? { supersededBy: event.supersededBy } : {}),
  };
}

function observationView(observation) {
  if (!observation) return null;
  return {
    at: observation.at ?? null,
    headSha: observation.headSha ?? null,
    readiness: observation.readiness ?? null,
    terminal: observation.terminal ?? null,
    reasons: observation.reasons ?? [],
    degraded: observation.degraded ?? null,
  };
}

async function deliverDue(state, context, deps, lock) {
  const results = [];
  const now = deps.now();
  const due = state.events.filter((event) => event.status === "pending" && (!event.nextAttemptAt || Date.parse(event.nextAttemptAt) <= now));
  for (const event of due) {
    const outcome = await deliverEvent(state, event, deps);
    await save(context, state, lock, deps);
    results.push({
      eventId: event.id,
      result: outcome.result,
      code: outcome.code ?? null,
      message: outcome.message ?? null,
      messageId: outcome.messageId ?? null,
      nextAttemptAt: event.nextAttemptAt ?? null,
    });
  }
  return results;
}

function deliveryFailure(data) {
  if (data.deliveries.some((delivery) => delivery.result === "rejected")) {
    return new BabysitError(
      "DELIVERY_REJECTED",
      "T3 rejected a wake message. It is not retried under the same key; fix the cause, then run wake --redeliver.",
      { exitCode: 3, details: data },
    );
  }
  if (data.deliveries.some((delivery) => delivery.result === "ambiguous")) {
    return new BabysitError(
      "DELIVERY_PENDING_RETRY",
      "A wake message may not have arrived. It will be retried with the same key and text after its backoff.",
      { exitCode: 5, details: data },
    );
  }
  return null;
}

// Commands

async function init(values, deps, context) {
  const policy = policyFrom(values);
  const threadId = values.thread === undefined ? null : text(values.thread, "--thread", 200);
  if (threadId && /\s/u.test(threadId)) throw usage("INVALID_THREAD", "--thread needs an exact T3 thread id.");
  if (!threadId && (values["wake-settled"] || values["t3code-cli"] !== undefined)) {
    throw usage("THREAD_REQUIRED", "--wake-settled and --t3code-cli need --thread.");
  }
  const ghPath = values.gh === undefined ? null : githubExecutable(values.gh, deps.cwd);
  const cliPath = path.resolve(deps.cwd, values["t3code-cli"] ?? deps.env.T3CODE_CLI ?? deps.bundledCli);
  const delivery = threadId ? { type: "t3-thread", threadId, wakeSettled: values["wake-settled"] === true, cliPath } : { type: "none" };
  if (threadId) {
    // Persist routing paths, never auth tokens, so scheduled delivery uses the same T3 instance.
    const routingEnv = Object.fromEntries(["T3CODE_CLI_CONFIG", "T3CODE_CLI_ORIGIN", "T3CODE_HOME"]
      .filter((key) => deps.env[key]).map((key) => [key, key === "T3CODE_CLI_ORIGIN" ? deps.env[key] : path.resolve(deps.cwd, deps.env[key])]));
    if (Object.keys(routingEnv).length > 0) delivery.env = routingEnv;
  }
  const scope = {
    task: values.task === undefined ? null : text(values.task, "--task", 2000),
    cwd: path.resolve(deps.cwd, values.cwd ?? "."),
    branch: values.branch === undefined ? null : text(values.branch, "--branch", 250),
  };

  return await underLock(context, deps, async (lock) => {
    const at = iso(deps.now());
    const existing = await readState(context.statePath);
    if (existing && existing.prKey !== prKey(context.ref)) {
      throw new BabysitError("STATE_CORRUPT", `The state file ${context.statePath} belongs to ${existing.prKey}. It was left untouched.`, { details: { statePath: context.statePath } });
    }
    const sameTarget = existing && existing.delivery.type === delivery.type && (existing.delivery.threadId ?? null) === (delivery.threadId ?? null);
    if (existing && !sameTarget && !existing.stoppedAt) {
      throw new BabysitError(
        "STATE_TARGET_CONFLICT",
        `${displayRef(context.ref)} is already watched for ${existing.delivery.type === "t3-thread" ? `thread ${existing.delivery.threadId}` : "no thread"}. Stop that watch first.`,
        { exitCode: 4, details: { statePath: context.statePath, delivery: existing.delivery } },
      );
    }
    let state;
    let inspection = null;
    if (existing) {
      state = existing;
      state.policy = policy;
      state.scope = scope;
      state.delivery = delivery;
      state.github = { ghPath: ghPath ?? existing.github?.ghPath ?? "gh" };
      if (state.stoppedAt) {
        state.stoppedAt = null;
        state.stopReason = null;
      }
    } else {
      state = {
        schema: STATE_SCHEMA,
        prKey: prKey(context.ref),
        pr: { ...context.ref, url: null },
        scope,
        policy,
        github: { ghPath: ghPath ?? "gh" },
        delivery,
        watcher: { mechanism: "none", id: null, cancelCommand: null, registeredAt: null, firstTickAt: null, firstTickHeadSha: null },
        tested: null,
        reviewRequests: [],
        reviewEvidence: [],
        findingDecisions: {},
        lastObservation: null,
        baselineSummary: null,
        health: { consecutiveFailures: 0 },
        events: [],
        nextTickNotBefore: null,
        stoppedAt: null,
        stopReason: null,
        createdAt: at,
        updatedAt: at,
      };
      // The baseline: what the agent sees now is not news later. A failed read leaves no baseline,
      // so the first complete tick reports everything.
      inspection = (await observe(state, context, deps, { baseline: true })).inspection;
    }
    await save(context, state, lock, deps);
    const warnings = [];
    if (delivery.type === "none") warnings.push("No --thread: tick cannot deliver wakes; use wait in this session or init again with --thread.");
    if (delivery.type === "t3-thread" && !delivery.wakeSettled) {
      warnings.push("Without --wake-settled, T3 rejects a wake for a settled thread, and the rejection is final for that wake.");
    }
    if (delivery.type === "t3-thread" && !(await deps.fileExists(delivery.cliPath))) warnings.push(`The t3code CLI is missing at ${delivery.cliPath}; deliveries will be retried until it exists.`);
    return {
      data: {
        statePath: context.statePath,
        created: !existing,
        pr: displayRef(state.pr),
        policy: state.policy,
        delivery: state.delivery,
        inspection,
        warnings,
      },
    };
  });
}

async function inspect(values, deps, context) {
  const existing = await readState(context.statePath);
  const policyGiven = POLICY.some((name) => values[name] !== undefined);
  let state = existing;
  if (existing) {
    if (existing.prKey !== prKey(context.ref)) await loadRequired(context);
    if (policyGiven || values.gh !== undefined) throw usage("POLICY_FROM_STATE", "This pull request has a babysit state; its policy applies. Change it with init.");
  } else {
    if (!policyGiven) await loadRequired(context);
    state = { prKey: prKey(context.ref), pr: { ...context.ref, url: null }, policy: policyFrom(values), github: { ghPath: values.gh === undefined ? "gh" : githubExecutable(values.gh, deps.cwd) } };
  }
  const snapshot = await deps.fetchSnapshot(context.ref, state);
  const inspection = classify(snapshot, state);
  return {
    data: {
      statePath: existing ? context.statePath : null,
      inspection,
      unacknowledged: existing ? unacknowledged(existing) : [],
    },
  };
}

async function record(values, deps, context) {
  const modes = Object.keys(RECORD_MODES).filter((mode) => (mode === "tested" || mode === "watcher" ? values[mode] !== undefined : values[mode] === true));
  if (modes.length !== 1) throw usage("RECORD_MODE_REQUIRED", "Use exactly one of --tested, --review-request, --review-evidence, or --watcher.");
  const mode = modes[0];
  const stray = Object.keys(values).filter((name) => !COMMON.includes(name) && !RECORD_MODES[mode].includes(name));
  if (stray.length > 0) throw usage("INVALID_USAGE", `record ${mode === "tested" ? "--tested" : `--${mode}`} does not take --${stray[0]}.`);

  return await underLock(context, deps, async (lock) => {
    const state = await loadRequired(context);
    const at = iso(deps.now());
    let entry;
    if (mode === "tested") {
      const sha = requireFullSha(values.tested, "--tested");
      if (values.result !== "pass" && values.result !== "fail") throw usage("RESULT_REQUIRED", "--result must be pass or fail.");
      const commands = (values.command ?? []).map((command) => text(command, "--command", 500));
      if (commands.length === 0) throw usage("TEST_COMMAND_REQUIRED", "Name each verification command that ran with --command.");
      entry = { sha, result: values.result, commands, at };
      state.tested = entry;
    } else if (mode === "review-request") {
      const head = requireFullSha(values.head, "--head");
      const url = pullRequestUrl(values.url, state.pr);
      entry = { head, url, at };
      state.reviewRequests ??= [];
      if (!state.reviewRequests.some((request) => request.head === head && request.url === url)) state.reviewRequests.push(entry);
    } else if (mode === "review-evidence") {
      const head = requireFullSha(values.head, "--head");
      const url = httpsUrl(values.url, "--url").href;
      const note = text(values.note, "--note", 2000);
      state.reviewEvidence ??= [];
      entry = state.reviewEvidence.find((evidence) => evidence.head === head && evidence.url === url);
      if (!entry) {
        const snapshot = await deps.fetchSnapshot(context.ref, state);
        if (!snapshot.complete || !snapshot.pr || snapshot.pr.headSha !== head) {
          throw new BabysitError("REVIEW_EVIDENCE_SNAPSHOT_INVALID", "Review evidence needs a complete live snapshot of the recorded head.", { exitCode: 5 });
        }
        invalidateResolvedDecisions(snapshot, state, at);
        entry = { head, url, note, at, reactions: reviewerReactions(snapshot.pr, state.policy) };
        state.reviewEvidence.push(entry);
      }
    } else {
      const mechanism = values.watcher;
      if (!WATCHERS.has(mechanism)) throw usage("INVALID_WATCHER", `--watcher must be one of ${[...WATCHERS].join(", ")}.`);
      if (mechanism === "os-schedule") {
        if (state.delivery.type !== "t3-thread") throw usage("NO_DELIVERY_TARGET", "A scheduled tick needs a T3 thread to wake; run init with --thread.");
        if (values["watcher-id"] === undefined || values["cancel-command"] === undefined) {
          throw usage("WATCHER_DETAILS_REQUIRED", "An os-schedule watcher needs --watcher-id and --cancel-command from schedule-command.");
        }
      }
      entry = {
        mechanism,
        id: values["watcher-id"] === undefined ? null : text(values["watcher-id"], "--watcher-id", 300),
        cancelCommand: values["cancel-command"] === undefined ? null : text(values["cancel-command"], "--cancel-command", 2000),
        registeredAt: at,
        firstTickAt: null,
        firstTickHeadSha: null,
      };
      state.watcher = entry;
    }
    await save(context, state, lock, deps);
    const head = entry.sha ?? entry.head ?? null;
    return {
      data: {
        statePath: context.statePath,
        recorded: { mode, entry },
        matchesLastObservedHead: head && state.lastObservation?.headSha ? head === state.lastObservation.headSha : null,
      },
    };
  });
}

async function decide(values, deps, context) {
  const findingIds = [...new Set((values.finding ?? []).map((finding) => text(finding, "--finding", 300)))];
  if (findingIds.length === 0) throw usage("VALUE_REQUIRED", "--finding needs a review thread id.");
  if (!DECISIONS.has(values.decision)) throw usage("DECISION_REQUIRED", "--decision must be fixed, refuted, or deferred.");
  if (values["user-approved"] && values.decision !== "deferred") throw usage("INVALID_USAGE", "--user-approved applies only to --decision deferred.");
  const evidence = text(values.evidence, "--evidence", 2000);
  const commit = values.commit === undefined ? null : requireFullSha(values.commit, "--commit");

  return await underLock(context, deps, async (lock) => {
    const state = await loadRequired(context);
    const snapshot = await deps.fetchSnapshot(context.ref, state);
    if (!snapshot.complete || !snapshot.pr) {
      throw new BabysitError("GITHUB_INCOMPLETE", `Could not read the whole pull request (${snapshot.error?.code ?? "incomplete"}); no decision was recorded.`, {
        exitCode: 5,
        details: { error: snapshot.error ?? null },
      });
    }
    // Check every thread before recording any, so a batch is all or nothing.
    const threads = findingIds.map((findingId) => {
      const thread = snapshot.pr.threads.find((candidate) => candidate.id === findingId);
      if (!thread) {
        throw new BabysitError("FINDING_NOT_FOUND", `${displayRef(context.ref)} has no review thread ${findingId}.`, { exitCode: 3, details: { finding: findingId } });
      }
      const severity = findingSeverity(thread, state.policy);
      if (values.decision === "deferred" && !DEFERRABLE_SEVERITIES.has(severity) && !values["user-approved"]) {
        throw new BabysitError(
          "DEFERRAL_NEEDS_USER",
          `Review thread ${findingId} is ${severity ?? "unrated"}. Fix it, refute it, or defer it only after the user approves, with --user-approved.`,
          { exitCode: 4, details: { finding: findingId, severity } },
        );
      }
      return thread;
    });
    // The decision covers the thread exactly as it reads now; a later or edited comment reopens it.
    invalidateResolvedDecisions(snapshot, state, iso(deps.now()));
    state.findingDecisions ??= {};
    const findings = threads.map((thread) => {
      const decision = {
        decision: values.decision,
        evidence,
        commit,
        severity: findingSeverity(thread, state.policy),
        // Only findings that needed approval carry it, so the report never claims an approval nobody gave.
        ...(values["user-approved"] && !DEFERRABLE_SEVERITIES.has(findingSeverity(thread, state.policy)) ? { userApproved: true } : {}),
        at: iso(deps.now()),
        threadVersion: threadVersion(thread),
        isResolved: thread.isResolved,
        comments: thread.comments.length,
        headSha: snapshot.pr.headSha,
        url: thread.comments[0]?.url ?? null,
      };
      state.findingDecisions[thread.id] = decision;
      return { threadId: thread.id, ...decision };
    });
    await save(context, state, lock, deps);
    return {
      data: {
        statePath: context.statePath,
        ...(findings.length === 1 ? { finding: findings[0] } : {}),
        findings,
        note: "Reply in the thread before deciding: any later comment or edit on the thread reopens this finding.",
      },
    };
  });
}

async function tick(_values, deps, context) {
  const outcome = await withLock(
    context.statePath,
    async (lock) => {
      const state = await loadRequired(context);
      if (state.delivery.type !== "t3-thread" && !state.stoppedAt) throw usage("NO_DELIVERY_TARGET", `The watch for ${displayRef(state.pr)} has no T3 thread to wake; run init with --thread, or use wait.`);
      let observation = { skipped: null, event: null, inspection: null };
      if (state.stoppedAt) observation.skipped = "stopped";
      else if (state.nextTickNotBefore && deps.now() < Date.parse(state.nextTickNotBefore)) observation.skipped = "github-backoff";
      else {
        const observed = await observe(state, context, deps);
        observation = { skipped: null, event: observed.event, inspection: observed.inspection };
      }
      await save(context, state, lock, deps);
      // Delivery runs even when stopped, so a final merge or closure wake still goes out.
      const deliveries = await deliverDue(state, context, deps, lock);
      return { state, observation, deliveries };
    },
    lockDeps(deps),
  );
  if (outcome.locked) {
    if ((outcome.owner.ageMs ?? 0) > LOCK_STUCK_MS) {
      throw new BabysitError("LOCK_STUCK", `The babysit lock for ${displayRef(context.ref)} has been held for over an hour by a live process; it is not taken over.`, {
        exitCode: 4,
        details: { lock: outcome.owner, lockPath: lockPathFor(context.statePath) },
      });
    }
    return { data: { statePath: context.statePath, skipped: "locked", lock: outcome.owner, deliveries: [] } };
  }
  const { state, observation, deliveries } = outcome.value;
  const data = {
    statePath: context.statePath,
    pr: displayRef(state.pr),
    skipped: observation.skipped,
    readiness: observation.inspection?.readiness ?? null,
    terminal: observation.inspection?.terminal ?? null,
    complete: observation.inspection?.complete ?? null,
    error: observation.inspection?.error ?? null,
    newEvent: observation.event ? eventView(observation.event) : null,
    deliveries,
    nextTickNotBefore: state.nextTickNotBefore ?? null,
    stopped: state.stoppedAt ? { at: state.stoppedAt, reason: state.stopReason } : null,
    unacknowledged: unacknowledged(state),
  };
  const failure = deliveryFailure(data);
  if (failure) throw failure;
  return { data };
}

async function wait(values, deps, context) {
  const timeoutMs = durationOption(values.timeout, "--timeout", "30m", 1_000, 24 * 3_600_000);
  const intervalMs = durationOption(values.interval, "--interval", "60s", 15_000, 3_600_000);
  const deadline = deps.now() + timeoutMs;
  let delay = intervalMs;
  for (;;) {
    const outcome = await withLock(
      context.statePath,
      async (lock) => {
        const state = await loadRequired(context);
        if (state.stoppedAt && !state.events.some((event) => event.status === "pending")) return { state, stopped: true };
        let failed = false;
        if (!state.stoppedAt && !(state.nextTickNotBefore && deps.now() < Date.parse(state.nextTickNotBefore))) {
          const { inspection } = await observe(state, context, deps);
          failed = !inspection.complete && !inspection.terminal;
        }
        // This session is the recipient: printing the event is its delivery.
        const event = state.events.findLast((candidate) => candidate.status === "pending") ?? null;
        if (event) {
          const at = iso(deps.now());
          event.status = "delivered";
          event.deliveredAt = at;
          event.nextAttemptAt = null;
          event.attempts.push({ at, result: "ok", code: null, via: "stdout" });
        }
        await save(context, state, lock, deps);
        return { state, event, failed };
      },
      lockDeps(deps),
    );
    if (!outcome.locked) {
      const { state, stopped, event, failed } = outcome.value;
      if (stopped) return { data: { statePath: context.statePath, stopped: { at: state.stoppedAt, reason: state.stopReason }, event: null } };
      if (event) {
        return {
          data: {
            statePath: context.statePath,
            stopped: state.stoppedAt ? { at: state.stoppedAt, reason: state.stopReason } : null,
            event: { ...eventView(event), text: event.text },
            unacknowledged: unacknowledged(state),
          },
        };
      }
      delay = failed ? Math.min(delay * 2, 10 * 60_000) : intervalMs;
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      const state = await readState(context.statePath).catch(() => null);
      throw new BabysitError("WAIT_TIMEOUT", `No news for ${displayRef(context.ref)} within ${Math.round(timeoutMs / 1000)} seconds; monitoring ends with this command.`, {
        exitCode: 6,
        details: { statePath: context.statePath, lastObservation: observationView(state?.lastObservation), health: state?.health ?? null },
      });
    }
    await deps.sleep(Math.min(delay, remaining));
  }
}

async function ack(values, deps, context) {
  const ids = (values.event ?? []).map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) throw usage("EVENT_REQUIRED", "Name the event to acknowledge with --event.");
  const note = values.note === undefined ? null : text(values.note, "--note", 2000);
  return await underLock(context, deps, async (lock) => {
    const state = await loadRequired(context);
    const events = ids.map((id) => {
      const event = state.events.find((candidate) => candidate.id === id);
      if (!event) throw new BabysitError("EVENT_NOT_FOUND", `No event ${id} is recorded for ${displayRef(state.pr)}.`, { exitCode: 3, details: { eventId: id } });
      return event;
    });
    const at = iso(deps.now());
    const acknowledged = events.map((event) => {
      const previousStatus = event.status;
      if (event.status !== "acked") {
        event.status = "acked";
        event.ackedAt = at;
        event.ackNote = note;
        event.previousStatus = previousStatus;
        event.nextAttemptAt = null;
      }
      return { id: event.id, previousStatus, status: "acked" };
    });
    await save(context, state, lock, deps);
    return { data: { statePath: context.statePath, acknowledged, unacknowledged: unacknowledged(state) } };
  });
}

async function status(_values, deps, context) {
  const state = await loadRequired(context);
  const lock = describeLock(await readLockInfo(lockPathFor(context.statePath), lockDeps(deps)));
  const watcher = state.watcher ?? { mechanism: "none" };
  return {
    data: {
      statePath: context.statePath,
      pr: { ...state.pr, ref: displayRef(state.pr) },
      scope: state.scope ?? null,
      policy: state.policy,
      delivery: state.delivery,
      watcher: { ...watcher, verified: Boolean(watcher.firstTickAt) },
      stopped: state.stoppedAt ? { at: state.stoppedAt, reason: state.stopReason } : null,
      tested: state.tested ?? null,
      reviewRequests: state.reviewRequests ?? [],
      reviewEvidence: state.reviewEvidence ?? [],
      findingDecisions: state.findingDecisions ?? {},
      lastObservation: observationView(state.lastObservation),
      health: state.health ?? null,
      nextTickNotBefore: state.nextTickNotBefore ?? null,
      events: {
        unacknowledged: state.events.filter((event) => event.status === "delivered").map(eventView),
        pending: state.events.filter((event) => event.status === "pending").map(eventView),
        rejected: state.events.filter((event) => event.status === "rejected").map(eventView),
        total: state.events.length,
      },
      lock,
    },
  };
}

async function wake(values, deps, context) {
  if (values.redeliver === undefined) throw usage("REDELIVER_REQUIRED", "wake needs --redeliver <event-id>.");
  const sourceId = text(values.redeliver, "--redeliver", 200);
  const value = await underLock(context, deps, async (lock) => {
    const state = await loadRequired(context);
    if (state.delivery.type !== "t3-thread") throw usage("NO_DELIVERY_TARGET", `The watch for ${displayRef(state.pr)} has no T3 thread to deliver to.`);
    const event = redeliveryOf(state, sourceId, renderContext(context, deps, state));
    await save(context, state, lock, deps);
    const outcome = await deliverEvent(state, event, deps);
    await save(context, state, lock, deps);
    return { state, event, outcome };
  });
  const data = {
    statePath: context.statePath,
    event: eventView(value.event),
    deliveries: [
      {
        eventId: value.event.id,
        result: value.outcome.result,
        code: value.outcome.code ?? null,
        message: value.outcome.message ?? null,
        messageId: value.outcome.messageId ?? null,
        nextAttemptAt: value.event.nextAttemptAt ?? null,
      },
    ],
  };
  const failure = deliveryFailure(data);
  if (failure) throw failure;
  return { data };
}

async function stop(values, deps, context) {
  if (!STOP_REASONS.has(values.reason)) throw usage("STOP_REASON_REQUIRED", "--reason must be merged, closed, or cancelled.");
  return await underLock(context, deps, async (lock) => {
    const state = await loadRequired(context);
    const at = iso(deps.now());
    if (!state.stoppedAt) {
      state.stoppedAt = at;
      state.stopReason = values.reason;
    }
    const cancelled = [];
    for (const event of state.events) {
      if (event.status !== "pending") continue;
      event.status = "superseded";
      event.supersededBy = "stop";
      event.nextAttemptAt = null;
      cancelled.push(event.id);
    }
    await save(context, state, lock, deps);
    const watcher = state.watcher ?? { mechanism: "none" };
    return {
      data: {
        statePath: context.statePath,
        stopped: { at: state.stoppedAt, reason: state.stopReason },
        cancelledEvents: cancelled,
        watcher,
        next: watcher.cancelCommand
          ? "Run watcher.cancelCommand to remove the scheduled task; until then each run exits without reading GitHub."
          : watcher.mechanism === "t3-native"
            ? "Stop the native T3 pull request watch if it is still running."
            : null,
      },
    };
  });
}

async function scheduleCommand(values, deps, context) {
  const minutes = intervalMinutes(values.interval);
  const state = await loadRequired(context);
  if (state.delivery.type !== "t3-thread") throw usage("NO_DELIVERY_TARGET", "A scheduled tick needs a T3 thread to wake; run init with --thread.");
  if (state.stoppedAt) throw new BabysitError("WATCH_STOPPED", `The watch for ${displayRef(state.pr)} is stopped; run init to resume it first.`, { exitCode: 4 });
  const platform = values.platform ?? deps.platform;
  if (platform !== "win32" && platform !== "linux" && platform !== "darwin") throw usage("INVALID_PLATFORM", "--platform must be win32, linux, or darwin.");
  const plan = scheduleCommands({
    platform,
    execPath: deps.execPath,
    helperPath: deps.helperPath,
    stateDir: context.stateDir,
    statePath: context.statePath,
    state,
    intervalMinutes: minutes,
    env: deps.env,
  });
  // The launcher is a generated file beside the state; writing it starts nothing.
  if (plan.launcher) await writeFileAtomic(plan.launcher.path, plan.launcher.content);
  const helperCommand = (name, args) => [deps.execPath, deps.helperPath, name, "--pr", displayRef(state.pr), "--state-dir", context.stateDir, ...args];
  return {
    data: {
      statePath: context.statePath,
      ...plan,
      launcher: plan.launcher ? { path: plan.launcher.path, written: true } : null,
      afterRegistering: {
        record: helperCommand("record", ["--watcher", "os-schedule", "--watcher-id", plan.watcherId, "--cancel-command", plan.cancel]),
        verify: "Run runNow (or wait one interval), then status: watcher.verified must be true and lastObservation.headSha must be the PR head before you report monitoring as active.",
      },
      executed: false,
    },
  };
}

const COMMANDS = { init, inspect, record, decide, tick, wait, ack, status, wake, stop, "schedule-command": scheduleCommand };

function errorEnvelope(error) {
  if (error instanceof BabysitError) {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  return { code: "UNEXPECTED_ERROR", message: cleanText(error?.message ?? error, 500) };
}

/** Runs one command. Returns the exit code and the envelope it printed. */
export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  try {
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
      const data = { command: "help", usage: "t3code babysit <command> --pr <owner/repo#number> [options]",
        commands: ALLOWED,
        notes: ["Repeat --code-reviewer, --required-check, --security-check, --command, and --event as needed.",
          "init requires --code-reviewer; scheduled delivery also requires --thread (and --wake-settled for a settled thread).",
          "record requires one of --tested, --review-request, --review-evidence, or --watcher. Tests need --result and --command; review evidence needs --head, --url and --note.",
          "wait has a finite timeout. tick sends only changed news and retries ambiguous delivery with the original key and text.",
          "schedule-command prints registration/cancellation commands; it does not start a schedule.",
          "decide takes one or more --finding ids. --decision deferred works on its own for P2/P3 findings; P0, P1, and unrated findings also need --user-approved.",
          "Delivered events require explicit ack --event. Readiness never authorizes a merge."] };
      const envelope = { ok: true, data };
      deps.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
      return { exitCode: 0, envelope };
    }
    const { command, values } = parseCommand(argv);
    const context = contextFor(values, deps);
    const result = await COMMANDS[command](values, deps, context);
    const envelope = { ok: true, data: { command, ...result.data } };
    deps.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    return { exitCode: 0, envelope };
  } catch (error) {
    const envelope = { ok: false, error: errorEnvelope(error) };
    deps.stderr(`${JSON.stringify(envelope, null, 2)}\n`);
    return { exitCode: error instanceof BabysitError ? error.exitCode : 1, envelope };
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  return process.platform === "win32" ? invoked.toLowerCase() === HELPER_PATH.toLowerCase() : invoked === HELPER_PATH;
}

if (invokedDirectly()) {
  const { exitCode } = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}
