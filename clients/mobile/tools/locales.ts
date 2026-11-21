import { en } from "../../../src/i18n/en";
import { th } from "../../../src/i18n/th";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Expo's Node config loader strips its entry TS but does not resolve transitive extensionless TS imports.
// Bun evaluates the actual dictionaries; only public copy enters this generated native-build input.
const project = resolve(import.meta.dir, ".."), root = resolve(project, "../..");
const sources = ["en", "th"].map(locale => ({ path: "src/i18n/" + locale + ".ts", sha256: new Bun.CryptoHasher("sha256").update(readFileSync(resolve(root, "src/i18n/" + locale + ".ts"))).digest("hex") }));
mkdirSync(resolve(project, ".local"), { recursive: true });
writeFileSync(resolve(project, ".local/locales.json"), JSON.stringify({ contract: "s16-mobile-locales/v1", sources, microphone: { en: en["s16.mobile.microphonePurpose"], th: th["s16.mobile.microphonePurpose"] }, localNetwork: { en: en["s16.mobile.localNetworkPurpose"], th: th["s16.mobile.localNetworkPurpose"] } }, null, 2) + "\n");
