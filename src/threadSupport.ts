import type { T3Api } from "./api.js";
import { CliError } from "./errors.js";
import { readLocalProjects } from "./localProjects.js";
import type { TurnWaitResult } from "./threadApi.js";
import { buildTranscript, pendingRequests, selectTurn, type ReadDetail } from "./transcript.js";
import type { CliConfig, T3Project, T3Thread } from "./types.js";

export type ThreadLifecycleStatus = "active" | "settled";

export interface ThreadWaitOptions {
  timeoutMs: number;
  detail?: ReadDetail;
  maxChars?: number;
}

export function threadStatus(thread: T3Thread): ThreadLifecycleStatus {
  return thread.settledAt == null ? "active" : "settled";
}

export function requireThreadId(value: string): string {
  const threadId = value.trim();
  if (!threadId) {
    throw new CliError("THREAD_ID_REQUIRED", "A non-empty thread id is required.", { exitCode: 2 });
  }
  return threadId;
}

/** Prefers the read-only local projection over downloading the shell snapshot of every thread. */
export async function projectById(api: T3Api, projectId: string): Promise<T3Project | null> {
  const local = readLocalProjects(api.runtime)?.find((project) => project.id === projectId);
  if (local) return local;
  const snapshot = await api.shellSnapshot().catch(() => api.snapshot().catch(() => null));
  const projects = snapshot && Array.isArray(snapshot.projects) ? snapshot.projects : [];
  return projects.find((candidate) => candidate.id === projectId) ?? null;
}

/** Issues a session that outlives the wait; `withT3Api` still revokes it when the command ends. */
export function configForWait(config: CliConfig, wait: ThreadWaitOptions | undefined): CliConfig {
  return wait ? { ...config, sessionTtl: `${Math.ceil(wait.timeoutMs / 60_000) + 2}m` } : config;
}

export type ThreadWaitView = ReturnType<typeof waitView>;

export function waitView(waited: TurnWaitResult, options: ThreadWaitOptions, omitMessageIds: readonly string[] = []) {
  const transcript = buildTranscript(waited.thread, {
    detail: options.detail ?? "answers",
    ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
  });
  return {
    wait: {
      outcome: waited.outcome,
      turnIndex: waited.turnIndex,
      waitedMs: waited.waitedMs,
      statusAfter: threadStatus(waited.thread),
      ...(waited.error === undefined ? {} : { error: waited.error }),
    },
    pendingRequests: pendingRequests(waited.thread),
    reply: selectTurn(transcript, waited.turnIndex, omitMessageIds),
  };
}
