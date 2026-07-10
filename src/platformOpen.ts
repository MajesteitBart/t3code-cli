import { spawn } from "node:child_process";

import { CliError } from "./errors.js";
import { runProcess } from "./process.js";

export async function hasProtocolHandler(scheme: string): Promise<boolean> {
  if (process.platform === "win32") {
    const result = await runProcess(
      "reg.exe",
      ["query", `HKCU\\Software\\Classes\\${scheme}\\shell\\open\\command`, "/ve"],
      { allowFailure: true, timeoutMs: 5_000 },
    ).catch(() => null);
    return result?.exitCode === 0;
  }
  return false;
}

export async function openExternal(url: string): Promise<void> {
  const invocation =
    process.platform === "win32"
      ? { command: "explorer.exe", args: [url] }
      : process.platform === "darwin"
        ? { command: "open", args: [url] }
        : { command: "xdg-open", args: [url] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (cause) => {
      reject(new CliError("OPEN_FAILED", `Could not open ${url}.`, { cause }));
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
