import { expect, test } from "bun:test";
import { dictionaries } from "../src/i18n";
import { accessibilityProblems } from "./fixtures/a11y";
import { claim, report, teamFixture } from "./fixtures/s14-team";

test.each(["en", "th"] as const)("%s compound target source checks never certify a missing subclaim", async language => {
  const f = await teamFixture({ language });
  try {
    const label = "Documented retry semantics and measured retry behavior", missing = "Measured retry behavior was not tested";
    f.scripts.lanes.jit = async a => ({ state: "ready", text: "Fixture report", report: report([
      claim(a, await f.read(a), { covers: ["retry"] }),
    ], { missing: [missing] }) });
    const work = f.start({ bots: [{ id: "jit", revision: 1 }], requiredEvidence: [{ id: "retry", label, url: "https://example.com/article", coverage: "full_content_returned", freshness: "any" }] });
    await f.app.authority.drain();
    const before = f.app.reports.list(f.auth.actor, work.id), item = before[0]!;
    if (item.state !== "available") throw Error("Fixture report unavailable");
    expect(item.report).toMatchObject({ coverage: "partial", covered: ["retry"], modelMissing: [missing] });
    const html = await f.page(`/work/${work.id}?tab=report`), words = dictionaries[language];
    expect(html).toContain(words["s14.report.coverage.partial"]);
    expect(html).toContain(words["s14.report.covered"]);
    expect(html).toContain(words["s14.report.covered_scope"]);
    expect(html).toContain(`${words["s14.report.covers"]} ${label}`);
    expect(html).toContain(words["s14.report.missing_bot"]); expect(html).toContain(missing);
    expect(html).toContain(words["s14.report.completion.owner_review_required"]);
    expect(accessibilityProblems(html, language)).toEqual([]);
    expect(f.app.reports.list(f.auth.actor, work.id)).toEqual(before);
  } finally { f.close(); }
});
