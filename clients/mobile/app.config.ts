import type { ExpoConfig } from "expo/config";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { mobileBuildConfig } from "./tools/build-config.ts";

const copy = JSON.parse(readFileSync(resolve(__dirname, ".local/locales.json"), "utf8")) as { contract: string; sources: { path: string; sha256: string }[]; microphone: { en: string; th: string }; localNetwork: { en: string; th: string } };
if (copy.contract !== "s16-mobile-locales/v1" || copy.sources.length !== 2 || copy.sources.some((source, index) => source.path !== `src/i18n/${index ? "th" : "en"}.ts` || source.sha256 !== createHash("sha256").update(readFileSync(resolve(__dirname, "../..", source.path))).digest("hex")) || typeof copy.microphone.en !== "string" || typeof copy.microphone.th !== "string") throw new Error("mobile_locales_stale");

/** Local native builds only. Jit service selection and credentials stay runtime owner input. */
const selected = mobileBuildConfig(process.env, resolve(__dirname, ".local/public-build"));
const config: ExpoConfig = {
  name: "Jit",
  slug: "jit-mobile",
  version: "0.1.0",
  scheme: "jit",
  platforms: ["ios", "android"],
  icon: "../../src/web-assets/icons/icon-512.png",
  userInterfaceStyle: "automatic",
  ios: { bundleIdentifier: selected.applicationId, buildNumber: String(selected.buildNumber), supportsTablet: true, entitlements: { "keychain-access-groups": ["$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)"] }, infoPlist: { NSLocalNetworkUsageDescription: copy.localNetwork.en, NSMicrophoneUsageDescription: copy.microphone.en } },
  android: { package: selected.applicationId, versionCode: selected.buildNumber, ...(selected.googleServicesFile ? { googleServicesFile: selected.googleServicesFile } : {}), permissions: ["android.permission.RECORD_AUDIO", "android.permission.POST_NOTIFICATIONS"], blockedPermissions: ["com.google.android.gms.permission.AD_ID", "android.permission.ACCESS_ADSERVICES_AD_ID", "android.permission.ACCESS_ADSERVICES_ATTRIBUTION", "android.permission.ACCESS_ADSERVICES_TOPICS"] },
  updates: { enabled: false, checkAutomatically: "NEVER" },
  locales: {
    en: { ios: { NSMicrophoneUsageDescription: copy.microphone.en, NSLocalNetworkUsageDescription: copy.localNetwork.en } },
    th: { ios: { NSMicrophoneUsageDescription: copy.microphone.th, NSLocalNetworkUsageDescription: copy.localNetwork.th } }
  },
  plugins: [
    ["expo-secure-store", { configureAndroidBackup: true }],
    ["expo-notifications", { enableBackgroundRemoteNotifications: false }],
    ["expo-build-properties", { ios: { deploymentTarget: "16.4" }, android: { minSdkVersion: 24, compileSdkVersion: 37, targetSdkVersion: 36, buildToolsVersion: "37.0.0" } }],
    "./plugins/withJitNativeBoundary.cjs"
  ]
};
export default config;
