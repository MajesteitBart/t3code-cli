import { CliError } from "./errors.js";
import { hasProtocolHandler, openExternal } from "./platformOpen.js";
import type { OpenMode, OpenResult, T3Runtime } from "./types.js";

function browserThreadUrl(runtime: T3Runtime, threadId: string): string {
  return new URL(
    `/${encodeURIComponent(runtime.environmentId)}/${encodeURIComponent(threadId)}`,
    runtime.origin,
  ).toString();
}

export async function openThread(
  mode: OpenMode,
  runtime: T3Runtime,
  threadId: string,
): Promise<OpenResult> {
  if (mode === "none") return { mode, kind: "none", url: null, exactThread: false };

  const exactDesktopUrl = `t3://thread/${encodeURIComponent(threadId)}`;
  const hasExactDesktopProtocol = await hasProtocolHandler("t3");
  const hasCurrentDesktopProtocol = await hasProtocolHandler("t3code");

  if ((mode === "auto" || mode === "desktop") && hasExactDesktopProtocol) {
    await openExternal(exactDesktopUrl);
    return { mode, kind: "thread-deep-link", url: exactDesktopUrl, exactThread: true };
  }

  if ((mode === "auto" || mode === "desktop") && hasCurrentDesktopProtocol) {
    const revealUrl = "t3code://app/";
    await openExternal(revealUrl);
    return { mode, kind: "desktop-reveal", url: revealUrl, exactThread: false };
  }

  if (mode === "desktop") {
    throw new CliError("T3_DESKTOP_PROTOCOL_MISSING", "No T3 Code desktop protocol handler is registered.");
  }

  const url = browserThreadUrl(runtime, threadId);
  await openExternal(url);
  return { mode, kind: "browser", url, exactThread: true };
}
