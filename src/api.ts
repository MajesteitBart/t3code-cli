import { CliError } from "./errors.js";
import { resolveT3Invocation, runProcess, type T3Invocation } from "./process.js";
import { resolveT3Home } from "./runtime.js";
import type { CliConfig, OrchestrationSnapshot, T3Runtime } from "./types.js";

const DISPATCH_COMMAND_RPC = "orchestration.dispatchCommand";
// T3 allows `git worktree add` five minutes; fetching origin and a synchronous setup script come on top.
const RPC_TIMEOUT_MS = 10 * 60_000;

interface IssuedSession {
  sessionId: string;
  token: string;
}

interface RpcCauseReason {
  _tag?: unknown;
  error?: unknown;
  defect?: unknown;
}

function rpcFailure(tag: string, exit: Record<string, unknown>): CliError {
  const reasons = Array.isArray(exit.cause) ? (exit.cause as RpcCauseReason[]) : [];
  const failure = reasons.find((reason) => reason._tag === "Fail")?.error as Record<string, unknown> | undefined;
  const defect = reasons.find((reason) => reason._tag === "Die")?.defect;
  const message =
    typeof failure?.message === "string"
      ? failure.message
      : typeof defect === "string"
        ? defect
        : `T3 rejected ${tag}.`;
  return new CliError("T3_RPC_FAILED", message, {
    details: {
      rpc: tag,
      ...(typeof failure?._tag === "string" ? { errorTag: failure._tag } : {}),
      ...(typeof failure?.bootstrapThreadDisposition === "string"
        ? { bootstrapThreadDisposition: failure.bootstrapThreadDisposition }
        : {}),
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

async function issueSession(invocation: T3Invocation, config: CliConfig): Promise<IssuedSession> {
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
    { timeoutMs: 90_000 },
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

async function revokeSession(
  invocation: T3Invocation,
  config: CliConfig,
  sessionId: string,
): Promise<void> {
  await runProcess(
    invocation.command,
    [
      ...invocation.argsPrefix,
      "auth",
      "session",
      "revoke",
      sessionId,
      "--base-dir",
      resolveT3Home(config),
    ],
    { timeoutMs: 90_000, allowFailure: true },
  ).catch(() => undefined);
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
    // No `connection: close`: Node 26's fetch asserts when T3 closes the socket mid-body on large snapshots.
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(30_000),
    }).catch((cause) => {
      throw new CliError("T3_REQUEST_FAILED", `T3 request failed: ${method} ${url.pathname}`, { cause });
    });
    const responseText = await response.text();
    let body: unknown = null;
    if (responseText.length > 0) {
      try {
        body = JSON.parse(responseText) as unknown;
      } catch {
        body = responseText;
      }
    }
    if (!response.ok) {
      throw new CliError("T3_API_ERROR", `T3 returned HTTP ${response.status} for ${method} ${url.pathname}.`, {
        details: { status: response.status, body },
      });
    }
    return body;
  }

  async snapshot(): Promise<OrchestrationSnapshot> {
    return (await this.request("GET", "/api/orchestration/snapshot")) as OrchestrationSnapshot;
  }

  async shellSnapshot(): Promise<OrchestrationSnapshot> {
    return (await this.request("GET", "/api/orchestration/shell")) as OrchestrationSnapshot;
  }

  async dispatch(command: unknown): Promise<unknown> {
    return await this.request("POST", "/api/orchestration/dispatch", command);
  }

  /**
   * T3 only runs `thread.turn.start` bootstraps (thread creation plus worktree preparation) for
   * WebSocket RPC clients. Its HTTP dispatch route passes the command straight to the engine,
   * which rejects the turn because the thread does not exist yet.
   */
  async dispatchOverWebSocket(command: unknown): Promise<unknown> {
    const issued = (await this.request("POST", "/api/auth/websocket-ticket")) as { ticket?: unknown } | null;
    if (typeof issued?.ticket !== "string" || issued.ticket.length === 0) {
      throw new CliError("T3_AUTH_FAILED", "T3 returned an invalid WebSocket ticket.");
    }
    const url = new URL("/ws", this.runtime.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", issued.ticket);
    return await rpcRequest(url, DISPATCH_COMMAND_RPC, command, RPC_TIMEOUT_MS);
  }
}

export async function withT3Api<T>(
  runtime: T3Runtime,
  config: CliConfig,
  run: (api: T3Api, invocation: T3Invocation) => Promise<T>,
): Promise<T> {
  const invocation = await resolveT3Invocation(config.t3Command);
  const session = await issueSession(invocation, config);
  try {
    return await run(new T3Api(runtime, session.token), invocation);
  } finally {
    await revokeSession(invocation, config, session.sessionId);
  }
}
