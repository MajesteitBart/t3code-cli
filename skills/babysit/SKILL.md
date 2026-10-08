---
name: babysit
description: Commit intended changes, open or update a GitHub PR, and babysit reviews, CI, repairs, and merge verification. Use when the user invokes $babysit, asks to babysit a PR until merge, or asks to own the commit-to-merge workflow.
---

# Babysit

Own the requested PR workflow through verified merge. Opening the PR or enabling auto-merge is not completion. The goal is a merged PR with no open P0/P1 findings. A review with nothing left to say is not the goal.

## Scope and authorization

Invoking this skill alone requests the full workflow through verified merge. Infer the target repository, branch or existing PR, and intended changes from the active task, conversation, and working tree. Begin at the first incomplete step. Do not require the user to restate the workflow or add instructions. Ask only when the target or intended scope cannot be determined safely from available context.

This invocation, or a request to commit, create a PR, and babysit until merge, authorizes committing and pushing the intended changes, opening or updating the PR, posting task-related PR comments and review requests, fixing in-scope issues, deferring non-blocking findings, and merging after all gates pass. When the gates in section 7 pass, merge. Do not ask for merge permission again. Apply the same workflow to an existing PR when asked to babysit it until merge. Respect any narrower scope or explicit stop-before-merge instruction.

Handle routine in-scope repairs without asking for permission again. Escalate missing permissions, required human approvals, legal agreements, paid usage, material scope changes, and decisions that require the user. Never sign a CLA, enable paid review credits, change branch protection, or use administrator bypass. Use another reviewer only if the user authorizes it. Do not spawn subagents unless the user explicitly requests them.

One agent owns the PR branch. Do not let two agents edit it at once. If you delegated work and the delegate stopped without a result, check its state, take the work back, and continue. Do not wait on a delegate that is no longer running.

## 1. Verify and commit

- Read the repository instructions and follow its branch, commit, test, and merge conventions. Confirm the repository, intended base branch, and task scope.
- Inspect the working tree and diff. Preserve unrelated work. Stage only intended files or hunks; exclude secrets and incidental output.
- Run relevant tests, lint, type checks, and build using the repository's actual commands. For behavior changes, exercise the affected user journey or runtime path where feasible. Record commands, results, and anything not run.
- Fix failures at their root cause. Add focused regression tests for bugs. Do not weaken checks or delete tests to obtain a pass.
- Review the staged diff and create focused, descriptive commits. Use Conventional Commits unless the repository follows another format.
- Push the task branch. Once the PR exists, verify that its remote head SHA matches the intended local commit. Investigate mismatches before proceeding.

## 2. Open or update the PR

- Reuse an existing PR for the branch. Target the correct base and keep the PR limited to the task.
- Describe what changed, why, actual verification results, and any risks, migration requirements, or limitations. Never claim unrun tests passed.
- Open ready for review only after local verification is complete. If work needs an earlier draft, complete verification before marking it ready.
- With `gh`, use a body file for multiline PR descriptions and comments so actual newlines and literal text survive shell quoting.

## 3. Wait for Codex review

Use these user-provided settings unless the user updates them:

| Setting | Value |
| --- | --- |
| Auto review | Enabled for Codex-enabled repositories |
| Automatic trigger | On PR open |
| Exhaustive code review | Enabled |
| Paid credit use | Disabled |

These settings are expected behavior, not proof that the current repository is connected or that a review has started.

Let the automatic opening review run before requesting another review. Verify actual startup through live GitHub review activity or the review service's task state. If the opening review does not start, check access, configuration, and failure messages. After confirming no review is running or queued, request `@codex review` once; repeated comments do not repair missing access or quota.

Wait for the review to finish, including its summary, inline comments, and threads, then re-read them. An early summary or a thumbs-up without commit metadata is not completion. Bind review evidence to the exact PR head SHA: a clean review of an older commit does not cover a newer head. If the evidence cannot establish completion, keep the review gate pending and say so; silence is not proof.

`t3code babysit inspect --pr <URL>` gathers the evidence. A submitted review at the head proves submission, not completion, so readiness stays unknown until you record completion: `t3code babysit record --pr <URL> --review-evidence --head <full-SHA> --url <task-URL> --note <completion-evidence>`.

## 4. Triage findings

Every finding gets one decision: fixed, refuted, or deferred. Whether it blocks the merge depends on its severity. Codex marks each inline finding P0 to P3; `inspect` reports it as `severity`, and only for threads the configured reviewer opened.

| Severity | Blocks merge | What to do |
| --- | --- | --- |
| P0, P1 | Yes | Fix it, or refute it with concrete evidence. Defer only with the user's approval. |
| P2, P3 | No, once deferred | Fix it only when you already push a commit for another reason and the fix is small, in scope, and covered by tests. Otherwise defer it. |
| Unrated (humans, other bots) | Yes | Fix it, or refute it with evidence the commenter accepts. Defer only with the user's approval. |

Raise a P2/P3 finding to blocking when it is actually a security hole, data loss, or a broken main user journey. Never lower a severity without the user, and never edit a reviewer's comment. Assess each finding against the code before acting; refute false positives instead of changing code blindly.

To defer, post one PR comment that lists the deferred findings with their links, the reason, and where the follow-up lives, such as an issue. Do not reply in each thread. Then run `decide --pr <URL> --finding <thread-ID> [--finding <thread-ID>…] --decision deferred --evidence <reason and follow-up>`. The helper refuses to defer P0, P1, or unrated findings without `--user-approved`. Pass that flag only after the user actually approved the deferral; the helper cannot check it. Record fixes and refutations with `--decision fixed|refuted`. A new or edited comment reopens the finding. Do not resolve a thread only to clear a gate; respect repository rules about who may resolve it.

Never push a commit, and so start another review round, only to fix P2/P3 findings.

## 5. Repair and re-review

- Inspect CI logs, review summaries, inline comments, and unresolved threads. Do not rely on the check rollup alone. Fetch all pages when listing review evidence and discussions.
- Batch the round's repairs, add focused regression tests, rerun relevant checks, commit, and push to the same branch. Record `t3code babysit record --pr <URL> --tested <full-SHA> --result pass --command <verification-command>` for the new head.
- In the same step as the push, request re-review. A repair push does not trigger Codex automatically. If no review of the new head is running or queued, comment `@codex review` once and record it with `record --pr <URL> --review-request --head <full-SHA> --url <request-comment-URL>`. Check saved requests first so resumed sessions do not duplicate it.
- Run `inspect` after every push and before every yield, and do its `next` actions before you wait.
- Wait for review and CI on the new head and triage again. The new review of the final head is required; its P2/P3 findings are deferred like any other.
- Verify repairs with targeted tests. Local reviews, delegated reviews, and second opinions are optional. They never gate a merge, and a repair never needs one before the Codex re-review.

**Round budget.** `inspect` reports `codeReview.rounds`, the number of commits Codex submitted a review for. Repairing the findings of the first three reviews is routine. If the fourth review still raises new P0/P1 findings, do not push again on your own. Send the user the open blocking findings, what the repairs keep breaking, and a recommendation: keep fixing, defer with approval, or split the PR. Continue once they answer.

If Codex is rate-limited or unavailable, keep the PR unmerged and report the blocker. Rate limits are not approval. Do not enable paid credits, bypass review, or silently substitute another reviewer. If a reset time is known, keep the gate pending and resume then without repeating requests. A retry after an explicit failure is distinct from duplicating a running or queued review.

## 6. Babysit actively, with low noise

Continue through verified merge or the user's narrower stopping point. A genuine blocker must name the missing gate and preserve resumable state. Do not write custom pollers or create a new conversation to deliver a wakeup.

Initialize the shared helper once per PR:

```text
t3code babysit init --pr <URL> --code-reviewer "chatgpt-codex-connector"
t3code babysit inspect --pr <URL>
```

Add `--thread <exact-T3-thread-ID>` when fallback delivery to the original conversation is needed. Determine that ID from the environment or inspect an explicitly identified thread; never guess between similarly titled conversations. A settled thread requires explicit continuing authorization before adding `--wake-settled`. State lives outside tracked source in `~/.babysit/v1/`; `status --pr <URL>` exposes the observations, pending events, and delivery errors. The helper never merges or requests a review itself. Read [helper.md](references/helper.md) when configuring fallback schedules, resuming an event, or interpreting unknown evidence.

**Inside T3:** handle existing findings, link the PR, call the available `watch_pull_request` tool, and end the turn. Use the native watch first when its documented contract covers the required events. T3 owns future wakes. Do not also start a scheduled tick or an agent-owned polling process. On a wake, run a fresh `inspect`, act within the saved authorization, record evidence, and register/reconfirm the native watch before yielding again if the workflow remains pending. A native wake is news, not approval to merge. If native monitoring ends because the PR cannot be read, report that blocker and the actual monitoring status.

**Fallback:** when native watch is unavailable, use the helper's `schedule-command --pr <URL>` to generate one OS-owned `tick` task. Inspect and run the generated registration command, save its identity/cancellation instruction, and verify the first successful tick observed the correct PR/head before calling monitoring active. A tick performs API reads without an LLM; it sends a wake only for a material change. It queues delivery to the original T3 conversation and does not launch T3 when closed. Stop any old watcher before changing mechanisms.

**Without durable delivery:** use `wait --pr <URL> --timeout <duration>` within the active session. It makes no model call while sleeping. Disclose that this wait ends with the session; it is not durable monitoring.

**On helper-delivered wakes:** run `inspect`, handle the event or record a concrete blocker, then `ack --pr <URL> --event <event-ID> --note <outcome>`. Delivery acceptance is not acknowledgment of handled work. Interrupted work stays unacknowledged in `status` and later wakes; deliberate recovery uses `wake --pr <URL> --redeliver <event-ID>`. Never start a second repair loop for the same PR.

Keep unchanged observations silent and send brief updates for material changes. Unknown or incomplete evidence keeps the relevant gate pending. If the helper cannot express a gate, report the missing evidence rather than substituting an ad hoc parser.

## 7. Merge only after final verification

These are the only merge gates. Immediately before merging, re-read the live PR and verify each one:

- The head is the exact commit tested and reviewed.
- Required checks passed for the applicable commit. Missing, skipped, or cancelled checks are not passing evidence; establish whether repository policy requires them.
- Codex finished reviewing the final head, and comments and threads were rechecked after it finished.
- No P0/P1 finding is open, and every finding has a decision.
- Required human approvals and repository rules are satisfied.
- The PR is mergeable, and no new commits, comments, or review activity invalidate readiness.

Optional CI checks, security reviews that repository policy does not require, extra reviewers, and local reviews are not gates. Do not wait for them and do not invent new ones. Pass `--security-check` to `init` only for a security check that branch protection requires; the helper keeps readiness unknown until a configured security check passes.

If the head changes, rerun affected checks and obtain Codex review of the new head. If the base changes, reassess integration and refresh checks as required by repository policy. Resolve in-scope conflicts, then verify and review the resulting head.

Use the repository's merge method, defaulting to squash when no convention exists. Bind the merge to the verified head SHA where supported. Never use administrator bypass. Do not enable auto-merge before review gates are satisfied when branch protection does not enforce those gates. Continue monitoring while auto-merge or a merge queue is pending; enabling either is not completion.

## 8. Prove completion

Verify through GitHub that the PR is actually merged. Report:

- PR URL.
- Verified pre-merge head SHA and resulting merge commit SHA.
- Local test results and final CI results, including material checks not run.
- Final Codex review outcome, the number of review rounds, and any required human approval outcome.
- Deferred findings, each with its severity, link, and follow-up.

If GitHub shows the PR closed without merge, report that outcome accurately. A blocked handoff must name the unsatisfied gate, relevant evidence, the decision or external change needed, and the actual monitoring status.

Stop any watcher and clean up only the task's branch or worktree, preserving unrelated work. Do not claim deployment or production verification unless separately requested and actually performed.

Run `t3code babysit stop --pr <URL> --reason merged|closed|cancelled` when the workflow ends. Unwatch the PR in T3 or remove the one OS task using its recorded cancel command. A stopped helper performs no further API calls or deliveries.
