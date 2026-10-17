/** An expected application rejection with a safe, bounded public error code. */
export class AppError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}
