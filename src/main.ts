import { resolve } from "node:path";
import { UnsafeRootPath } from "../ops/package/trusted-paths";
import { assertServiceRuntime, rootPathFailure, serviceInvocationPath } from "./ops/service-trust";

// Keep this bootstrap dependency-free: root checks the entire release before importing application code.
let trusted = true;
if (process.argv[2] === "service" && (process.geteuid?.() ?? process.getuid?.()) === 0) {
  try { assertServiceRuntime(resolve(import.meta.dir, ".."), process.execPath, {}, serviceInvocationPath(process.argv)); }
  catch (error) {
    console.log(JSON.stringify(error instanceof UnsafeRootPath ? rootPathFailure(error)
      : { error: "service-command-failed", nextAction: "check-service-configuration-and-paths" }));
    process.exitCode = 2;
    trusted = false;
  }
}
if (trusted) {
  if (process.argv.includes("--s14")) await (await import("./s14/main")).runS14();
  else await import("./app-cli");
}
