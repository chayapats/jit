import { expect, test } from "bun:test";
import { dropsAllCapabilities, forwardingDisabled } from "../src/exec/container-checks";
import type { CommandRunner } from "../src/exec/podman-runtime";

const runner = (exitCode: number, stdout: string, calls: string[][] = []) =>
  (async (argv: readonly string[]) => { calls.push([...argv]); return { exitCode, stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array() }; }) as unknown as CommandRunner;
const status = (bnd: string) => `Name:\tsleep\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t${bnd}\nCapAmb:\t0000000000000000\n`;
// Podman 4.9.3 (Ubuntu 24.04) inspect for --cap-drop=ALL: CapDrop lists each capability; BoundingCaps/EffectiveCaps are null.
const podman49 = { HostConfig: { CapAdd: [], CapDrop: ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_KILL", "CAP_SETUID"] }, BoundingCaps: null, EffectiveCaps: null };

test("inspect proof (CapDrop ALL or empty cap arrays) needs no exec", async () => {
  const calls: string[][] = [];
  expect(await dropsAllCapabilities(runner(0, "", calls), "c", { HostConfig: { CapDrop: ["ALL"] } })).toBe(true);
  expect(await dropsAllCapabilities(runner(0, "", calls), "c", { HostConfig: {}, BoundingCaps: [], EffectiveCaps: [] })).toBe(true);
  expect(calls).toEqual([]);
});

test("Podman 4.9 form is proven by PID 1's capability sets inside the container", async () => {
  const calls: string[][] = [];
  expect(await dropsAllCapabilities(runner(0, status("0000000000000000"), calls), "jit-searxng", podman49)).toBe(true);
  expect(calls).toEqual([["exec", "jit-searxng", "cat", "/proc/1/status"]]);
  // Without --cap-drop=ALL the bounding set is the default (observed 00000000800405fb).
  expect(await dropsAllCapabilities(runner(0, status("00000000800405fb")), "c", podman49)).toBe(false);
  expect(await dropsAllCapabilities(runner(1, ""), "c", podman49)).toBe(false);
  expect(await dropsAllCapabilities(runner(0, "garbage"), "c", podman49)).toBe(false);
  expect(await dropsAllCapabilities(runner(0, status("0000000000000000")), "c", { ...podman49, HostConfig: { CapAdd: ["NET_RAW"], CapDrop: ["ALL"] } })).toBe(false);
});

test("forwarding is proven off in the container namespace; a missing IPv6 stack counts as off", async () => {
  expect(await forwardingDisabled(runner(0, "0\n0\n"), "p")).toBe(true);
  expect(await forwardingDisabled(runner(0, "1\n0\n"), "p")).toBe(false);
  expect(await forwardingDisabled(runner(0, "0\n1\n"), "p")).toBe(false);
  expect(await forwardingDisabled(runner(0, "0\n"), "p")).toBe(false);
  expect(await forwardingDisabled(runner(1, ""), "p")).toBe(false);
});
