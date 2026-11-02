import { expect, test } from "bun:test";
import { fetchVmArtifact } from "../src/s15/vm/acquisition";
import type { VmArtifactOptions } from "../src/s15/vm/acquisition";
const input = { url: "https://download.test/file", sha256: "a".repeat(64), maxBytes: 1024 };
test.each(["deadline", "cancel"])("artifact %s fences a hung DNS lookup before any HTTP request", async mode => {
  const dns = Promise.withResolvers<readonly { address: string; family: number }[]>(), controller = new AbortController(); let expire = () => {}, cleared = 0, sends = 0;
  const options: VmArtifactOptions = { resolve: () => dns.promise, deadline: (ms, callback) => { expect(ms).toBe(30000); expire = callback; return () => { cleared++; }; },
    request: (() => { sends++; throw new Error("HTTP must not start"); }) as unknown as NonNullable<VmArtifactOptions["request"]> };
  const result = fetchVmArtifact(input, controller.signal, options);
  if (mode === "deadline") expire(); else controller.abort();
  if (mode === "deadline") await expect(result).rejects.toThrow("vm_acquisition_timeout"); else await expect(result).rejects.toHaveProperty("name", "AbortError");
  expect(cleared).toBe(1); dns.resolve([{ address: "93.184.216.34", family: 4 }]); await Promise.resolve(); expect(sends).toBe(0);
});
test("a pre-cancelled artifact request does not resolve DNS or create a timer", async () => {
  const controller = new AbortController(); controller.abort(); let touched = 0;
  await expect(fetchVmArtifact(input, controller.signal, { resolve: async () => { touched++; return []; }, deadline: () => { touched++; return () => {}; } })).rejects.toHaveProperty("name", "AbortError");
  expect(touched).toBe(0);
});
