import { resolve } from "node:path";
import { deliverS14OwnerLink } from "../../ops/package/installer/owner-link";

await deliverS14OwnerLink([process.execPath, resolve(import.meta.dir, "../../src/main.ts"), "owner-link", "--s14", "--output-fd", "3"],
  { JIT_S14_DATABASE: process.env.JIT_S14_DATABASE!, JIT_S14_ORIGIN: process.env.JIT_S14_ORIGIN! }, process.env.JIT_S14_ORIGIN!);
console.log("installer-safe-progress");
