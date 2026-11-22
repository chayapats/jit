import type { ReactNode } from "react";
import { appIcon } from "../../web-logo";

/**
 * Jit line icons for the S16 client: authored on the same 24-unit grid and 1.6 stroke as the S14/S15 set
 * (src/web-layout.ts). Icons are decorative; the control that holds one carries the accessible name.
 */
const paths = {
  plus: <path d="M12 5v14M5 12h14" />,
  compose: <><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="m18.4 3.6 2 2L12 14l-3 1 1-3Z" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  inbox: <><path d="M4 13 6.2 5.6A2 2 0 0 1 8.1 4h7.8a2 2 0 0 1 1.9 1.6L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" /><path d="M4 13h4.5l1 2.5h5l1-2.5H20" /></>,
  bots: <><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 8V4.5M9.5 13v1.5M14.5 13v1.5M2.5 12.5v3M21.5 12.5v3" /><circle cx="12" cy="3.6" r=".9" /></>,
  work: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.2 1.2L6.8 5M3.5 12l1.2 1.2L6.8 11M3.5 18l1.2 1.2L6.8 17" /></>,
  file: <><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  repeat: <><path d="M4 11V9a3 3 0 0 1 3-3h12m-3-3 3 3-3 3" /><path d="M20 13v2a3 3 0 0 1-3 3H5m3 3-3-3 3-3" /></>,
  memory: <><path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z" /></>,
  computer: <><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M8.5 20h7M12 16.5V20" /></>,
  plug: <><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0ZM12 16v5" /></>,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  download: <><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.6 2.5 3.8 5.5 3.8 9S14.6 18.5 12 21c-2.6-2.5-3.8-5.5-3.8-9S9.4 5.5 12 3Z" /></>,
  bell: <><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14ZM10 21h4" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  refresh: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4v4.5H15" /></>,
  shield: <><path d="M12 3 5 5.5v6c0 4.3 2.9 7.6 7 9.5 4.1-1.9 7-5.2 7-9.5v-6Z" /><path d="m9 12 2.2 2.2L15 10.4" /></>,
  clip: <path d="m20 11.5-7.8 7.8a4.6 4.6 0 0 1-6.5-6.5l8.3-8.3a3.1 3.1 0 0 1 4.4 4.4l-8.2 8.2a1.6 1.6 0 0 1-2.3-2.3l7.3-7.3" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></>,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  speaker: <><path d="M4 9.5h3l4.5-4v13l-4.5-4H4Z" /><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.7 7.7 0 0 1 0 11" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  chat: <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2 1.5-5A8 8 0 1 1 20 11.5Z" />,
  more: <><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
  desktop: <><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M12 8v6m-2.5-2.5L12 14l2.5-2.5M9 17.5h6" /></>,
  alert: <><path d="M12 4 2.8 19.5h18.4Z" /><path d="M12 10v4.5m0 2.5v.5" /></>,
  spark: <path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15a2 2 0 0 0-1.2-1.2L3.5 12 9 10.2A2 2 0 0 0 10.2 9Z" />,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2.5" /><path d="M4 10h16M8.5 3v4M15.5 3v4" /></>,
  book: <><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5Z" /><path d="M5 20.5A2.5 2.5 0 0 0 7.5 21H19M9 8h6" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

/** One decorative stroke icon; size comes from CSS (`.icon`, 18px by default). */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg className={className ? `icon ${className}` : "icon"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

/** The Jit mark (src/web-logo.ts geometry, no halo). Decorative: the surrounding element names the Bot or product. */
export function JitMark({ className }: { className?: string }) {
  return <svg className={className ? `jit-mark ${className}` : "jit-mark"} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><g transform="translate(0 -1.1)"><path d={appIcon.body} /><path fillRule="evenodd" d={appIcon.head} /><circle cx={appIcon.dot.cx} cy={appIcon.dot.cy} r={appIcon.dot.r} /></g></svg>;
}

/** A Bot's avatar: the Jit mark for the main Bot, otherwise the first letter of its name on a quiet tile. */
export function BotAvatar({ name, main, className }: { name: string; main?: boolean; className?: string }) {
  return <span className={`bot-avatar${main ? " bot-avatar-main" : ""}${className ? " " + className : ""}`} aria-hidden="true">{main ? <JitMark /> : [...name.trim()][0]?.toUpperCase() ?? "•"}</span>;
}
