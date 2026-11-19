/** Product launch removes testing shortcuts affecting browser protection, native audio, storage and Web Push. */
export const desktopIgnoredDefaults = Object.freeze([
  "--password-store=basic", "--use-mock-keychain", "--disable-background-networking", "--disable-component-update",
  "--disable-component-extensions-with-background-pages", "--disable-client-side-phishing-detection", "--disable-ipc-flooding-protection",
  "--disable-popup-blocking", "--disable-prompt-on-repost", "--unsafely-disable-devtools-self-xss-warnings", "--mute-audio",
]);
