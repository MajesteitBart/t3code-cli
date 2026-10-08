# Shared helper

Use the helper shipped with the modified t3code CLI: `t3code babysit --help`. Direct execution is also available at `skills/babysit/scripts/babysit.mjs` in that package. It needs Node and an authenticated GitHub CLI. Install the updated package before installing this skill; an older t3code CLI lacks the required commands and delivery flags.

`init`, `record`, `decide`, `ack`, and `stop` update local state only. `inspect` reads GitHub and prints evidence. `tick` updates the observation and may deliver a message to the configured thread. `schedule-command` prints commands; it does not register a scheduler itself. Review the actual command help for flags and use `status` to inspect saved state.

## Evidence

Readiness is an aid to final verification, never merge authorization. A submitted review must match the full head commit and configured reviewer; it does not establish exhaustive completion. Record corroborating completed-task evidence explicitly. Code review and security checks remain separate. Unbound reactions, missing checks, incomplete pages, failed API reads, unknown mergeability, and stale tested commits cannot establish readiness. All unresolved findings need a recorded decision: `fixed`, `refuted`, or `deferred`. Later edits or new comments reopen them.

## Findings and rounds

Each open finding carries `severity`, read from the Codex priority badge (`P0` to `P3`) on the thread's first comment. It is null when there is no badge or when someone other than a configured reviewer opened the thread. The helper keeps that token and no other comment text. Reason details start with the severity, such as `P2 src/app.ts:12`.

`decide --decision deferred` discharges a finding without a code change, so it stops blocking readiness. It accepts several `--finding` ids at once and records all or none. It works on its own for P2 and P3. For P0, P1, and unrated findings it also needs `--user-approved`, which is recorded as `userApproved` on those findings only. The helper cannot verify the approval; pass the flag only after the user gave it. A deferral reopens when the finding's severity changes to one it was not allowed for, such as a P2 that becomes unrated after `init` changes the reviewer.

`codeReview.rounds` counts the commits the configured reviewer submitted a review for. A clean pass that Codex reports only as a comment or reaction is not counted. The skill's round budget uses it. `next` lists actions for reasons agents tend to stall on, such as requesting a review of a repaired head.

## Durable delivery

Each event has saved text and an identity. Ambiguous delivery retries use the same text/key. T3's command receipt confirms accepted delivery; the helper verifies the message through the CLI. It never automatically acknowledges work. `ack` is explicit, and a delivered event is not automatically resent. Check unacknowledged events when resuming a failed session; `wake --redeliver` is explicit recovery after inspecting the previous attempt.

The CLI binds an idempotency key to its thread and exact text. Changing text creates a distinct delivery. Permanent rejections keep the event rejected until diagnosed and explicitly redelivered. Settled/archived/missing threads are not silently replaced with new conversations.

## Scheduling

Prefer the native T3 PR watch. For fallback, initialize with the exact delivery thread and use `schedule-command` to generate registration and cancellation instructions. Run one task per PR, retain the task identity, and verify a successful observation before reporting monitoring active. Scheduled ticks do not request periodic LLM turns. Windows fallback runs in the user's logged-in session; logout/shutdown stops availability, and a closed T3 app delays delivery. The helper does not launch T3 to deliver a background event.

`wait` is an in-session fallback with a finite timeout. It is not a replacement for a durable task. When changing mechanisms, stop the old one to avoid duplicate wakes.

After merge, closure, or cancellation, use `stop` and remove the task or native watch. Preserve state for resumption and audit. Do not delete unrelated task state or worktrees.
