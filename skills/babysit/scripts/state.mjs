import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { BabysitError, sleep, usage } from "./util.mjs";

export const STATE_SCHEMA = "babysit.pr-state/1";
/** A lock file nobody could parse is treated as abandoned only after this long. */
export const UNREADABLE_LOCK_STALE_MS = 60_000;
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPO = /^[A-Za-z0-9._-]{1,100}$/u;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,252})(?::\d{1,5})?$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/iu;

// Pull request references

function badRef(raw) {
  return usage("INVALID_PR", `Pass --pr as owner/repo#number, host/owner/repo#number, or a pull request URL, not ${JSON.stringify(raw)}.`);
}

/** Parses `owner/repo#5`, `host/owner/repo#5`, or `https://host/owner/repo/pull/5`. */
export function parsePrRef(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw usage("PR_REQUIRED", "Pass --pr as owner/repo#number or a pull request URL.");
  let host;
  let owner;
  let repo;
  let number;
  if (/^[a-z]+:\/\//iu.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      throw badRef(text);
    }
    if (url.protocol !== "https:") throw badRef(text);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[2] !== "pull") throw badRef(text);
    host = url.host.toLowerCase();
    [owner, repo, , number] = parts;
  } else {
    const match = /^(?:([^/#\s]+)\/)?([^/#\s]+)\/([^/#\s]+)#(\d+)$/u.exec(text);
    if (!match) throw badRef(text);
    host = (match[1] ?? "github.com").toLowerCase();
    [, , owner, repo, number] = match;
  }
  if (host === "www.github.com") host = "github.com";
  if (repo.toLowerCase().endsWith(".git")) repo = repo.slice(0, -4);
  if (!HOST.test(host) || !OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") throw badRef(text);
  const parsed = Number(number);
  if (!/^\d+$/u.test(String(number)) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) throw badRef(text);
  return { host, owner, repo, number: parsed };
}

export function displayRef(ref) {
  const base = `${ref.owner}/${ref.repo}#${ref.number}`;
  return ref.host === "github.com" ? base : `${ref.host}/${base}`;
}

/** Identifies a pull request regardless of how its host, owner, or name were capitalized. */
export function prKey(ref) {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
}

function safeSegment(value) {
  const lower = value.toLowerCase().replace(/:/gu, "_");
  return WINDOWS_RESERVED.test(lower) ? `${lower}_` : lower;
}

export function statePathFor(stateDir, ref) {
  return path.join(stateDir, safeSegment(ref.host), safeSegment(ref.owner), safeSegment(ref.repo), `pr-${ref.number}.json`);
}

export function lockPathFor(statePath) {
  return `${statePath}.lock`;
}

// State file

function stateProblem(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return "it is not an object";
  if (state.schema !== STATE_SCHEMA) return `its schema is ${JSON.stringify(state.schema ?? null)}`;
  const pr = state.pr;
  if (!pr || typeof pr.host !== "string" || typeof pr.owner !== "string" || typeof pr.repo !== "string" || !Number.isInteger(pr.number)) {
    return "it names no pull request";
  }
  if (typeof state.prKey !== "string") return "it has no pull request key";
  if (!state.policy || !Array.isArray(state.policy.codeReviewers) || state.policy.codeReviewers.length === 0) return "it names no code reviewer";
  if (!state.delivery || typeof state.delivery.type !== "string") return "it has no delivery target";
  if (!Array.isArray(state.events)) return "it has no event list";
  for (const event of state.events) {
    if (!event || typeof event.id !== "string" || typeof event.text !== "string" || typeof event.textSha256 !== "string" || typeof event.status !== "string") {
      return "an event is malformed";
    }
  }
  return null;
}

/** Reads a state file; null when it does not exist. A damaged file is reported and never replaced. */
export async function readState(statePath) {
  let raw;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new BabysitError("STATE_CORRUPT", `The babysit state file ${statePath} is not valid JSON. It was left untouched; repair or move it before continuing.`, {
      details: { statePath },
    });
  }
  const problem = stateProblem(state);
  if (problem) {
    const unsupported = state && typeof state === "object" && typeof state.schema === "string" && state.schema !== STATE_SCHEMA;
    throw new BabysitError(
      unsupported ? "STATE_SCHEMA_UNSUPPORTED" : "STATE_CORRUPT",
      `The babysit state file ${statePath} cannot be used because ${problem}. It was left untouched.`,
      { details: { statePath } },
    );
  }
  return state;
}

/** Writes through a temporary file and a rename, so readers see the old or the new file, never part of one. */
export async function writeFileAtomic(target, content, options = {}) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (options.assertHeld) await options.assertHeld();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, target);
        return;
      } catch (error) {
        // Windows refuses to replace a file another process has open for a moment.
        if (!RENAME_RETRY_CODES.has(error?.code) || attempt >= 9) throw error;
        await sleep(25 * (attempt + 1));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeState(statePath, state, assertHeld) {
  await writeFileAtomic(statePath, `${JSON.stringify({ ...state, schema: STATE_SCHEMA }, null, 2)}\n`, assertHeld ? { assertHeld } : {});
}

// Lock

/** Process liveness for lock recovery. EPERM means the process exists but belongs to someone else. */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * Describes the lock: `free`, `held`, or `stale`. Only a lock whose owner is a dead process on this
 * host, or an unreadable lock older than a minute, is stale. A live owner keeps its lock however long
 * it runs, and an owner on another host cannot be checked, so its lock stays held.
 */
export async function readLockInfo(lockPath, deps) {
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "free" };
    throw error;
  }
  let owner = null;
  try {
    owner = JSON.parse(raw);
  } catch {
    owner = null;
  }
  if (!owner || typeof owner.token !== "string") {
    let modifiedMs;
    try {
      modifiedMs = (await stat(lockPath)).mtimeMs;
    } catch (error) {
      if (error?.code === "ENOENT") return { state: "free" };
      throw error;
    }
    const ageMs = Math.max(0, deps.now() - modifiedMs);
    return { state: ageMs > UNREADABLE_LOCK_STALE_MS ? "stale" : "held", raw, owner: null, ageMs, why: "unreadable" };
  }
  const acquiredMs = Date.parse(owner.acquiredAt);
  const ageMs = Number.isFinite(acquiredMs) ? Math.max(0, deps.now() - acquiredMs) : null;
  if (owner.hostname !== deps.hostname) return { state: "held", raw, owner, ageMs, why: "other-host" };
  if (!Number.isInteger(owner.pid) || deps.isAlive(owner.pid)) return { state: "held", raw, owner, ageMs, why: "owner-alive" };
  return { state: "stale", raw, owner, ageMs, why: "owner-dead" };
}

export function describeLock(info) {
  return {
    state: info.state,
    why: info.why ?? null,
    pid: info.owner?.pid ?? null,
    hostname: info.owner?.hostname ?? null,
    acquiredAt: info.owner?.acquiredAt ?? null,
    ageMs: info.ageMs ?? null,
  };
}

/**
 * Removes a stale lock without deleting one that a recovering process took meanwhile: the lock moves
 * aside first, and if the moved file is not the stale one this process inspected, it goes back.
 */
export async function recoverStaleLock(lockPath, rawSeen) {
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, aside);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (RENAME_RETRY_CODES.has(error?.code)) return false;
    throw error;
  }
  const moved = await readFile(aside, "utf8").catch(() => null);
  if (moved === rawSeen) {
    await rm(aside, { force: true });
    return true;
  }
  // A new owner's lock: restore it. If yet another process holds the path now, the displaced owner's
  // fencing check fails with LOCK_LOST before it writes.
  await link(aside, lockPath).catch(() => {});
  await rm(aside, { force: true });
  return false;
}

export async function acquireLock(lockPath, deps) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomUUID();
    const body = JSON.stringify({ pid: deps.pid, hostname: deps.hostname, token, acquiredAt: new Date(deps.now()).toISOString() });
    let handle = null;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (handle) {
      try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true });
        throw error;
      }
      await handle.close();
      return { acquired: true, token };
    }
    const info = await readLockInfo(lockPath, deps);
    if (info.state === "free") continue;
    if (info.state === "held") return { acquired: false, info };
    if (!(await recoverStaleLock(lockPath, info.raw))) return { acquired: false, info };
  }
  return { acquired: false, info: { state: "held", why: "contended" } };
}

async function lockToken(lockPath) {
  const raw = await readFile(lockPath, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw).token ?? null;
  } catch {
    return null;
  }
}

export async function assertLockHeld(lockPath, token) {
  if ((await lockToken(lockPath)) !== token) {
    throw new BabysitError("LOCK_LOST", `Another process took the babysit lock ${lockPath}; nothing was written.`, { details: { lockPath } });
  }
}

export async function releaseLock(lockPath, token) {
  if ((await lockToken(lockPath)) === token) await rm(lockPath, { force: true });
}

/**
 * Runs `run` while holding the pull request's lock. Returns `{ locked: true, owner }` without running
 * it when another live process holds the lock.
 */
export async function withLock(statePath, run, deps) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const lockPath = lockPathFor(statePath);
  const lock = await acquireLock(lockPath, deps);
  if (!lock.acquired) return { locked: true, owner: describeLock(lock.info) };
  try {
    return { locked: false, value: await run({ assertHeld: () => assertLockHeld(lockPath, lock.token) }) };
  } finally {
    await releaseLock(lockPath, lock.token);
  }
}
