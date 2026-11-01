import { resolve } from "node:path";
import { UnsafeRootPath } from "../ops/package/trusted-paths";
import { assertServiceRuntime, rootPathFailure, serviceInvocationPath } from "./ops/service-trust";
import { RuntimeSelectionError, selectRuntime } from "./runtime-selection";

// Keep this bootstrap dependency-light: root checks the release before importing operator/application code.
try {
  const selected = selectRuntime(process.argv.slice(2));
  if (selected.runtime === "service") {
    if ((process.geteuid?.() ?? process.getuid?.()) === 0) {
      assertServiceRuntime(resolve(import.meta.dir, ".."), process.execPath, {}, serviceInvocationPath(process.argv));
    }
    const { runServiceCommand } = await import("./ops/service-cli");
    const result = await runServiceCommand(selected.args.slice(1), { cwd: process.cwd(), readPassword: async () => {
      if (!process.stdin.isTTY) {
        if (!selected.args.includes("--password-stdin")) throw new Error("password_stdin_flag_required");
        const input = await Bun.stdin.text();
        if (input.length > 258) throw new Error("password_input_too_long");
        return input.replace(/\r?\n$/, "");
      }
      return (await import("./terminal-password")).readHiddenPassword();
    } });
    console.log(JSON.stringify(result.output));
    process.exitCode = result.exitCode;
  } else if (selected.runtime === "s14") await (await import("./s14/main")).runS14(selected.args);
  else await (await import("./app-cli")).runLegacy(selected.args);
} catch (error) {
  if (error instanceof UnsafeRootPath) {
    console.log(JSON.stringify(rootPathFailure(error)));
    process.exitCode = 2;
  } else {
    console.error(error && typeof error === "object" && "code" in error && error.code === "scheduler_unavailable"
      ? "Jit job admission is unavailable. Stop the other Jit instance or verify stale scheduler ownership before retrying."
      : JSON.stringify({ error: error instanceof RuntimeSelectionError ? error.message : "runtime_command_failed" }));
    process.exitCode = 1;
  }
}
