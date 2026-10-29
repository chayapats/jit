import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewBoxData, wipeBoxData } from "../src/exec/box-data";
import { PodmanBoxRuntime } from "../src/exec/podman-runtime";
import { readConfig } from "../src/config";

const roots: string[] = [], projectId = "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-box-data-")); roots.push(root);
  const directory = join(root, "execution"), project = join(directory, projectId);
  const workspace = join(project, "workspace"), profile = join(project, "profile");
  mkdirSync(workspace, { recursive: true }); mkdirSync(profile);
  writeFileSync(join(workspace, "unpushed.txt"), "unpushed"); writeFileSync(join(profile, "cookies"), "cookies");
  return { root, directory, project, workspace, profile };
}

test("box inventory discloses separate counts/bytes and binds drift without persisting paths or payloads", () => {
  const f = fixture(), old = previewBoxData(f.directory, projectId);
  expect(old).toMatchObject({ count: 2, bytes: 15, details: [
    { identity: `${projectId}:workspace`, count: 1, bytes: 8 }, { identity: `${projectId}:profile`, count: 1, bytes: 7 },
  ] });
  for (const text of [f.root, "unpushed.txt", "cookies", "unpushed"]) expect(JSON.stringify(old)).not.toContain(text);
  expect(previewBoxData(f.directory, projectId)).toEqual(old);
  writeFileSync(join(f.workspace, "late.txt"), "late");
  expect(previewBoxData(f.directory, projectId).digest).not.toBe(old.digest);
  wipeBoxData(f.directory, projectId); wipeBoxData(f.directory, projectId);
  expect(existsSync(f.workspace)).toBe(false); expect(existsSync(f.profile)).toBe(false);
  expect(existsSync(f.project)).toBe(true);
  expect(previewBoxData(f.directory, projectId).bytes).toBe(0);
  expect(previewBoxData(null, projectId).count).toBe(0);
  expect(() => wipeBoxData(join(f.root, "missing"), projectId)).not.toThrow();
});

test("box wipe refuses project/root/volume symlinks and never follows links inside a volume", () => {
  for (const boundary of ["directory", "project", "workspace", "profile"] as const) {
    const f = fixture(), outside = join(f.root, "outside"); mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "outside");
    rmSync(f[boundary], { recursive: true }); symlinkSync(outside, f[boundary]);
    expect(() => previewBoxData(f.directory, projectId)).toThrow("box_directory_unsafe");
    expect(() => wipeBoxData(f.directory, projectId)).toThrow("box_directory_unsafe");
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
  }
  const f = fixture(), outside = join(f.root, "keep"); writeFileSync(outside, "outside");
  symlinkSync(outside, join(f.workspace, "link"));
  symlinkSync(f.workspace, join(f.workspace, "cycle"));
  expect(previewBoxData(f.directory, projectId).count).toBe(2);
  wipeBoxData(f.directory, projectId);
  expect(readFileSync(outside, "utf8")).toBe("outside");
});

test("reset wipes workspace/profile with an absent Podman executable using an injected runner", async () => {
  const f = fixture();
  const config = readConfig({ JIT_DATABASE: join(f.root, "state", "db"), JIT_EXECUTION_DIR: f.directory,
    JIT_EXECUTION_SECRETS_DIR: join(f.root, "secrets"), JIT_BOX_IMAGE_BASE: `localhost/box@sha256:${"a".repeat(64)}` });
  const runtime = new PodmanBoxRuntime({ config: config.execution, run: async () => { throw Object.assign(new Error("fixture missing executable"), { code: "ENOENT" }); } });
  await runtime.stop({ projectId });
  await runtime.reset({ projectId }, { wipeWorkspace: true });
  expect(existsSync(f.workspace)).toBe(false); expect(existsSync(f.profile)).toBe(false);
  await runtime.reset({ projectId }, { wipeWorkspace: true });
});
