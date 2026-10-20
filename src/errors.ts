/** Safe identifiers a rejection may return so the owner can open the current proposal. */
export type AppErrorDetail = Readonly<Record<string, string | number>>;

/** An expected application rejection with a safe, bounded public error code. */
export class AppError extends Error {
  readonly detail: AppErrorDetail | null;
  constructor(readonly code: string, readonly status = 400, detail: AppErrorDetail | null = null) {
    super(code);
    this.detail = detail;
  }
}
