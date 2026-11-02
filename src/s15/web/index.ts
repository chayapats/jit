/** Opt-in S15 owner Web UI (UX15-01). Mounted only by explicit S15 composition; S14 stays the default runtime and UI. */
export { createS15WebHandler, s15ConversationPort } from "./handler";
export type { S15WebOptions } from "./handler";
export { lookupS15Asset, s15AssetUrl } from "./assets";
export type * from "./types";
