import { execFile } from "node:child_process";
import { copyFile, cp, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const exec = promisify(execFile);

// Node 22/24 warn on the CLI's existing node:sqlite import. Remove only that
// known runtime diagnostic; unexpected stderr must still fail the assertions.
export function withoutSqliteWarning(stderr) {
  return stderr.replace(/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/m, "");
}

/** Compiles the CLI into a temporary directory, so tests run it as a real child process. */
export async function buildCli(prefix) {
  const directory = await mkdtemp(path.resolve(prefix));
  const build = path.join(directory, "dist");
  await exec(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--outDir", build]);
  // The CLI reads its version from ../package.json relative to the build output.
  await copyFile("package.json", path.join(directory, "package.json"));
  await cp("skills", path.join(directory, "skills"), { recursive: true });
  return {
    directory,
    build,
    cli: path.join(build, "cli.js"),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Runs the built CLI and resolves with its exit code instead of rejecting on failure. */
export async function runBuiltCli(cli, args, options = {}) {
  return await exec(process.execPath, [cli, ...args], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, ...options }).then(
    (value) => ({ stdout: value.stdout, stderr: withoutSqliteWarning(value.stderr), code: 0 }),
    (error) => ({ stdout: error.stdout ?? "", stderr: withoutSqliteWarning(error.stderr ?? ""), code: error.code }),
  );
}
