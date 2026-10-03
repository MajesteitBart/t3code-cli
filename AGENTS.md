# AGENTS.md

This repository owns the standalone `t3code` CLI, which lets agents, scripts, and apps outside T3 Code hand work to T3 threads and steer them.

## Workflow

1. Inspect `git status --short --branch` and the files being changed.
2. Keep the command's JSON envelope backward compatible within a major version. Document every breaking change under "Upgrading" in README.md.
3. Run `pnpm check` before claiming completion.
4. Re-run `npm link` only when the package bin mapping changes; ordinary builds update the linked command in place.

## Boundaries

- Speak orchestration protocol 2 (orchestrator V2) only. Check the server's protocol before signing in, and refuse other protocols with `T3_PROTOCOL_UNSUPPORTED`. Version 0.2 serves protocol 1.
- Never print or persist T3 bearer tokens. Issue them through the upstream `t3 auth session` command whose version matches the server, and revoke them in `finally`.
- Keep local project discovery read-only. Fall back to authenticated HTTP when the projection database or schema is unavailable.
- Pass handover prompts as process arguments or stdin arrays, never by concatenating them into an executable shell command.
- Launch threads, including new-worktree handovers, through `orchestration.launchThread`, and send every other write through `orchestration.dispatchCommand`. Verify each write in T3's projection before reporting success.
- Preserve the explicit `exactThread: false` result for desktop navigation until upstream T3 registers a deep link to a thread.
- Approve, decline, and permission or plan-mode changes act with the user's authority. Keep them explicit commands; never make them a side effect of another command.

## Testing

- `src/testing/fakeT3.ts` is an in-memory protocol 2 server for tests. Extend it when a test needs new server behavior.
- For live checks, run an isolated server with its own data directory, for example `t3 serve --port 3999 --base-dir <temp>`, and point the CLI at it with `--origin` and `--t3-home`. Never test write commands against a user's real T3 home.

## Commands

- Install: `pnpm install`
- Typecheck, test, and build: `pnpm check`
- Link locally: `npm link`
- Diagnose live integration: `t3code --json doctor`
- No-write smoke: `t3code --json handover --cwd . --prompt "Smoke test" --open none --dry-run`
