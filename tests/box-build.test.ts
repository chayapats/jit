import { expect, test } from "bun:test";
import { buildArgs } from "../ops/box/build";

test("buildArgs returns the exact array for browser", () => {
  expect(buildArgs("browser", "2026-10-28")).toEqual(
    ["build", "--target", "browser", "-f", "ops/box/Containerfile", "-t", "jit-box-browser:2026-10-28", "."]);
});

test("invalid tag throws invalid_box_tag", () => {
  expect(() => buildArgs("base", "Bad Tag")).toThrow("invalid_box_tag");
});
