export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, options?: { exitCode?: number; details?: unknown; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.code = code;
    this.exitCode = options?.exitCode ?? 1;
    if (options?.details !== undefined) this.details = options.details;
  }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error) {
    return new CliError("UNEXPECTED_ERROR", error.message, { cause: error });
  }
  return new CliError("UNEXPECTED_ERROR", String(error));
}
