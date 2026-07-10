import { CliError } from "./errors.js";
import { resolveT3Invocation, runProcess, type T3Invocation } from "./process.js";
import { resolveT3Home } from "./runtime.js";
import type { CliConfig, OrchestrationSnapshot, T3Runtime } from "./types.js";

interface IssuedSession {
  sessionId: string;
  token: string;
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
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        connection: "close",
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
