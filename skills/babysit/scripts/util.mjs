import { createHash } from "node:crypto";

/** A failure with a stable code and exit code, reported in the `{ ok: false, error }` envelope. */
export class BabysitError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "BabysitError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function usage(code, message, details) {
  return new BabysitError(code, message, { exitCode: 2, ...(details === undefined ? {} : { details }) });
}

export function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** JSON with sorted keys, so equal values always hash alike. */
export function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

// Control, line-separator, zero-width, and bidirectional-override characters.
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f​-‏\u2028\u2029‪-‮⁦-⁩]+/gu;

/** One line of untrusted text (check names, logins, GitHub errors), clipped to `limit` characters. */
export function cleanText(value, limit = 120) {
  const text = String(value ?? "")
    .replace(UNSAFE_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Compares GitHub logins: GraphQL omits the `[bot]` suffix that REST and the UI show. */
export function loginKey(login) {
  return String(login ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/u, "");
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** A full commit SHA, never an abbreviation, so evidence binds to exactly one commit. */
export function requireFullSha(value, flag) {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!FULL_SHA.test(sha)) throw usage("FULL_SHA_REQUIRED", `${flag} needs a full 40-character commit SHA, not ${JSON.stringify(value ?? "")}.`);
  return sha;
}

const DURATION_UNITS = { s: 1_000, m: 60_000, h: 3_600_000 };

/** Parses durations such as 90s, 30m, or 1h30m into milliseconds; null when the text is not one. */
export function parseDuration(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (!/^(\d+[smh])+$/u.test(value)) return null;
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+)([smh])/gu)) total += Number(amount) * DURATION_UNITS[unit];
  return total;
}

export function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
