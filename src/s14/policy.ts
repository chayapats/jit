import { supportedS14Routes } from "./sign-in";
import type { Policy } from "./types";

/** Fresh-install service ceilings need no environment overrides; available slots still require exact owner capability acceptance. */
export function s14Policy(env: NodeJS.ProcessEnv = {}): Policy {
  return { routes: env.JIT_S14_ROUTES ? JSON.parse(env.JIT_S14_ROUTES) : supportedS14Routes(),
    tools: ["web_search", "web_fetch", "computer", "coding", "effect_push"], resources: JSON.parse(env.JIT_S14_RESOURCES ?? "[]") };
}
