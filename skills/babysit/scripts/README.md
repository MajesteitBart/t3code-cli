# babysit helper

`babysit.mjs` is the babysit skill's shared PR watcher. It replaces hand-written pollers. It needs Node 22 or later and has no dependencies. It reads GitHub through `gh`, keeps durable state for each pull request, and sends wake messages to a T3 thread through `t3code threads send --idempotency-key`.

Every command prints one JSON envelope: `{ "ok": true, "data": … }` on stdout, or `{ "ok": false, "error": { "code", "message", "details" } }` on stderr.

```
node babysit.mjs <command> --pr owner/repo#N [--state-dir DIR] [options]
```

| Command | What it does |
| --- | --- |
| `init --code-reviewer LOGIN [--thread ID] [--wake-settled] [--security-check REGEX]… [--required-check NAME]… [--t3code-cli PATH] [--gh PATH]` | Creates the watch and records a baseline, so the current state is not reported as news later. There is no default reviewer; the skill passes `chatgpt-codex-connector[bot]`. Without `--thread`, only `wait` can deliver. |
| `inspect` | Reads GitHub and prints the classification without writing anything. If no state exists, pass `--code-reviewer`. |
| `record --tested SHA --result pass\|fail --command CMD…` | Records local verification of a full head SHA. |
| `record --review-request --head SHA --url COMMENT_URL` | Records an `@codex review` request. The URL must point into this PR. |
| `record --review-evidence --head SHA --url SOURCE --note TEXT` | Records corroborating evidence that the review of that exact head is complete. |
| `record --watcher t3-native\|os-schedule\|session-wait\|none [--watcher-id ID] [--cancel-command CMD]` | Records how the watch wakes the agent. |
| `decide --finding THREAD_ID… --decision fixed\|refuted\|deferred --evidence TEXT [--commit SHA] [--user-approved]` | Discharges review threads as they read now, all or none. A later comment or an edit reopens one. Deferring a P0, P1, or unrated finding also needs `--user-approved`. |
| `tick` | One scheduled poll. Reads GitHub, creates an event when there is news, and delivers any due event. It never acknowledges an event. |
| `wait [--timeout 30m] [--interval 60s]` | In-session polling. Prints the next event; printing it counts as delivery. |
| `ack --event ID… [--note TEXT]` | Marks events handled once the agent has finished the work they called for. |
| `status` | Shows state, watcher verification, delivered events still unacknowledged, pending and rejected events, and the lock. No network. |
| `wake --redeliver ID` | Sends a copy of an event under a new key, only on explicit request. |
| `stop --reason merged\|closed\|cancelled` | Stops the watch and cancels undelivered events. It does not remove a scheduled task: run the printed cancel command for that. |
| `schedule-command [--interval 5] [--platform win32\|linux\|darwin]` | Prints the commands to register and cancel a scheduled tick. On Windows it also writes the hidden launcher next to the state file. It never registers or starts anything. |

## Readiness

`ready` requires a complete, consistent read in which all of the following hold:

- Every check reported and passed, and every check's required status is known.
- No required check is missing, and none was skipped.
- The tested SHA is the head.
- Recorded review evidence names the exact head, and the reviewer has not been active since it was recorded.
- No unresolved thread lacks a matching decision. A deferred finding counts as decided.
- GitHub's merge state is clean.

Open findings report their Codex priority (`P0` to `P3`) as `severity`, null when the thread has no badge or a non-reviewer opened it; only that token is read from comment bodies. `codeReview.rounds` counts the commits the reviewer reviewed, and `next` lists the actions the current reasons call for.

Anything not finished is `pending`. Anything unexplained is `unknown`. A review submitted at the head proves only that a review was submitted. Comments and reactions carry no commit, so they are reported as unbound signals and are never assigned to a head. Readiness is news, not merge approval; skill section 6 still applies.

Recording new review evidence reads a complete live snapshot of the same head and captures its reviewer reactions. A later reaction outside that set withdraws readiness. Repeating a head/source URL keeps its original timestamp, note, and reaction set; a new completed review needs a new source URL.

An observed resolution invalidates the prior finding decision, so reopening with unchanged comments needs a fresh decision. Observation happens during `tick`, `wait`, `decide`, or a new review-evidence record; `inspect` remains read-only. A resolution/reopening cycle that occurs entirely between observations cannot be detected from GitHub's current thread state. Re-read live threads before merging.

## Delivery

Each event stores its rendered text and SHA-256. Each send uses the event's idempotency key and that exact text, queued behind any running turn and without starting T3 Code.

| Outcome | Status | What happens next |
| --- | --- | --- |
| Success | `delivered` | Waits for `ack`. |
| Rejection: T3 rejected it, the thread is gone, the thread is settled without `--wake-settled`, or usage | `rejected` | The tick exits 3. The event is never retried under that key. |
| Anything else | stays `pending` | Retried with the same key and text after 1, 2, 4… up to 60 minutes. The tick exits 5. |

A newer event supersedes a pending one and carries its news forward.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Damaged state or an unexpected error |
| 2 | Usage error |
| 3 | Not found, or delivery rejected |
| 4 | Conflict, or the lock has been held for over an hour |
| 5 | Delivery pending retry, or GitHub read incomplete for `decide` |
| 6 | `wait` timed out |

## State

State lives at `~/.babysit/v1/<host>/<owner>/<repo>/pr-<n>.json`; every path segment is lowercase. Override the directory with `--state-dir` or `BABYSIT_STATE_DIR`.

- Writes go through a temporary file and a rename.
- A damaged file is reported, never replaced.
- A lock is taken over only when its owner is a dead process on this host, or when the lock is unreadable and older than a minute.
