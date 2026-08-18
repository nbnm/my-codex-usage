import type {DisplaySafeError, ErrorCategory} from './types.js';

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly recovery: string | undefined;

  constructor(
    category: ErrorCategory,
    message: string,
    recovery?: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AppError';
    this.category = category;
    this.recovery = recovery;
  }
}

export function toDisplaySafeError(error: unknown): DisplaySafeError {
  if (error instanceof AppError) {
    return {
      category: error.category,
      message: error.message,
      recovery: error.recovery
    };
  }

  return {
    category: 'serviceUnavailable',
    message: 'Codex usage is temporarily unavailable.',
    recovery: 'Press r to try again.'
  };
}
