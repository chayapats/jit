import { fstatSync, writeSync } from "node:fs";
import { AppError } from "../errors";
import { issueOwnerSetupLink, type OwnerSetupStore } from "../ops/owner-setup";

/** Issues/displays a bootstrap link once only for an interactive foreground terminal; never uses a logger. */
export function printS14OwnerSetupLink(store: OwnerSetupStore, origin: string,
  input: { isTTY?: boolean } = process.stdin, output: { isTTY?: boolean; write(text: string): unknown } = process.stdout): void {
  if (!input.isTTY || !output.isTTY) return;
  const link = issueOwnerSetupLink(store, origin);
  if (link) output.write(`${link}\n`);
}

/** Requires a dedicated inherited private pipe, excluding stdout/stderr and plaintext files, before issuing anything. */
export function requireS14OwnerLinkPipe(fd: number): void {
  if (!Number.isSafeInteger(fd) || fd < 3) throw new AppError("owner_link_private_pipe_required");
  try {
    const pipe = fstatSync(fd);
    if (!pipe.isFIFO() && !pipe.isSocket()) throw new Error("not_pipe");
    for (const standard of [1, 2]) {
      const output = fstatSync(standard);
      if (output.dev === pipe.dev && output.ino === pipe.ino) throw new Error("standard_output_alias");
    }
  } catch { throw new AppError("owner_link_private_pipe_required"); }
}

/** Local installer-only delivery: plaintext exists only in the dedicated pipe, never stdout, stderr or durable state. */
export function writeS14OwnerSetupLink(store: OwnerSetupStore, origin: string, fd: number): void {
  requireS14OwnerLinkPipe(fd);
  const link = issueOwnerSetupLink(store, origin);
  if (link) writeSync(fd, `${link}\n`);
}
