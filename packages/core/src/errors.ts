export const ERROR_CODES = [
  "E_INVALID_ARGUMENT",
  "E_INVALID_CONFIG",
  "E_INPUT_NOT_FOUND",
  "E_OUTPUT_EXISTS",
  "E_DEPENDENCY_MISSING",
  "E_DEPENDENCY_MANIFEST",
  "E_DOWNLOAD_FAILED",
  "E_CHECKSUM_MISMATCH",
  "E_UNSAFE_ARCHIVE",
  "E_PROCESS_FAILED",
  "E_MEDIA_INSPECTION_FAILED",
  "E_UNSUPPORTED_MEDIA",
  "E_ENCODER_UNSUPPORTED_RESOLUTION",
  "E_INSUFFICIENT_SPACE",
  "E_CANCELLED",
  "E_JOB_STATE",
  "E_VERIFICATION_FAILED",
  "E_IO",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SerializedAppError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  toJSON(): SerializedAppError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function toAppError(error: unknown, fallbackCode: ErrorCode = "E_IO"): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError(fallbackCode, error.message, undefined, { cause: error });
  }
  return new AppError(fallbackCode, String(error));
}
