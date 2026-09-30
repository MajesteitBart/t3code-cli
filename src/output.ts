import { CliError, toCliError } from "./errors.js";

export interface OutputOptions {
  json: boolean;
}

interface ErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
  cause?: ErrorEnvelope;
}

// Only structured CliError causes are reported. Other errors can quote process output, such as the
// stdout of `t3 auth session issue`, which holds a bearer token.
function errorEnvelope(error: CliError): ErrorEnvelope {
  return {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
    ...(error.cause instanceof CliError ? { cause: errorEnvelope(error.cause) } : {}),
  };
}

export function writeSuccess(data: unknown, options: OutputOptions, text?: string): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${text ?? JSON.stringify(data, null, 2)}\n`);
}

export function writeError(error: unknown, options: OutputOptions): CliError {
  const cliError = toCliError(error);
  if (options.json) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: errorEnvelope(cliError) }, null, 2)}\n`);
  } else {
    const cause = cliError.cause instanceof CliError ? ` Cause: ${cliError.cause.message}` : "";
    process.stderr.write(`t3code: ${cliError.message}${cause}\n`);
  }
  return cliError;
}
