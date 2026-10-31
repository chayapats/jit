import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionVault } from "../src/exec/connections";
import { domainFixture, retryId, type DomainFixture } from "./fixtures/s14-domain";
const fixtures: DomainFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
test("private branch uses scoped credential and hardened broker; receipts, rotation and scope fence retries", async () => {
  const f = await domainFixture(); fixtures.push(f);
  const vault = new ConnectionVault(join(realpathSync(f.root), "vault"), { forbidden: [f.path] });
  f.app.git.options.vault = vault;
  const sha = "b".repeat(40), secret = "fixture-private-branch-token";
  f.app.execute(f.auth.actor, { kind: "coding.repository.grant", requestId: retryId(), expectedRevision: 0, payload: { id: "resource1", botId: "jit", url: "https://github.com/fixture/private.git", baseCommit: "a".repeat(40) } });
  const c = f.app.execute(f.auth.actor, { kind: "git.connection.create", requestId: retryId(), expectedRevision: 0, payload: { repositoryId: "resource1", label: "Private" } }).connection!;
  const stored = f.app.execute(f.auth.actor, { kind: "git.connection.secret.set", requestId: retryId(), expectedRevision: c.revision, payload: { connectionId: c.id, secret } }).connection!;
  let calls = 0;
  let before: (() => void) | undefined;
  f.app.coding.options.gitLimits = {
    createDirectory: () => mkdtempSync(join(f.root, "broker-")),
    async command(directory, argv) {
      calls++;
      expect(argv).toContain("core.hooksPath=/dev/null"); expect(argv).toContain("credential.helper=");
      expect(argv).toContain("http.followRedirects=false"); expect(argv).toContain("ls-remote");
      expect(argv).not.toContain(secret); expect(directory).not.toContain("workspace");
      before?.();
      // Trusted fixture replaces the process only, so no network or repository code executes.
      return ["/bin/sh", "-c", `test -n "$JIT_GIT_EFFECT_TOKEN" && printf '%s\\trefs/heads/Feature/private\\n' '${sha}'`];
    },
  };
  const command = { kind: "coding.repository.resolve" as const, requestId: retryId(), expectedRevision: 1, payload: { repositoryId: "resource1", baseBranch: "Feature/private", connection: { id: c.id, revision: stored.revision } } };
  const receipt = await f.app.coding.execute(f.auth.actor, command);
  expect(receipt.repository).toMatchObject({ revision: 2, baseCommit: sha });
  expect(await f.app.coding.execute(f.auth.actor, command)).toEqual(receipt); expect(calls).toBe(1);
  await expect(f.app.coding.execute(f.auth.actor, { ...command, payload: { ...command.payload, baseBranch: "other" } })).rejects.toThrow("request_id_conflict");
  await expect(f.app.coding.execute(f.auth.actor, { ...command, requestId: retryId() })).rejects.toThrow("coding_resource_denied");
  before = () => { f.app.execute(f.auth.actor, { kind: "git.connection.rotate", requestId: retryId(), expectedRevision: stored.revision, payload: { connectionId: c.id, secret: "fixture-rotated-token" } }); };
  await expect(f.app.coding.execute(f.auth.actor, { ...command, requestId: retryId(), expectedRevision: 2 })).rejects.toThrow("connection_out_of_scope");
  expect(f.app.coding.repositories(f.auth.actor)[0]!.revision).toBe(2);
});

test("private initial grant can connect an accepted slot before branch pinning without a pasted commit", async () => {
  const f = await domainFixture(); fixtures.push(f);
  f.app.git.options.vault = new ConnectionVault(join(realpathSync(f.root), "vault"), { forbidden: [f.path] });
  const c = f.app.execute(f.auth.actor, { kind: "git.connection.create", requestId: retryId(), expectedRevision: 0, payload: { repositoryId: "resource1", botId: "jit", label: "Private slot" } }).connection!;
  const stored = f.app.execute(f.auth.actor, { kind: "git.connection.secret.set", requestId: retryId(), expectedRevision: c.revision, payload: { connectionId: c.id, secret: "fixture-private-initial-token" } }).connection!;
  f.app.coding.options.gitLimits = { createDirectory: () => mkdtempSync(join(f.root, "broker-")), async command() {
    return ["/bin/sh", "-c", `printf '%s\\trefs/heads/main\\n' '${"c".repeat(40)}'`];
  } };
  const command = { kind: "coding.repository.grant" as const, requestId: retryId(), expectedRevision: 0, payload: { id: "resource1", botId: "jit", url: "https://github.com/fixture/private.git", baseBranch: "main", connection: { id: c.id, revision: stored.revision } } };
  const receipt = await f.app.coding.execute(f.auth.actor, command);
  expect(receipt.repository?.baseCommit).toBe("c".repeat(40));
  expect(await f.app.coding.execute(f.auth.actor, command)).toEqual(receipt);
  expect(f.app.authority.list(f.auth.actor)).toEqual([]);
});
