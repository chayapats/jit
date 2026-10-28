import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildArgs } from "../ops/box/build";
import { installCommand } from "../src/exec/mcp-gateway";

test("buildArgs returns the exact array for browser", () => {
  expect(buildArgs("browser", "2026-10-28")).toEqual(
    ["build", "--target", "browser", "-f", "ops/box/Containerfile", "-t", "jit-box-browser:2026-10-28", "."]);
});

test("invalid tag throws invalid_box_tag", () => {
  expect(() => buildArgs("base", "Bad Tag")).toThrow("invalid_box_tag");
});

test("the base image ships every tool the MCP install commands run (npm, python3 venv)", () => {
  const base = readFileSync(join(import.meta.dir, "../ops/box/Containerfile"), "utf8").split("FROM base AS browser")[0]!;
  const packages = new Set(base.match(/apt-get install[^&]*/)![0].split(/[\s\\]+/));
  const spec = { name: "notes", args: [], env: [], command: "notes" };
  expect(installCommand({ ...spec, source: "npm", package: "@fixture/notes-mcp", version: "1.4.2" }, "/workspace/.jit/mcp/notes")).toContain("npm install --prefix");
  expect(installCommand({ ...spec, source: "pypi", package: "mcp-notes", version: "1.4.2" }, "/workspace/.jit/mcp/notes")).toContain("python3 -m venv");
  for (const name of ["nodejs", "npm", "python3", "python3-venv"]) expect(packages.has(name)).toBe(true);
});
