# s16-point-files/v1

Status: protected file-inventory/retention layer of s16-recovery-point/v1 under
[ADR 0110](../adr/0110-s16-point-files-and-explicit-retention.md). A matching
inventory does not certify native ancestry, current external continuity or
restore admission. The aggregate producer must prove its owning semantic gates.

The fixed private point directory is operations/points/<pointId>. It contains
manifest.json, references.json, capture.json, ledgers/<pointId>/manifest.json
and its named SQL images, and payloads/<pointId>/manifest.json and its exact
opaque files. No other file/directory, alias, link or special node is allowed.
Component roles and locations are fixed by code; archive strings never select
host destinations. The original current receipt supplies point/installation/
owner/operation and manifest hash before any candidate metadata is trusted.

The four manifest components are ledgers, payloads, references and capture,
with closed contract/custody identities and index bytes/hashes. Ledger and
payload indices retain their existing component contracts. Payload aliases
distinguish FILE, GitHub and native data. Native plan/manifest hashes and root
aliases must agree with capture metadata; their JSON is bounded but opaque
native bodies are not decoded here. Actual native ancestry still requires the
public SDK quarantine verifier, and SQL integrity its owning verifier.

The producer also requires complete `file_cohort.json` and `github_cohort.json`
payload catalogs. Their original cut hashes authenticate roles, pending/parser
facts and exact payload correlations. They count toward the metadata bound. The
mechanical inventory returns `catalogs: present|absent`; earlier format fixtures
without catalogs remain readable for retention, without producer completeness.

Aggregate metadata, including indices/reference/capture/native plan metadata,
is at most 4 MiB. SQL is at most 2 GiB, payload data at most 4 GiB, total point
bytes at most 6 GiB, 256 SQL sources and 20,000 payload files. Every file is a
private same-owner single-link regular file; reads stream at most 64 KiB and
check original attributes, EOF and hashes. The resulting inventory includes
original identity digests so substitution cannot become cleanup authority.

Removal requires an original current cleanup request and point receipt. A
bounded private plan (8 MiB, outside the point) binds the original operation,
point/manifest hash/bytes, exact scoped file identities and five directory
identities. Its SHA-256 is part of the original remove action ID. It never
contains a user-selected absolute path. Persist it before the first unlink.
The retained-plan namespace is bounded to 8 GiB, 100,000 nodes and depth four;
quota exhaustion refuses, with no implicit eviction of original plans.

Continue only that original plan. Verify every remaining file before deletion;
missing files may be original completed unlinks, but extra, replaced or changed
content refuses. Remove only the five fixed directories after their expected
children are absent. Flush each parent after mutation. An uncertain boundary
retains the original action/fence/removing point. Only conclusive absence
confirms the action and removes its point-custody row; request/plan/receipt
history remains. An unfinished operation referencing the point prevents removal.

Repeated completed removal returns the original result and never deletes a
reappeared directory. No automatic quota eviction, sidecar-suffix deletion or
recursive deletion runs. Ordinary clients/models cannot invoke this protected
operator surface or supply its lease, journal, plan or expected receipt.

The protected operator CLI is `bun run s16:ops cleanup --s15 --config <config>
--request-id <original-request> --point-id <receipted-point>`. After interruption,
repeat the same request/point. An optional `--attempt` names a distinct attempt
only after the previous attempt was independently observed not applied; changing
it cannot bypass an unsettled original action. This removes recovery-point
copies only. It does not purge application data, current credentials, native
stores, guest disks, operations receipts or the original removal plan.
