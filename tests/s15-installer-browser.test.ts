import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BROW15-02: `install.sh --s15` installs the pinned Chromium's system libraries, choosing t64 names where the
// distribution renamed them, and never fails the install over them (the Web names any missing library).
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const script = readFileSync(join(import.meta.dir, "../install.sh"), "utf8");
const start = script.indexOf('      if [ "$s15" = true ]; then\n        # BROW15-02'), end = script.indexOf("\n      fi ;;", start);
const block = script.slice(start, end) + "\n      fi\n";

async function run(t64: boolean, installs: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-s15-libs-"))); roots.push(root);
  const bin = join(root, "bin"), log = join(root, "apt.log"); mkdirSync(bin);
  writeFileSync(join(bin, "apt-cache"), `#!/bin/sh\ncase "$2" in *t64) ${t64 ? "exit 0" : "exit 100"} ;; esac\nexit 0\n`); chmodSync(join(bin, "apt-cache"), 0o755);
  writeFileSync(join(bin, "apt-get"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n${installs ? "exit 0" : "exit 100"}\n`); chmodSync(join(bin, "apt-get"), 0o755);
  writeFileSync(join(root, "run.sh"), `set -eu\ns15=true\ntimeout() { shift; "$@"; }\n${block}`);
  const child = Bun.spawn(["sh", join(root, "run.sh")], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  const [code, out] = [await child.exited, await new Response(child.stdout).text()];
  return { code, out, apt: readFileSync(log, "utf8").trim().split(" ") };
}

test("installs Playwright's Chromium library list with t64 names only where they exist", async () => {
  const noble = await run(true, true), bookworm = await run(false, true);
  expect(noble.code).toBe(0); expect(bookworm.code).toBe(0); expect(noble.out).toBe("");
  for (const name of ["libnss3", "libnspr4", "libgbm1", "libxkbcommon0", "libdrm2", "libx11-6", "fonts-liberation", "fonts-noto-color-emoji", "fonts-tlwg-loma-otf", "--no-install-recommends"]) { expect(noble.apt).toContain(name); expect(bookworm.apt).toContain(name); }
  for (const lib of ["libasound2", "libatk-bridge2.0-0", "libatk1.0-0", "libatspi2.0-0", "libcups2", "libglib2.0-0"]) {
    expect(noble.apt).toContain(`${lib}t64`); expect(noble.apt).not.toContain(lib);
    expect(bookworm.apt).toContain(lib); expect(bookworm.apt).not.toContain(`${lib}t64`);
  }
});

test("an unavailable library install continues and says where the reason appears", async () => {
  const failed = await run(true, false);
  expect(failed.code).toBe(0); expect(failed.out).toContain("Protected browser libraries could not be installed now");
});
