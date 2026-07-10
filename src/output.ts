import { CliError, toCliError } from "./errors.js";

export interface OutputOptions {
  json: boolean;
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
    process.stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          error: {
            code: cliError.code,
            message: cliError.message,
            ...(cliError.details === undefined ? {} : { details: cliError.details }),
          },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stderr.write(`t3code: ${cliError.message}\n`);
  }
  return cliError;
}
