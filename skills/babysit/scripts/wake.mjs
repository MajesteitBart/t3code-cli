import { spawn } from "node:child_process";

import { displayRef } from "./state.mjs";
import { BabysitError, cleanText, iso, sha256, usage } from "./util.mjs";

export const EVENT_HISTORY_LIMIT = 50;
/** Consecutive incomplete reads before the watch reports itself degraded. */
export const DEGRADED_AFTER_FAILURES = 3;
const IMMEDIATELY_DEGRADED = new Set(["GITHUB_AUTH_FAILED", "PR_NOT_FOUND", "GH_NOT_FOUND"]);
export const DELIVERY_TIMEOUT_MS = 120_000;
const MAX_LIST_LINES = 25;

/**
 * Errors after which the same key can never succeed: T3 keeps a rejection under its command id, and
 * usage errors repeat. Everything else may or may not have delivered, so it is retried with the same key.
 */
export const REJECTED_CODES = new Set([
  "THREAD_COMMAND_REJECTED",
  "THREAD_NOT_FOUND",
  "THREAD_ARCHIVED",
  "THREAD_ID_REQUIRED",
  "SETTLED_THREAD_CONFIRMATION_REQUIRED",
  "SETTLED_THREAD_DECLINED",
  "T3_PROTOCOL_UNSUPPORTED",
  "PROMPT_REQUIRED",
  "PROMPT_SOURCE_REQUIRED",
  "INVALID_USAGE",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_KEY_UNSUPPORTED_OPTIONS",
]);

// Event identity

/** Chained ids: news that returns to an earlier state still gets a new id, while two ticks that see the same news under the lock agree on one. */
export function eventIdFor(previousId, newsKey) {
  return `evt_${sha256(`${previousId}\u0000${newsKey}`).slice(0, 16)}`;
}

export function idempotencyKeyFor(state, eventId) {
  return `babysit:${sha256(state.prKey).slice(0, 16)}:${eventId}`;
}

function chainHead(state) {
  return state.lastEventId ?? state.events.findLast((event) => !event.redeliveryOf)?.id ?? `genesis:${state.prKey}`;
}

/** The summary the agent last received, so a superseded wake's news is carried into the next one. */
function lastDeliveredSummary(state) {
  const delivered = state.events.findLast((event) => (event.status === "delivered" || event.status === "acked") && event.summary);
  return delivered?.summary ?? state.baselineSummary ?? null;
}

export function unacknowledged(state) {
  return state.events
    .filter((event) => event.status === "delivered")
    .map((event) => ({ id: event.id, kind: event.kind, readiness: event.readiness ?? null, deliveredAt: event.deliveredAt ?? null }));
}

function trimEvents(state) {
  while (state.events.length > EVENT_HISTORY_LIMIT) {
    const index = state.events.findIndex((event) => event.status === "acked" || event.status === "superseded");
    if (index < 0) return;
    state.events.splice(index, 1);
  }
}

// Message text

function safeUrl(url) {
  return typeof url === "string" && /^https:\/\/[^\s]+$/u.test(url) ? cleanText(url, 300) : "";
}

function who(login) {
  return cleanText(login ?? "unknown", 60);
}

/** Lines describing what changed between two summaries from inspect.mjs. */
export function describeChanges(previous, current) {
  if (!current) return [];
  if (current.terminal) {
    return [current.terminal === "merged" ? `Pull request merged${current.mergeCommitSha ? ` as ${current.mergeCommitSha}` : ""}.` : "Pull request closed without merge."];
  }
  if (!previous || previous.terminal) return ["First complete observation for this watch."];
  const lines = [];
  if (previous.readiness !== current.readiness) lines.push(`Readiness: ${previous.readiness ?? "none"} -> ${current.readiness}.`);
  if (previous.headSha !== current.headSha) lines.push(`Head moved: ${previous.headSha ?? "none"} -> ${current.headSha}. Evidence for the earlier head no longer counts.`);
  if (previous.baseSha !== current.baseSha) lines.push(`Base moved: ${previous.baseSha ?? "none"} -> ${current.baseSha}.`);
  for (const [id, review] of Object.entries(current.reviews ?? {})) {
    const before = previous.reviews?.[id];
    if (!before) lines.push(`New review at the head by ${who(review.author)}: ${review.state} ${safeUrl(review.url)}`.trim());
    else if (before.v !== review.v) lines.push(`Review by ${who(review.author)} changed: ${review.state} ${safeUrl(review.url)}`.trim());
  }
  for (const [id, comment] of Object.entries(current.comments ?? {})) {
    const before = previous.comments?.[id];
    if (!before) lines.push(`New comment by ${who(comment.author)}: ${safeUrl(comment.url)}`.trim());
    else if (before.v !== comment.v) lines.push(`Comment by ${who(comment.author)} was edited: ${safeUrl(comment.url)}`.trim());
  }
  for (const [id, finding] of Object.entries(current.findings ?? {})) {
    const before = previous.findings?.[id];
    const where = safeUrl(finding.url) || id;
    if (!before) lines.push(`New unresolved review thread: ${where}`);
    else if (before.status !== finding.status) lines.push(`Review thread is now ${finding.status}: ${where}`);
    else if (before.v !== finding.v) lines.push(`Review thread has new or edited comments: ${where}`);
  }
  for (const [id, finding] of Object.entries(previous.findings ?? {})) {
    if (!current.findings?.[id]) lines.push(`Review thread resolved: ${safeUrl(finding.url) || id}`);
  }
  for (const [key, check] of Object.entries(current.checks ?? {})) {
    const before = previous.checks?.[key];
    if (!before || before.outcome !== check.outcome) lines.push(`Check ${cleanText(check.name, 100)} finished: ${check.outcome}.`);
  }
  for (const reaction of current.reactions ?? []) {
    if (!(previous.reactions ?? []).includes(reaction)) lines.push(`New reviewer reaction without a commit: ${cleanText(reaction, 80)}.`);
  }
  const before = new Set(previous.reasons ?? []);
  const after = new Set(current.reasons ?? []);
  for (const reason of after) if (!before.has(reason)) lines.push(`New reason: ${cleanText(reason, 140)}.`);
  for (const reason of before) if (!after.has(reason)) lines.push(`Cleared: ${cleanText(reason, 140)}.`);
  return lines;
}

/** ` (1 P1, 3 P2)` for open findings, or nothing when there are none. */
function severityBreakdown(findings) {
  if (findings.length === 0) return "";
  const counts = new Map();
  for (const finding of findings) counts.set(finding.severity ?? "unrated", (counts.get(finding.severity ?? "unrated") ?? 0) + 1);
  return ` (${[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([severity, count]) => `${count} ${severity}`).join(", ")})`;
}

function clipped(lines) {
  return lines.length <= MAX_LIST_LINES ? lines : [...lines.slice(0, MAX_LIST_LINES), `(${lines.length - MAX_LIST_LINES} more; run inspect)`];
}

/**
 * The wake message. It holds ids, SHAs, reason codes, and links, never comment text, and no clock
 * time, so the same inputs always render the same bytes.
 */
export function renderWakeText({ state, eventId, previousId, kind, inspection, changes, degraded, earlier, command }) {
  const ref = displayRef(state.pr);
  const lines = [];
  if (kind === "terminal") lines.push(`[babysit] ${ref} finished: ${inspection.terminal}`);
  else if (kind === "degraded") lines.push(`[babysit] ${ref} readiness: unknown (monitoring degraded)`);
  else lines.push(`[babysit] ${ref} readiness: ${inspection.readiness}`);
  lines.push(`Event: ${eventId} (previous: ${previousId.startsWith("genesis:") ? "none" : previousId})`);
  if (safeUrl(state.pr.url)) lines.push(`PR: ${safeUrl(state.pr.url)}`);
  if (kind === "degraded") {
    lines.push(`GitHub could not be read completely: ${degraded.code}${degraded.detail ? ` (${cleanText(degraded.detail, 200)})` : ""}.`);
    lines.push(`Failed reads in a row: ${degraded.failures}. Readiness stays unknown until a complete read succeeds.`);
  } else if (kind !== "terminal") {
    const tested = inspection.tested;
    const review = inspection.codeReview;
    lines.push(`Head: ${inspection.pr.headSha}`);
    lines.push(`Tested: ${tested.sha ?? "none"}${tested.sha ? ` (${tested.result}${tested.matchesHead ? ", matches head" : ", not the head"})` : ""}`);
    lines.push(
      `Code review at head: ${review.reviewsAtHead.length} submitted, ${review.evidenceAtHead.length} recorded evidence, ${review.unboundSignals.length} unbound signal${review.unboundSignals.length === 1 ? "" : "s"}. Review rounds so far: ${review.rounds ?? "unknown"}.`,
    );
    const deferred = inspection.findings.discharged.filter((finding) => finding.decision === "deferred").length;
    lines.push(
      `Open findings: ${inspection.findings.open.length}${severityBreakdown(inspection.findings.open)}; deferred: ${deferred}; CI: ${inspection.ci.state}; security review: ${inspection.securityReview.state}.`,
    );
  }
  lines.push("Changes since the last delivered wake:");
  lines.push(...clipped(changes.length > 0 ? changes : ["None beyond the state above."]).map((line) => `- ${line}`));
  if (kind === "observation") {
    lines.push("Reasons:");
    lines.push(
      ...clipped(
        inspection.reasons.length > 0
          ? inspection.reasons.map((reason) => `${reason.level} ${reasonLabel(reason)}`)
          : ["none; ready still needs a live re-check before merging."],
      ).map((line) => `- ${line}`),
    );
  }
  if (kind === "observation" && (inspection.next ?? []).length > 0) {
    lines.push("Next:");
    lines.push(...inspection.next.map((action) => `- ${action}`));
  }
  lines.push(`Unacknowledged earlier wakes: ${earlier.length > 0 ? earlier.map((event) => event.id).join(", ") : "none"}.`);
  lines.push("This is news, not merge approval. Re-read the live pull request and verify every gate before merging (babysit skill, section 6).");
  lines.push(`Inspect: ${command("inspect")}`);
  lines.push(`After handling it: ${command("ack", ["--event", eventId])}`);
  return lines.join("\n");
}

function reasonLabel(reason) {
  const subject = reason.subject ? `: ${reason.subject}` : "";
  const detail = reason.detail ? ` (${reason.detail})` : "";
  return cleanText(`${reason.code}${subject}${detail}`, 200);
}

function newEvent(state, spec, context) {
  const previousId = chainHead(state);
  const id = eventIdFor(previousId, spec.newsKey);
  const changes = spec.kind === "degraded" ? [] : describeChanges(lastDeliveredSummary(state), spec.summary);
  const earlier = unacknowledged(state);
  const text = renderWakeText({
    state,
    eventId: id,
    previousId,
    kind: spec.kind,
    inspection: spec.inspection,
    changes,
    degraded: spec.degraded,
    earlier,
    command: context.command,
  });
  // A wake that never left is replaced by this one, which carries its news.
  for (const event of state.events) {
    if (event.status === "pending" && !event.redeliveryOf) {
      event.status = "superseded";
      event.supersededBy = id;
      event.nextAttemptAt = null;
    }
  }
  const event = {
    id,
    previousId,
    kind: spec.kind,
    newsKey: spec.newsKey,
    readiness: spec.kind === "degraded" ? "unknown" : (spec.inspection?.readiness ?? null),
    terminal: spec.inspection?.terminal ?? null,
    summary: spec.summary ?? null,
    createdAt: iso(context.now()),
    text,
    textSha256: sha256(text),
    idempotencyKey: idempotencyKeyFor(state, id),
    status: "pending",
    attempts: [],
    nextAttemptAt: null,
    deliveredAt: null,
    ackedAt: null,
  };
  state.events.push(event);
  state.lastEventId = event.id;
  trimEvents(state);
  return event;
}

function compactReason(reason) {
  return { level: reason.level, code: reason.code, ...(reason.subject ? { subject: reason.subject } : {}) };
}

/**
 * Records an inspection in the state and creates a wake event when the news changed. `baseline`
 * records the first observation without an event. Incomplete reads never create observation events;
 * repeated or fatal ones create one `degraded` event.
 */
export function recordObservation(state, inspection, context) {
  const at = iso(context.now());
  const health = state.health ?? { consecutiveFailures: 0 };
  if (inspection.terminal || inspection.complete) {
    state.health = { consecutiveFailures: 0, lastSuccessAt: at, lastErrorCode: null, lastErrorAt: health.lastErrorAt ?? null, lastErrorDetail: null };
    const previousKey = state.lastObservation?.newsKey ?? null;
    state.lastObservation = {
      at,
      complete: inspection.complete,
      headSha: inspection.pr?.headSha ?? null,
      readiness: inspection.readiness,
      terminal: inspection.terminal,
      reasons: inspection.reasons.map(compactReason),
      newsKey: inspection.newsKey,
      fingerprint: inspection.fingerprint,
      summary: inspection.summary,
      degraded: null,
    };
    if (inspection.terminal && !state.stoppedAt) {
      state.stoppedAt = at;
      state.stopReason = inspection.terminal;
    }
    const stopIfFinished = () => {
      if (inspection.terminal && !state.stoppedAt) {
        state.stoppedAt = at;
        state.stopReason = inspection.terminal;
      }
    };
    if (context.baseline) {
      state.baselineSummary = inspection.summary;
      stopIfFinished();
      return { event: null };
    }
    if (previousKey === inspection.newsKey) {
      stopIfFinished();
      return { event: null };
    }
    const kind = inspection.terminal ? "terminal" : "observation";
    const event = newEvent(state, { kind, newsKey: inspection.newsKey, summary: inspection.summary, inspection }, context);
    stopIfFinished();
    return { event };
  }

  const code = inspection.error?.code ?? "FETCH_INCOMPLETE";
  const detail = inspection.error?.detail ?? null;
  const failures = (health.consecutiveFailures ?? 0) + 1;
  state.health = { ...health, consecutiveFailures: failures, lastErrorCode: code, lastErrorAt: at, lastErrorDetail: detail };
  if (context.baseline) return { event: null };
  if (failures < DEGRADED_AFTER_FAILURES && !IMMEDIATELY_DEGRADED.has(code)) return { event: null };
  const newsKey = `degraded:${code}`;
  if (state.lastObservation?.newsKey === newsKey) return { event: null };
  const summary = state.lastObservation?.summary ?? null;
  const event = newEvent(state, { kind: "degraded", newsKey, summary, degraded: { code, detail, failures } }, context);
  // The last complete observation stays as it was; only its news key moves, so recovery is news again.
  state.lastObservation = { ...(state.lastObservation ?? { at: null, summary: null }), newsKey, degraded: code };
  return { event };
}

/** A copy of an event under a new key, made only on explicit request. */
export function redeliveryOf(state, sourceId, context) {
  const source = state.events.find((event) => event.id === sourceId);
  if (!source) throw new BabysitError("EVENT_NOT_FOUND", `No event ${sourceId} is recorded for ${displayRef(state.pr)}.`, { exitCode: 3, details: { eventId: sourceId } });
  if (source.status === "pending") {
    throw new BabysitError("EVENT_STILL_PENDING", `Event ${sourceId} is still being delivered under its own key; let tick retry it, or acknowledge it.`, {
      exitCode: 4,
      details: { eventId: sourceId },
    });
  }
  const originalId = source.redeliveryOf ?? source.id;
  const original = state.events.find((event) => event.id === originalId) ?? source;
  // A durable counter survives history pruning; never recycle an old delivery key.
  state.redeliveryCounts ??= {};
  const previousCount = Math.max(state.redeliveryCounts[originalId] ?? 0,
    ...state.events.filter((event) => event.redeliveryOf === originalId)
      .map((event) => Number(event.id.match(/\.r(\d+)$/u)?.[1] ?? 0)));
  const count = previousCount + 1;
  state.redeliveryCounts[originalId] = count;
  const id = `${originalId}.r${count}`;
  const originalText = original.text.replace(/^After handling it:.*$/gmu, "");
  const text = `[babysit] Redelivery ${count} of ${originalId}, requested explicitly; the earlier message may also have arrived.\n${originalText}\nAfter handling this redelivery: ${context.command("ack", ["--event", id])}`;
  const event = {
    id,
    previousId: original.previousId ?? null,
    redeliveryOf: originalId,
    kind: original.kind,
    newsKey: original.newsKey,
    readiness: original.readiness ?? null,
    terminal: original.terminal ?? null,
    summary: original.summary ?? null,
    createdAt: iso(context.now()),
    text,
    textSha256: sha256(text),
    idempotencyKey: idempotencyKeyFor(state, id),
    status: "pending",
    attempts: [],
    nextAttemptAt: null,
    deliveredAt: null,
    ackedAt: null,
  };
  state.events.push(event);
  trimEvents(state);
  return event;
}

// Delivery through the t3code CLI

function parseEnvelope(text) {
  try {
    return JSON.parse(String(text ?? "").trim());
  } catch {
    return null;
  }
}

/** ok, rejected (terminal for this key), or ambiguous (retry with the same key and text). */
export function classifyCliResult(raw) {
  if (raw.spawnError) return { result: "ambiguous", code: "CLI_SPAWN_FAILED", message: cleanText(raw.spawnError, 300) };
  if (raw.missing) return { result: "ambiguous", code: "CLI_NOT_FOUND", message: `The t3code CLI is missing at ${raw.missing}.` };
  if (raw.timedOut) return { result: "ambiguous", code: "CLI_TIMEOUT", message: "t3code did not finish; the message may or may not have arrived." };
  if (raw.exitCode === 0) {
    const envelope = parseEnvelope(raw.stdout);
    const data = envelope?.ok === true ? envelope.data : null;
    const messageId = data?.message?.messageId;
    if (typeof messageId !== "string" || data?.verification?.accepted !== true) {
      return { result: "ambiguous", code: "CLI_OUTPUT_UNVERIFIED", message: "t3code exited without a verified message id." };
    }
    return {
      result: "ok",
      messageId,
      commandId: data.command?.commandId ?? data.idempotency?.commandId ?? null,
      deduplicated: data.idempotency?.deduplicated ?? null,
    };
  }
  const envelope = parseEnvelope(raw.stderr);
  const code = typeof envelope?.error?.code === "string" ? envelope.error.code : null;
  const message = cleanText(envelope?.error?.message ?? raw.stderr ?? "", 300);
  if (raw.exitCode === 2 || (code !== null && REJECTED_CODES.has(code))) return { result: "rejected", code: code ?? "CLI_USAGE", message };
  return { result: "ambiguous", code: code ?? "CLI_FAILED", message };
}

/** Minutes to wait after the nth ambiguous attempt: 1, 2, 4, ... up to an hour. */
export function retryDelayMs(ambiguousAttempts) {
  return Math.min(60, 2 ** Math.max(0, ambiguousAttempts - 1)) * 60_000;
}

export function sendArgs(state, event) {
  return [
    "--json",
    "threads",
    "send",
    "--thread",
    state.delivery.threadId,
    "--stdin",
    "--if-busy",
    "queue",
    "--idempotency-key",
    event.idempotencyKey,
    "--no-start-desktop",
    ...(state.delivery.wakeSettled ? ["--wake-settled"] : []),
  ];
}

/**
 * Sends one pending event with its stored key and its stored text, byte for byte. Updates the event
 * and returns the classified outcome; the caller saves the state.
 */
export async function deliverEvent(state, event, deps) {
  if (state.delivery?.type !== "t3-thread") throw usage("NO_DELIVERY_TARGET", `The watch for ${displayRef(state.pr)} has no T3 thread to deliver to; run init with --thread.`);
  if (sha256(event.text) !== event.textSha256) {
    throw new BabysitError("STATE_CORRUPT", `The stored text of event ${event.id} no longer matches its hash; it was not sent.`, { details: { eventId: event.id } });
  }
  const cliPath = state.delivery.cliPath;
  const raw =
    cliPath && (await deps.fileExists(cliPath))
      ? await deps.runCli({ cliPath, args: sendArgs(state, event), input: event.text, timeoutMs: DELIVERY_TIMEOUT_MS, env: state.delivery.env })
      : { missing: cliPath ?? "(not configured)" };
  const outcome = classifyCliResult(raw);
  const at = iso(deps.now());
  event.attempts.push({
    at,
    result: outcome.result,
    code: outcome.code ?? null,
    ...(outcome.messageId ? { messageId: outcome.messageId, commandId: outcome.commandId, deduplicated: outcome.deduplicated } : {}),
  });
  if (outcome.result === "ok") {
    event.status = "delivered";
    event.deliveredAt = at;
    event.nextAttemptAt = null;
  } else if (outcome.result === "rejected") {
    event.status = "rejected";
    event.rejectedCode = outcome.code;
    event.nextAttemptAt = null;
  } else {
    const ambiguous = event.attempts.filter((attempt) => attempt.result === "ambiguous").length;
    event.nextAttemptAt = iso(deps.now() + retryDelayMs(ambiguous));
  }
  return outcome;
}

/** Runs the t3code CLI with Node, with no shell, and writes the message to its stdin. */
export function spawnCli({ cliPath, args, input, timeoutMs, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cliPath, ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env } });
    } catch (error) {
      resolve({ spawnError: String(error?.message ?? error) });
      return;
    }
    const stdout = [];
    const stderr = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    const keep = (chunks) => (chunk) => {
      if (size >= 4_000_000) return;
      chunks.push(chunk);
      size += chunk.length;
    };
    child.stdout.on("data", keep(stdout));
    child.stderr.on("data", keep(stderr));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.on("error", (error) => finish({ spawnError: String(error?.message ?? error) }));
    child.on("close", (exitCode) =>
      finish({ exitCode, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(input, "utf8"));
  });
}
