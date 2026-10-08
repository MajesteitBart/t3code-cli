import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  lockPathFor,
  parsePrRef,
  prKey,
  readState,
  recoverStaleLock,
  STATE_SCHEMA,
  statePathFor,
  withLock,
  writeFileAtomic,
  writeState,
} from "../../skills/babysit/scripts/state.mjs";
import { REVIEWER } from "./fixtures.mjs";

let directory;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "babysit-state-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const deps = (overrides = {}) => ({ now: () => Date.now(), isAlive: () => true, hostname: "test-host", pid: process.pid, ...overrides });

function minimalState() {
  return {
    schema: STATE_SCHEMA,
    prKey: "github.com/acme/widgets#5",
    pr: { host: "github.com", owner: "acme", repo: "widgets", number: 5, url: null },
    policy: { codeReviewers: [REVIEWER], securityCheckPatterns: [], requiredChecks: [] },
    delivery: { type: "none" },
    events: [],
  };
}

describe("pull request references", () => {
  it("accepts short references and URLs, and maps every capitalization to one state file", () => {
    const short = parsePrRef("Acme/Widgets#5");
    const url = parsePrRef("https://GitHub.com/acme/widgets/pull/5/files?w=1");
    const enterprise = parsePrRef("github.example.com/acme/widgets#7");

    expect(short).toEqual({ host: "github.com", owner: "Acme", repo: "Widgets", number: 5 });
    expect(url).toEqual({ host: "github.com", owner: "acme", repo: "widgets", number: 5 });
    expect(enterprise.host).toBe("github.example.com");
    expect(prKey(short)).toBe(prKey(url));
    expect(statePathFor(directory, short)).toBe(statePathFor(directory, url));
    expect(statePathFor(directory, short)).toBe(path.join(directory, "github.com", "acme", "widgets", "pr-5.json"));
  });

  it("rejects references that are not a pull request", () => {
    const failure = (raw) => {
      try {
        parsePrRef(raw);
      } catch (error) {
        return error;
      }
      return null;
    };
    for (const raw of ["", "acme/widgets", "acme/widgets#0", "http://github.com/acme/widgets/pull/5", "https://github.com/acme/widgets/issues/5", "../x/y#1", "acme/..#1", "acme/widgets#5; rm"]) {
      expect(failure(raw)?.exitCode, raw).toBe(2);
    }
  });
});

describe("state file", () => {
  it("round-trips through an atomic write and leaves no temporary files", async () => {
    const statePath = path.join(directory, "pr-5.json");
    await writeState(statePath, minimalState());

    expect(await readState(statePath)).toMatchObject({ schema: STATE_SCHEMA, prKey: "github.com/acme/widgets#5" });
    expect(await readdir(directory)).toEqual(["pr-5.json"]);
    expect(await readState(path.join(directory, "missing.json"))).toBeNull();
  });

  it("reports a damaged or foreign file and never replaces it", async () => {
    const statePath = path.join(directory, "pr-5.json");
    await writeFile(statePath, "{ not json");
    await expect(readState(statePath)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    expect(await readFile(statePath, "utf8")).toBe("{ not json");

    await writeFile(statePath, JSON.stringify({ ...minimalState(), schema: "babysit.pr-state/9" }));
    await expect(readState(statePath)).rejects.toMatchObject({ code: "STATE_SCHEMA_UNSUPPORTED" });

    await writeFile(statePath, JSON.stringify({ ...minimalState(), events: [{ id: "evt_1" }] }));
    await expect(readState(statePath)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
  });

  it("removes its temporary file when the lock check fails before the rename", async () => {
    const target = path.join(directory, "pr-5.json");
    await writeFile(target, "original");
    const lost = Object.assign(new Error("lost"), { code: "LOCK_LOST" });

    await expect(writeFileAtomic(target, "new", { assertHeld: async () => Promise.reject(lost) })).rejects.toBe(lost);
    expect(await readFile(target, "utf8")).toBe("original");
    expect(await readdir(directory)).toEqual(["pr-5.json"]);
  });
});

describe("lock", () => {
  const lockBody = (overrides = {}) => JSON.stringify({ pid: 424242, hostname: "test-host", token: "other-token", acquiredAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), ...overrides });

  it("runs alone and releases its lock", async () => {
    const statePath = path.join(directory, "pr-5.json");
    const result = await withLock(statePath, async () => "done", deps());

    expect(result).toEqual({ locked: false, value: "done" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("never takes over a live owner's lock, however old it is", async () => {
    const statePath = path.join(directory, "pr-5.json");
    const body = lockBody();
    await writeFile(lockPathFor(statePath), body);
    let ran = false;

    const result = await withLock(statePath, async () => (ran = true), deps({ isAlive: () => true }));

    expect(ran).toBe(false);
    expect(result).toMatchObject({ locked: true, owner: { state: "held", why: "owner-alive", pid: 424242 } });
    expect(result.owner.ageMs).toBeGreaterThan(2 * 3_600_000);
    expect(await readFile(lockPathFor(statePath), "utf8")).toBe(body);
  });

  it("leaves a lock from another host alone", async () => {
    const statePath = path.join(directory, "pr-5.json");
    await writeFile(lockPathFor(statePath), lockBody({ hostname: "other-host" }));

    expect(await withLock(statePath, async () => "ran", deps({ isAlive: () => false }))).toMatchObject({ locked: true, owner: { why: "other-host" } });
  });

  it("recovers the lock of a dead owner", async () => {
    const statePath = path.join(directory, "pr-5.json");
    await writeFile(lockPathFor(statePath), lockBody());

    const result = await withLock(statePath, async () => "ran", deps({ isAlive: (pid) => pid !== 424242 }));

    expect(result).toEqual({ locked: false, value: "ran" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("treats an unreadable lock as held for a minute, then as abandoned", async () => {
    const statePath = path.join(directory, "pr-5.json");
    const lockPath = lockPathFor(statePath);
    await writeFile(lockPath, "");
    expect((await withLock(statePath, async () => "ran", deps())).locked).toBe(true);

    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(lockPath, old, old);
    expect(await withLock(statePath, async () => "ran", deps())).toEqual({ locked: false, value: "ran" });
  });

  it("puts back a lock that a recovering process took after the stale one was inspected", async () => {
    const lockPath = path.join(directory, "pr-5.json.lock");
    const fresh = lockBody({ token: "new-owner", pid: process.pid });
    await writeFile(lockPath, fresh);

    expect(await recoverStaleLock(lockPath, lockBody())).toBe(false);
    expect(await readFile(lockPath, "utf8")).toBe(fresh);
    expect((await readdir(directory)).sort()).toEqual(["pr-5.json.lock"]);
  });

  it("refuses to write state after losing the lock", async () => {
    const statePath = path.join(directory, "pr-5.json");
    await mkdir(directory, { recursive: true });
    const result = withLock(
      statePath,
      async (lock) => {
        await writeFile(lockPathFor(statePath), lockBody({ token: "intruder" }));
        await writeState(statePath, minimalState(), lock.assertHeld);
      },
      deps(),
    );

    await expect(result).rejects.toMatchObject({ code: "LOCK_LOST" });
    expect(await readState(statePath)).toBeNull();
    // The intruder's lock is not released by the process that lost it.
    expect(JSON.parse(await readFile(lockPathFor(statePath), "utf8")).token).toBe("intruder");
  });
});
