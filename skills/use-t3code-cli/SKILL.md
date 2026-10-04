---
name: use-t3code-cli
description: Operate the t3code CLI to hand work to T3 Code from outside T3, and to discover, read, message, wait for, steer, fork, organize, or schedule T3 Code threads. Use when an agent outside T3 needs to start a T3 thread or coordinate existing ones, when an agent inside a T3 thread needs something its own t3-code MCP tools do not offer (other projects, turn-sliced transcripts, waiting for a reply, refusing to send into a busy thread), or when a user asks to approve, decline, or change another thread's permission or plan mode.
---

# Use T3 Code CLI

Use `t3code` as the supported interface. Do not read T3 credentials or construct bearer tokens directly. This CLI version works only with T3 Code builds that include orchestrator V2; see "Verify readiness".

## CLI or MCP tools

If you run inside a T3 thread, you have T3's own `t3-code` MCP tools. Prefer them for your own project: `t3_thread_launch` or `delegate_task` to start work, `t3_thread_send`, `t3_thread_wait`, `t3_thread_read`, `t3_thread_fork`. Use this CLI for what they leave out:

- threads in other projects;
- transcripts sliced by turn (`threads read --turns`, `--first-turn`, `--detail`);
- a reply in one call (`threads send --wait`, `handover --wait`);
- refusing to send into a busy thread (the default `--if-busy refuse`);
- dismissing a question whose session is gone.

Outside T3, as in a terminal agent, a script, or an app backend, the CLI is the way in.

Approving or declining another thread's requests and changing its permission or plan mode act with the user's authority. Run them only on the user's explicit instruction, never on your own judgment.

## Verify readiness

```bash
t3code --json doctor
```

Treat `data.ok: false` as a blocker. Ask the user to start T3 Code when `checks.t3Server.ok` is false. `checks.orchestrationProtocol.ok: false` means the T3 build predates orchestrator V2; this CLI version cannot drive it, and `@bvdm/t3code-cli@0.2` can.

## Resolve before writing

```bash
t3code --json projects resolve --cwd .
```

The default `workspaceMode` is `repo`, which resolves nested folders to their Git root. Use `--workspace-mode folder` only when the exact subfolder must be a separate T3 project.

A linked Git worktree, such as the one T3 created for your own thread, resolves to the main checkout's project; `data.workspace.mainWorktreeRoot` shows that checkout. With `--checkout current`, the new thread works in the same linked worktree. With `--checkout worktree`, T3 prepares a new worktree from the linked worktree's current branch.

## Hand work to a new thread

Pass prompts over stdin to avoid shell quoting and command-length problems:

```bash
printf '%s' "$HANDOVER_PROMPT" | t3code --json handover --stdin
```

On PowerShell:

```powershell
$handoverPrompt | t3code --json handover --stdin
```

`--cwd` defaults to the current working directory. Select thread controls with `--provider`, `--model`, `--speed`, `--thinking-effort`, `--permission`, `--mode build|plan`, and `--checkout current|worktree`. Without overrides, the thread uses the project's saved model selection, or T3's default model when the project has none. The permission default is `full-access`.

Add `--wait --timeout <seconds>` to wait for the first turn and get its reply in `data.reply`, which turns a handover into a one-shot task for another model. Give the shell call a longer timeout than `--timeout`.

With the default `--checkout t3`, the checkout mode follows T3: the project's `defaultThreadEnvMode`, then the workspace's `t3.json`, then T3's global setting. Use `--project-policy existing` when creating a project is not authorized. Use `--dry-run --open none` to inspect the launch without changing T3 state.

## Work with existing threads

Thread ids are UUIDs or start with `thread:`. Discover candidates, then inspect the exact target before changing it:

```bash
t3code --json threads list --cwd . --status all
t3code --json threads search --query "migration plan"
t3code --json threads inspect --thread "$TARGET_THREAD_ID"
```

Do not pick a target by title alone; titles are not unique.

Read only what the task needs. Without `--json`, `read` prints a Markdown transcript grouped by turn:

```bash
t3code threads read --thread "$TARGET_THREAD_ID" --detail answers --turns 3 --first-turn
t3code threads read --thread "$TARGET_THREAD_ID" --detail messages --last-turn
t3code threads read --thread "$TARGET_THREAD_ID" --detail full --turns 2 --max-chars 1500
```

`answers` keeps each turn's prompts and final answer. `messages`, the default, adds progress messages. `full` adds reasoning, tool calls, approvals, questions, and changed files. Each turn is one T3 run. Turns marked `imported` predate orchestrator V2 and lost their tool calls.

### Send and wait

```bash
printf '%s' "$THREAD_MESSAGE" \
  | t3code --json threads send --thread "$TARGET_THREAD_ID" --stdin --wait --timeout 540
```

Sending changes T3 state; keep the target and message within the caller's authorization. A settled thread needs interactive confirmation or `--wake-settled`, because T3 wakes it. Archived threads cannot receive messages.

A busy thread, with a running turn or queued messages, gets `THREAD_BUSY` by default and nothing is sent. Choose `--if-busy queue` to wait in T3's queue, `steer` to join the running turn, or `restart` to stop it and start over. Use `steer` and `restart` only when the user wants to redirect the running work.

Read `data.wait.outcome`:

- `completed` or `interrupted`: the reply is in `data.reply`, without your own message.
- `needs-attention`: the thread waits for an approval or answer, listed in `data.pendingRequests`.
- `error`: the provider could not run the turn; see `data.wait.error`.
- `queue-held`: T3 holds the queue after a restart; `threads queue resume` releases it.
- `ended`: the turn was rolled back.

`THREAD_WAIT_TIMEOUT` (exit code 6) means the message was sent (`error.details.sent: true`). Never resend it; continue with `t3code threads wait --thread "$TARGET_THREAD_ID" --timeout 540`, which waits for the running turn and the queue.

### Change settings

```bash
t3code --json models list --provider codex
t3code --json threads set --thread "$TARGET_THREAD_ID" --model gpt-6-astra --thinking-effort xhigh --dry-run
t3code --json threads set --thread "$TARGET_THREAD_ID" --provider claudeAgent --model claude-opus-5-5
```

The CLI checks values against T3's catalog. A model on another provider instance goes through T3's provider switch, which hands the conversation over with recent history. Provider switches and permission changes are refused while a turn runs. `threads send` takes the same flags and applies them before the message.

### Interrupt, approve, answer

```bash
t3code --json threads interrupt --thread "$TARGET_THREAD_ID"
t3code --json threads approve --thread "$TARGET_THREAD_ID" --request "$REQUEST_ID" --wait --timeout 540
t3code --json threads decline --thread "$TARGET_THREAD_ID" --request "$REQUEST_ID"
t3code --json threads answer --thread "$TARGET_THREAD_ID" --answer "$ANSWER" --wait --timeout 540
t3code --json threads answer --thread "$TARGET_THREAD_ID" --dismiss
```

Take request ids from `data.pendingRequests`. `THREAD_REQUEST_AMBIGUOUS` means several are pending; pass `--request`. `approve --scope always` works only when the request offers it. `REQUEST_NOT_ANSWERABLE` means the provider session that asked is gone; dismiss a question like that instead.

### Forks, queue, organization, schedules

```bash
t3code --json threads fork --thread "$TARGET_THREAD_ID" --title "Try the other approach"
t3code --json threads merge-back --thread "$FORK_THREAD_ID"
t3code --json threads queue list --thread "$TARGET_THREAD_ID"
t3code --json threads queue resume --thread "$TARGET_THREAD_ID"
t3code --json threads rename --thread "$TARGET_THREAD_ID" --title "Billing migration"
t3code --json threads pin --thread "$TARGET_THREAD_ID"
t3code --json threads snooze --thread "$TARGET_THREAD_ID" --until 2h
t3code --json schedules list --cwd .
```

A fork copies the conversation into a new thread; `merge-back` sends what the fork learned back to its source. Queue commands edit, cancel, move, or promote queued messages. `schedules` creates recurring prompts that T3 runs on an interval or at a fixed time; create them only on the user's instruction, because they keep running.

### Settle or reopen

```bash
t3code --json threads settle --thread "$TARGET_THREAD_ID"
t3code --json threads unsettle --thread "$TARGET_THREAD_ID"
```

Settle only on the caller's authorization. T3 refuses settlement while a turn runs, messages are queued, or a request is pending. T3 also settles idle threads by itself.

## Interpret results

Read `data.project.id`, `data.thread.id`, `data.projectCreated`, and `data.opened` after a handover. `opened.exactThread: false` is normal: T3's desktop app can be revealed but not pointed at one thread yet.

For writes, the CLI verifies T3's result before it reports success. Record `data.thread.id` and, for sends, `data.message.messageId`.

On `{ "ok": false }`, report `error.code`, `error.message`, and `error.cause` when present; the message carries T3's own reason. Read the whole envelope instead of filtering it. Do not retry write commands blindly: each handover attempt starts a new thread. `THREAD_START_FAILED` reports `cleanup: "server-managed"`, because T3 finishes or cleans up its own launches. Exit code 5 (`*_NOT_VERIFIED`) means the command was dispatched but T3 did not show the result in time; read the thread before acting again.

Use `t3code --json request get <path>` only as a read-only escape hatch. Write the path without its leading slash, for example `api/orchestration/shell`: Git Bash rewrites `/api/...` into a Windows file path before the CLI sees it.

## Optional front-end integration

The CLI can power a **Send to T3 Code** button from a trusted application backend; the `integrations/` folder has a React split button and Node bridge. Keep the repository root server-owned, pass CLI options as process arguments, and send the prompt over stdin. A browser should call the protected backend endpoint rather than launch the CLI itself.
