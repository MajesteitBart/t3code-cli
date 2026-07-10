---
name: use-t3code-cli
description: Operate the t3code CLI to resolve folders or Git repositories into T3 Code projects, create missing projects according to policy, start new handover threads with prompts, inspect project state, and diagnose the local T3 connection. Use when an agent needs to hand current work to T3 Code or automate T3 project/thread creation from a terminal or application.
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

The default thread profile is:

- provider instance: `codex`
- model: `gpt-5.6-sol`
- speed: `fast`
- thinking effort: `xhigh`
- permission: full access (`full-access`)

Use `--project-policy existing` when creating a project is not authorized. The default is `create`.

Use `--dry-run --open none` to inspect the proposed project and thread commands without changing T3 state.

## Optional front-end integration

The CLI can be called from a trusted application backend to power a **Send to T3 Code** button. This pattern was initially built for the [Delano viewer](https://github.com/MajesteitBart/delano). The optional `integrations/` example in this repository includes a React split button and Node bridge; it is not required to install or operate the CLI.

Keep the repository root server-owned, pass CLI options as process arguments, and send the prompt over stdin. A browser should call the protected backend endpoint rather than attempt to launch the local CLI itself.

## Interpret results

Read `data.project.id`, `data.thread.id`, `data.projectCreated`, and `data.opened`. A successful current stable desktop reveal can report `opened.exactThread: false`; the thread is still created in the resolved project.

On `{ "ok": false }`, report `error.code` and `error.message`. Do not retry write commands blindly. `THREAD_START_FAILED` already attempts to delete the newly-created thread.

## Current compatibility boundary

T3 0.0.28 and later support new-worktree handovers through the atomic bootstrap contract. `WORKTREE_REQUIRES_BRANCH` means the selected folder is not a Git repository on a branch; retry with `--checkout current` only with explicit user or caller authority.

Use `t3code --json request get <path>` only as a read-only escape hatch.
