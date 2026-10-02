---
name: use-t3code-cli
description: Operate the t3code CLI to resolve folders or Git repositories into T3 Code projects, create missing projects according to policy, start new handover threads with prompts, inspect project state, and diagnose the local T3 connection. Use when an agent needs to hand current work to T3 Code or automate T3 project/thread creation from a terminal or application. Also use when an agent needs to discover, inspect, message, settle, or unsettle an existing T3 Code thread.
---

# Use T3 Code CLI

Use `t3code` as the supported interface. Do not read T3 credentials or construct bearer tokens directly.

## Verify readiness

Run:

```bash
t3code --json doctor
```

Treat `data.ok: false` as a blocker. Ask the user to start T3 Code when `t3Server.ok` is false.

## Resolve before writing

Inspect the current workspace and matching project:

```bash
t3code --json projects resolve --cwd .
```

The default `workspaceMode` is `repo`, which resolves nested folders to their Git root. Use `--workspace-mode folder` only when the exact subfolder must be a separate T3 project.

A linked Git worktree, such as the one T3 created for your own thread, resolves to the main checkout's project; `data.workspace.mainWorktreeRoot` shows that checkout. With `--checkout current`, the new thread works in the same linked worktree. With `--checkout worktree`, T3 prepares a new worktree from the linked worktree's current branch.

## Create a handover thread

Pass prompts over stdin to avoid shell quoting and command-length problems:

```bash
printf '%s' "$HANDOVER_PROMPT" | t3code --json handover --stdin
```

On PowerShell:

```powershell
$handoverPrompt | t3code --json handover --stdin
```

`--cwd` defaults to the process's current working directory. Select thread controls when needed with `--provider`, `--model`, `--speed`, `--thinking-effort`, `--permission`, `--mode build|plan`, and `--checkout current|worktree`.

Unless command flags or CLI config explicitly override it, a new thread inherits the T3 project's complete saved model selection, including provider-specific options. For a missing project, the CLI uses the detected T3 version's default model (`gpt-5.4` on 0.0.28 and `gpt-5.6-sol` on 0.0.29 and later).

The permission default is full access (`full-access`). The CLI sends it on the new thread, the first turn, and the atomic worktree bootstrap. An explicit `--permission` or `runtimeMode` CLI setting remains authoritative.

With the default `--checkout t3`, resolve the checkout mode in the same order as T3 Code:

1. the project's `defaultThreadEnvMode` setting;
2. the checked-in workspace `t3.json` value;
3. the current installation's global `defaultThreadEnvMode` setting.

Use `--project-policy existing` when creating a project is not authorized. The default is `create`.

Use `--dry-run --open none` to inspect the proposed project and thread commands without changing T3 state.

## Work with existing threads

Discover candidate threads in the relevant project, then inspect the exact target id before changing it:

```bash
t3code --json threads list --cwd . --status all
t3code --json threads inspect --thread "$TARGET_THREAD_ID"
```

Use `read` for the conversation. Without `--json` it prints a Markdown transcript grouped by turn, which is the cheapest form to read. Ask only for what the task needs:

```bash
t3code threads read --thread "$TARGET_THREAD_ID" --detail answers --turns 3 --first-turn
t3code threads read --thread "$TARGET_THREAD_ID" --detail messages --last-turn
t3code threads read --thread "$TARGET_THREAD_ID" --detail full --turns 2 --max-chars 1500
```

`answers` keeps each turn's prompts and final answer. `messages`, the default, adds progress messages but leaves out reasoning summaries and tool calls. `full` adds reasoning, tool calls, changed files, and proposed plans. `--first-turn` keeps the original request when `--turns` would cut it off. `--max-chars` clips long entries at their start and end; without it, nothing is shortened.

In JSON, `data.thread.messages` is in turn order and each message carries `turnIndex`. `data.thread.turns` gives each turn's state and `finalMessageId`, and `data.thread.view` says how many turns were left out. User messages have a null `turnId` in T3, so use `turnIndex` to group them.

Use `--project <project-id>` instead of `--cwd` when the caller provides an exact project id. Filter with `--status active` or `--status settled` when useful. Do not select a target from its title alone because titles are not unique.

Pass messages over stdin:

```bash
printf '%s' "$THREAD_MESSAGE" \
  | t3code --json threads send --thread "$TARGET_THREAD_ID" --stdin
```

Sending is an external state change. Keep the target and message within the caller's authorization. A settled thread requires interactive confirmation or `--wake-settled`; JSON and stdin workflows are non-interactive, so use that override only when waking the inspected target is authorized. Archived threads cannot receive a turn. A busy thread, with a running turn or a message waiting for its turn, gets `THREAD_BUSY` unless you pass `--if-busy inject` to send into the running turn.

Add `--wait` to get the reply. Give the shell call a longer timeout than `--timeout`:

```bash
printf '%s' "$THREAD_MESSAGE"   | t3code --json threads send --thread "$TARGET_THREAD_ID" --stdin --wait --timeout 540
```

Read `data.wait.outcome`. On `completed` or `interrupted`, `data.reply` holds the turn that handled the message. `needs-attention` means the thread waits for an approval or answer, listed in `data.pendingRequests`; a person must answer it in T3 Code. `error` means the provider could not start the turn, with the reason in `data.wait.error`. To wait without sending, for example after a handover, run `t3code threads wait --thread "$TARGET_THREAD_ID" --timeout 540`.

Change an existing thread's settings with `threads set`, or pass the same flags to `threads send` to apply them before the message:

```bash
t3code --json models list --provider codex
t3code --json threads set --thread "$TARGET_THREAD_ID" --model gpt-6-astra --thinking-effort xhigh --speed fast --dry-run
t3code --json threads set --thread "$TARGET_THREAD_ID" --permission auto-accept-edits --mode plan
```

The CLI maps `--thinking-effort` and `--speed` to the option ids each model uses and checks values against T3's catalog; `--option id=value` sets other options such as `contextWindow`. It refuses a permission change while a turn runs, because T3 restarts the session, and a provider switch on a started thread, because T3 cannot move the conversation. Read `data.changes` for what changed and `data.changes.catalogUsed` for whether the values were checked.

Stop a running turn, or respond to what the thread waits for:

```bash
t3code --json threads interrupt --thread "$TARGET_THREAD_ID"
t3code --json threads approve --thread "$TARGET_THREAD_ID" --request "$REQUEST_ID" --wait --timeout 540
t3code --json threads decline --thread "$TARGET_THREAD_ID" --request "$REQUEST_ID"
t3code --json threads answer --thread "$TARGET_THREAD_ID" --answer "$ANSWER" --wait --timeout 540
```

Approvals and answers act with the user's authority: send them only on the caller's explicit instruction. `approve --scope always` works only when the request offers it. Take request ids from `data.pendingRequests` in `inspect` or `send --wait` results. `THREAD_REQUEST_AMBIGUOUS` means several requests are pending; pass `--request`.

The `t3thread` skill builds on these commands for `$t3thread <thread-id> <instruction>` requests.

Manage lifecycle state without sending a message:

```bash
t3code --json threads settle --thread "$TARGET_THREAD_ID"
t3code --json threads unsettle --thread "$TARGET_THREAD_ID"
```

Settle only after the caller authorizes that lifecycle change. T3 refuses settlement while a session is starting/running or the thread has a blocking approval or user-input request. Unsettling marks the thread manually active; it does not start a turn or provider session.

## Optional front-end integration

The CLI can be called from a trusted application backend to power a **Send to T3 Code** button. This pattern was initially built for the [Delano viewer](https://github.com/MajesteitBart/delano). The optional `integrations/` example in this repository includes a React split button and Node bridge; it is not required to install or operate the CLI.

Keep the repository root server-owned, pass CLI options as process arguments, and send the prompt over stdin. A browser should call the protected backend endpoint rather than attempt to launch the local CLI itself.

## Interpret results

Read `data.project.id`, `data.thread.id`, `data.projectCreated`, and `data.opened`. A successful current stable desktop reveal can report `opened.exactThread: false`; the thread is still created in the resolved project.

For existing-thread writes, require `data.verification.accepted: true`. Record `data.thread.id` and, for sends, `data.message.messageId` when reporting the result. The CLI verifies the requested projection state rather than treating HTTP submission as success.

On `{ "ok": false }`, report `error.code`, `error.message`, and `error.cause` when present. The cause carries T3's own reason, for example why it rejected a worktree bootstrap. Read the whole envelope instead of filtering it with `grep`, and do not retry write commands blindly. Each handover attempt creates a new thread id. `THREAD_START_FAILED` already attempts to delete the newly-created thread; `error.details.cleanup` reports `deleted`, `not-created`, or `server-managed`.

`THREAD_TURN_NOT_VERIFIED` or `THREAD_SETTLEMENT_NOT_VERIFIED` means dispatch returned but projection verification timed out. Do not retry automatically because the first operation may still appear later.

`THREAD_WAIT_TIMEOUT` (exit code 6) after `send --wait` means the message was sent and `error.details.sent` is `true`. Never resend it; continue with `threads wait`.

## Current compatibility boundary

T3 0.0.28 and later support new-worktree handovers through the atomic bootstrap contract. Worktree creation follows the current installation's explicit `newWorktreesStartFromOrigin` setting. When it is absent, use the installed version's default: `false` on 0.0.28 and `true` on 0.0.29 and later. `WORKTREE_REQUIRES_BRANCH` means the selected folder is not a Git repository on a branch; retry with `--checkout current` only with explicit user or caller authority.

Thread settlement commands require a T3 server that exposes the `threadSettlement` capability. Existing-thread sends preserve the target's saved model, runtime mode, and interaction mode.

Use `t3code --json request get <path>` only as a read-only escape hatch. Write the path without its leading slash, for example `api/orchestration/shell`: Git Bash rewrites `/api/...` into a Windows file path before the CLI sees it.
