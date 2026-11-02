/** Opt-in protected GIT15 API. No module selects S15, installs a personal rule or exposes a raw account capability. */
export { GithubService, githubReadHandler } from "./service";
export { createGithubHandler } from "./http";
export { createGithubConversationTools } from "./conversation";
export { GithubStore } from "./store";
export { createGithubActionAdapter } from "./adapter";
export { HttpProtectedGithubGateway } from "./gateway";
export { GithubApiGateway } from "./github-api";
export type { GithubProtectedPush } from "./github-api";
export { ProtectedGithubPush } from "./push";
export { githubReadiness, githubEligibility, githubProtectionMatches } from "./readiness";
export { createGithubVmWorkspace } from "./workspace";
export type { GithubWorkingVm } from "./workspace";
export type * from "./types";
