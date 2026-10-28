import { redactCredentials } from "./credentials";

/**
 * The service's log line writer. Every line passes `redactCredentials`, which also redacts every stored connection
 * value by fingerprint (app.connections/v1), so a secret echoed into a diagnostic never reaches the journal.
 */
export function logLine(text: string, stream: "stdout" | "stderr" = "stderr"): void {
  const line = redactCredentials(String(text));
  if (stream === "stdout") console.log(line); else console.error(line);
}
