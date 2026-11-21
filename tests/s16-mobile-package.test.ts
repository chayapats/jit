import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealMobileArtifact, verifyMobileArtifact, type MobileArtifact } from "../ops/mobile/artifact";
import { mobileBuildSelection } from "../ops/mobile/build";
import { mobilePackageCommand } from "../ops/mobile/main";

const sha = "a".repeat(64), metadata: Omit<MobileArtifact, "id" | "files"> = { contract: "s16-mobile-artifact/v1", platform: "android", architecture: "arm64", acceptance: "build-only", source: { commit: "b".repeat(40), rootLockSha256: sha, clientLockSha256: sha, podLockSha256: sha, appleInputsSha256: sha, androidInputsSha256: sha, verificationSha256: sha, noticesSha256: sha }, toolchain: { bun: "1.4.2", nodeVersion: "v24.22.3", nodeSha256: sha, native: ["Synthetic artifact fixture, not a compiled APK or device acceptance"] } };

test("mobile integrity seal refuses modified/extra payloads and links without executing or installing them", () => {
  const directory = mkdtempSync(join(tmpdir(), "jit-mobile-artifact-")), payload = join(directory, "fixture.bin");
  try {
    writeFileSync(payload, "synthetic-public-payload"); const manifest = sealMobileArtifact(directory, metadata); expect(verifyMobileArtifact(directory).id).toBe(manifest.id); expect(manifest.acceptance).toBe("build-only");
    writeFileSync(payload, "modified"); expect(() => verifyMobileArtifact(directory)).toThrow("mobile_artifact_changed"); writeFileSync(payload, "synthetic-public-payload");
    writeFileSync(join(directory, "unexpected.txt"), "extra"); expect(() => verifyMobileArtifact(directory)).toThrow("mobile_artifact_changed"); rmSync(join(directory, "unexpected.txt"));
    symlinkSync(payload, join(directory, "linked")); expect(() => verifyMobileArtifact(directory)).toThrow("mobile_artifact_link_refused"); rmSync(join(directory, "linked"));
    const forged = JSON.parse(readFileSync(join(directory, "mobile-manifest.json"), "utf8")); forged.files[0].path = "../outside"; writeFileSync(join(directory, "mobile-manifest.json"), JSON.stringify(forged)); expect(() => verifyMobileArtifact(directory)).toThrow("mobile_artifact_changed");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native build/verify CLI refuses arbitrary commands, extra fields, URLs and signing credentials at selection", async () => {
  const selected = { contract: "s16-mobile-build/v1", platform: "android", output: "/fixture/new", node: "/fixture/node", android: { javaHome: "/fixture/java", sdk: "/fixture/sdk", gradleHome: "/fixture/gradle" } } as const;
  expect(mobileBuildSelection(selected)).toEqual(selected);
  for (const value of [{ ...selected, command: "ignored" }, { ...selected, platform: "production" }, { ...selected, node: "https://example.test/node" }, { ...selected, signingKey: "ignored" }, { ...selected, android: { ...selected.android, command: "ignored" } }]) expect(() => mobileBuildSelection(value)).toThrow("mobile_build_selection_invalid");
  for (const args of [["install", "/fixture"], ["exec", "ignored"], ["verify", "/fixture", "--run"], ["build", "--command"]]) await expect(mobilePackageCommand(args)).rejects.toThrow("mobile_arguments_invalid");
});
