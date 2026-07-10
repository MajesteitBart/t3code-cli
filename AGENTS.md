# AGENTS.md

This repository owns the standalone `t3code` handover CLI.

## Workflow

1. Inspect `git status --short --branch` and the files being changed.
2. Keep the command's JSON envelope backward compatible.
3. Run `pnpm check` before claiming completion.
4. Re-run `npm link` only when the package bin mapping changes; ordinary builds update the linked command in place.

## Boundaries

- Never print or persist T3 bearer tokens. Issue them through the upstream `t3 auth session` command and revoke them in `finally`.
- Keep local project discovery read-only. Fall back to authenticated HTTP when the projection database or schema is unavailable.
- Pass handover prompts as process arguments or stdin arrays, never by concatenating them into an executable shell command.
- Preserve explicit failures for unsupported worktree preparation and exact-thread desktop navigation until upstream T3 exposes stable contracts.

## Commands

- Install: `pnpm install`
- Typecheck, test, and build: `pnpm check`
- Link locally: `npm link`
- Diagnose live integration: `t3code --json doctor`
- No-write smoke: `t3code --json handover --cwd . --prompt "Smoke test" --open none --dry-run`
