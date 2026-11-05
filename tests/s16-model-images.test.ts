import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createImageContent } from "schway/host";
import { AppError } from "../src/errors";
import { openModelService } from "../src/s15/model";
import { modelWorkFixture } from "./fixtures/s15-model-work";
import { routeTransport, ROUTE_MODEL } from "./fixtures/s15-route-transport";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
for (const route of ["codex", "grok"] as const) test(`MODEL15 sends actual image bytes over the public ${route} adapter; each physical send repeats the source guard`, async () => {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  for (const model of f.routes) { model.provider = route; model.modelId = ROUTE_MODEL[route]; model.charge = route === "codex" ? "subscription" : "metered"; }
  const expectedSends = route === "grok" ? 2 : 1, transport = routeTransport(route, { responses: route === "grok" ? [401, "ok"] : ["ok"] });
  let admitted = 0, disclosed = 0;
  const service = openModelService({ ...f.modelOptions(), guardWork: id => { f.policy.work.guard(f.policy.control.bindWork(id)); }, routeAuth: { store: transport.store, fetch: transport.fetch }, disclosure: { allows: () => true, guard(_work, _route, request) { expect(JSON.stringify(request)).not.toContain("imageData"); disclosed++; } } }); cleanups.push(() => service.close());
  const bytes = readFileSync(join(import.meta.dir, "../src/evidence/fixtures/image-probe.png")), image = createImageContent("file_fixture", "image/png", bytes), work = f.source("image");
  const record = await service.runStep(work.actor!, { stepId: "image", difficulty: "ordinary", text: "Describe the supplied image.", ownerDecisions: [], sources: [], images: [image] }, undefined, { beforeCall() {}, images: { options: { probes: [{ contract: "schway.host.image-input/v1", route, model: ROUTE_MODEL[route], verdict: "pass", revision: "controlled-fixture-only", testedAt: "2026-11-05T00:00:00Z" }], async resolve() { return bytes; } }, beforeSend(data) { admitted++; expect(Buffer.from(data.get(image.sha256)!)).toEqual(bytes); } } });
  expect({ state: record.state, code: record.code }).toEqual({ state: "completed", code: null }); expect(transport.bodies).toHaveLength(expectedSends); expect(admitted).toBe(expectedSends); expect(disclosed).toBeGreaterThanOrEqual(expectedSends);
  for (const body of transport.bodies) expect(body).toContain("data:image/png;base64," + bytes.toString("base64"));
  expect(record.physicalDispatches!.map(row => row.kind)).toEqual(route === "grok" ? ["initial", "auth-retry"] : ["initial"]);
  const scan = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) scan(path); else if (entry.isFile()) { const stored = readFileSync(path); expect(stored.includes(bytes)).toBe(false); expect(stored.includes(Buffer.from(bytes.toString("base64")))).toBe(false); } } };
  scan(f.root);
});
test("source withdrawal at an image auth resend refuses that physical send", async () => {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup()); const route = "grok";
  for (const model of f.routes) { model.provider = route; model.modelId = ROUTE_MODEL[route]; model.charge = "metered"; }
  const transport = routeTransport(route, { responses: [401, "ok"] }), service = openModelService({ ...f.modelOptions(), guardWork: id => { f.policy.work.guard(f.policy.control.bindWork(id)); }, routeAuth: { store: transport.store, fetch: transport.fetch } }); cleanups.push(() => service.close());
  const bytes = readFileSync(join(import.meta.dir, "../src/evidence/fixtures/image-probe.png")), image = createImageContent("file_fixture", "image/png", bytes), work = f.source("image"); let sends = 0;
  const record = await service.runStep(work.actor!, { stepId: "image", difficulty: "ordinary", text: "Describe the image.", ownerDecisions: [], sources: [], images: [image] }, undefined, { beforeCall() {}, images: { options: { probes: [{ contract: "schway.host.image-input/v1", route, model: ROUTE_MODEL[route], verdict: "pass", revision: "controlled-fixture-only", testedAt: "2026-11-05T00:00:00Z" }], async resolve() { return bytes; } }, beforeSend() { if (++sends === 2) throw new AppError("lineage_withdrawn"); } } });
  expect(transport.bodies).toHaveLength(1); expect(record.state).not.toBe("completed"); expect(record.output).toBeNull(); expect(record.code).toBe("auth_retry_refused");
});
