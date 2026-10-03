import { CliError } from "./errors.js";
import { readResponseText, withHttpResponse } from "./http.js";
import { resolveT3Invocation, runProcess, type T3Invocation } from "./process.js";
import { resolveT3Home } from "./runtime.js";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type CliConfig,
  type T3Project,
  type T3Runtime,
  type T3ShellSnapshot,
  type ThreadDetailSnapshot,
} from "./types.js";

const DISPATCH_COMMAND_RPC = "orchestration.dispatchCommand";
const LAUNCH_THREAD_RPC = "orchestration.launchThread";
const DISPATCH_TIMEOUT_MS = 60_000;
// T3 allows `git worktree add` five minutes; fetching origin and a setup script come on top.
const LAUNCH_TIMEOUT_MS = 10 * 60_000;

interface IssuedSession {
  sessionId: string;
  token: string;
}

interface RpcCauseReason {
  _tag?: unknown;
  error?: unknown;
  defect?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function rpcFailure(tag: string, exit: Record<string, unknown>): CliError {
  const reasons = Array.isArray(exit.cause) ? (exit.cause as RpcCauseReason[]) : [];
  const failure = record(reasons.find((reason) => reason._tag === "Fail")?.error);
  const defect = reasons.find((reason) => reason._tag === "Die")?.defect;
  // Launch errors wrap the reason, such as a failed `git worktree add`, in their cause.
  const cause = record(failure?.cause);
  const causeMessage = typeof cause?.message === "string" ? cause.message : null;
  const base =
    typeof failure?.detail === "string"
      ? failure.detail
      : typeof failure?.message === "string"
        ? failure.message
        : typeof defect === "string"
          ? defect
          : `T3 rejected ${tag}.`;
  const message = causeMessage && !base.includes(causeMessage) ? `${base}: ${causeMessage}` : base;
  return new CliError("T3_RPC_FAILED", message, {
    details: {
      rpc: tag,
      ...(typeof failure?._tag === "string" ? { errorTag: failure._tag } : {}),
      ...(typeof failure?.commandType === "string" ? { commandType: failure.commandType } : {}),
      cause: exit.cause ?? null,
    },
  });
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

/** Sends one Effect RPC request over T3's `/ws` endpoint and resolves with its successful exit value. */
async function rpcRequest(url: URL, tag: string, payload: unknown, timeoutMs: number): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const requestId = "1";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let settled = false;
    const finish = (error: CliError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new CliError("T3_RPC_TIMEOUT", `T3 did not answer ${tag} within ${timeoutMs / 1000} seconds.`)),
      timeoutMs,
    );
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    });
    socket.addEventListener("message", (event) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(messageText(event.data));
      } catch (cause) {
        finish(new CliError("T3_RPC_PROTOCOL_ERROR", `T3 sent an unreadable ${tag} response.`, { cause }));
        return;
      }
      for (const message of (Array.isArray(decoded) ? decoded : [decoded]) as Array<Record<string, unknown>>) {
        if (message._tag === "Exit" && String(message.requestId) === requestId) {
          const exit = (message.exit ?? {}) as Record<string, unknown>;
          if (exit._tag === "Success") finish(null, exit.value);
          else finish(rpcFailure(tag, exit));
          return;
        }
        if (message._tag === "Defect" || message._tag === "ClientProtocolError") {
          finish(
            new CliError("T3_RPC_PROTOCOL_ERROR", `T3 reported a protocol error for ${tag}.`, {
              details: { message },
            }),
          );
          return;
        }
      }
    });
    socket.addEventListener("error", () => {
      finish(new CliError("T3_REQUEST_FAILED", `T3 WebSocket request failed: ${tag}`));
    });
    socket.addEventListener("close", (event) => {
      finish(
        new CliError("T3_REQUEST_FAILED", `T3 closed the WebSocket before answering ${tag}.`, {
          details: { closeCode: event.code, closeReason: event.reason },
        }),
      );
    });
  });
}

function invocationEnv(invocation: T3Invocation): NodeJS.ProcessEnv | undefined {
  return invocation.env ? { ...process.env, ...invocation.env } : undefined;
}

async function issueSession(invocation: T3Invocation, config: CliConfig): Promise<IssuedSession> {
  const env = invocationEnv(invocation);
  const result = await runProcess(
    invocation.command,
    [
      ...invocation.argsPrefix,
      "auth",
      "session",
      "issue",
      "--json",
      "--ttl",
      config.sessionTtl,
      "--label",
      "t3code-cli",
      "--subject",
      "t3code-cli",
      "--base-dir",
      resolveT3Home(config),
    ],
    { timeoutMs: 180_000, ...(env ? { env } : {}) },
  );
  try {
    const issued = JSON.parse(result.stdout) as Partial<IssuedSession>;
    if (typeof issued.sessionId !== "string" || typeof issued.token !== "string") throw new Error("missing fields");
    return issued as IssuedSession;
  } catch (cause) {
    throw new CliError("T3_AUTH_FAILED", "The upstream T3 CLI returned an invalid session credential.", {
      cause,
    });
  }
}

async function revokeSession(invocation: T3Invocation, config: CliConfig, sessionId: string): Promise<void> {
  const env = invocationEnv(invocation);
  await runProcess(
    invocation.command,
    [...invocation.argsPrefix, "auth", "session", "revoke", sessionId, "--base-dir", resolveT3Home(config)],
    { timeoutMs: 90_000, allowFailure: true, ...(env ? { env } : {}) },
  ).catch(() => undefined);
}

function asShellSnapshot(value: unknown): T3ShellSnapshot {
  const snapshot = record(value);
  if (!snapshot || !Array.isArray(snapshot.threads) || !Array.isArray(snapshot.projects)) {
    throw new CliError("T3_INVALID_SNAPSHOT", "T3 returned an invalid shell snapshot.");
  }
  return {
    snapshotSequence: typeof snapshot.snapshotSequence === "number" ? snapshot.snapshotSequence : 0,
    projects: snapshot.projects as T3Project[],
    threads: snapshot.threads as T3ShellSnapshot["threads"],
    archivedThreads: Array.isArray(snapshot.archivedThreads)
      ? (snapshot.archivedThreads as T3ShellSnapshot["archivedThreads"])
      : [],
  };
}

function asThreadDetail(value: unknown): ThreadDetailSnapshot | null {
  const snapshot = record(value);
  const projection = record(snapshot?.projection);
  const thread = record(projection?.thread);
  if (typeof snapshot?.snapshotSequence !== "number" || !projection || typeof thread?.id !== "string") return null;
  for (const key of ["runs", "runtimeRequests", "messages", "turnItems"]) {
    if (!Array.isArray(projection[key])) projection[key] = [];
  }
  return snapshot as unknown as ThreadDetailSnapshot;
}

export class T3Api {
  constructor(
    readonly runtime: T3Runtime,
    private readonly token: string,
  ) {}

  async request(method: "GET" | "POST", requestPath: string, payload?: unknown): Promise<unknown> {
    const url = new URL(requestPath, this.runtime.origin);
    if (url.origin !== new URL(this.runtime.origin).origin) {
      throw new CliError("INVALID_REQUEST_PATH", "Request path must stay on the T3 server origin.");
    }
    const { status, responseText } = await withHttpResponse(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          // Orchestration routes reject requests that do not name the protocol; others ignore it.
          [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        signal: AbortSignal.timeout(30_000),
      },
      payload === undefined ? undefined : JSON.stringify(payload),
      async (response) => ({
        status: response.statusCode ?? 0,
        responseText: await readResponseText(response),
      }),
    ).catch((cause) => {
      throw new CliError("T3_REQUEST_FAILED", `T3 request failed: ${method} ${url.pathname}`, { cause });
    });
    let body: unknown = null;
    if (responseText.length > 0) {
      try {
        body = JSON.parse(responseText) as unknown;
      } catch {
        body = responseText;
      }
    }
    if (status < 200 || status >= 300) {
      throw new CliError("T3_API_ERROR", `T3 returned HTTP ${status} for ${method} ${url.pathname}.`, {
        details: { status, body },
      });
    }
    return body;
  }

  /** Every active and archived thread with a summary of its live work, plus the projects. */
  async shellSnapshot(): Promise<T3ShellSnapshot> {
    return asShellSnapshot(await this.request("GET", "/api/orchestration/shell"));
  }

  /**
   * One thread's projection: runs, runtime requests, messages, and timeline items. `bounded` reads a
   * recent window, which keeps polling cheap on long threads; its runs and requests stay complete.
   */
  async threadDetail(threadId: string, options: { bounded?: boolean } = {}): Promise<ThreadDetailSnapshot> {
    const base = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
    let value: unknown;
    try {
      value = await this.request("GET", options.bounded ? `${base}/bounded` : base);
    } catch (cause) {
      const status = cause instanceof CliError ? (cause.details as { status?: unknown } | undefined)?.status : undefined;
      if (status === 404) {
        throw new CliError("THREAD_NOT_FOUND", `No T3 Code thread exists with id ${threadId}.`, {
          exitCode: 3,
          details: { threadId },
        });
      }
      throw cause;
    }
    const detail = asThreadDetail(value);
    if (!detail) throw new CliError("T3_INVALID_SNAPSHOT", `T3 returned an invalid projection for thread ${threadId}.`);
    return detail;
  }

  async projects(): Promise<T3Project[]> {
    const value = record(await this.request("GET", "/api/projects"));
    if (!value || !Array.isArray(value.projects)) {
      throw new CliError("T3_INVALID_SNAPSHOT", "T3 returned a project list without projects.");
    }
    return (value.projects as T3Project[]).filter((project) => project.deletedAt == null);
  }

  async mutateProject(mutation: { type: string; [key: string]: unknown }): Promise<unknown> {
    return await this.request("POST", "/api/projects/mutate", mutation);
  }

  /** Dispatches one orchestration V2 command and returns T3's event sequence for it. */
  async dispatchCommand(command: { type: string; commandId: string; [key: string]: unknown }): Promise<{ sequence: number }> {
    const result = record(await this.rpc(DISPATCH_COMMAND_RPC, command, DISPATCH_TIMEOUT_MS));
    if (typeof result?.sequence !== "number") {
      throw new CliError("T3_INVALID_DISPATCH", `T3 did not return an event sequence for ${command.type}.`);
    }
    return { sequence: result.sequence };
  }

  /**
   * Creates a thread, prepares its workspace, and starts its first message in one durable call. T3
   * records the launch under `commandId`, so a retry with the same id resumes it instead of repeating it.
   */
  async launchThread(input: Record<string, unknown>): Promise<{ threadId: string; resumed: boolean; projection: unknown }> {
    const result = record(await this.rpc(LAUNCH_THREAD_RPC, input, LAUNCH_TIMEOUT_MS));
    if (typeof result?.threadId !== "string") {
      throw new CliError("T3_INVALID_DISPATCH", "T3 did not return the launched thread.");
    }
    return { threadId: result.threadId, resumed: result.resumed === true, projection: result.projection ?? null };
  }

  /** Calls a WebSocket RPC, such as `server.getConfig`, with a short-lived ticket. */
  async rpc(tag: string, payload: unknown, timeoutMs = 30_000): Promise<unknown> {
    const issued = (await this.request("POST", "/api/auth/websocket-ticket")) as { ticket?: unknown } | null;
    if (typeof issued?.ticket !== "string" || issued.ticket.length === 0) {
      throw new CliError("T3_AUTH_FAILED", "T3 returned an invalid WebSocket ticket.");
    }
    const url = new URL("/ws", this.runtime.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", issued.ticket);
    url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
    return await rpcRequest(url, tag, payload, timeoutMs);
  }
}

export async function withT3Api<T>(
  runtime: T3Runtime,
  config: CliConfig,
  run: (api: T3Api, invocation: T3Invocation) => Promise<T>,
): Promise<T> {
  const invocation = await resolveT3Invocation(config.t3Command, runtime.serverVersion);
  const session = await issueSession(invocation, config);
  try {
    return await run(new T3Api(runtime, session.token), invocation);
  } finally {
    await revokeSession(invocation, config, session.sessionId);
  }
}
