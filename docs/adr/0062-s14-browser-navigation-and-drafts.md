---
status: accepted for the owner-approved Plain replacement
date: 2026-11-02
scope: S14-AC13; FR-10/23/24/25; NFR-07/11/13
---

# Browser-local navigation and text-only drafts

The owner approved opening the latest Jit conversation independently per browser, local composer drafts surviving reload/browser restart, and expiry 30 days after the last edit. The owner chose direct replacement of the whole S14 UI without an old renderer or compatibility layer. These decisions do not change the S14 service command/authority contracts.

## Navigation

An authenticated successful Jit conversation GET sets a non-authorizing `jit_s14_chat` preference cookie (`__Host-jit_s14_chat` on HTTPS), with HttpOnly, SameSite=Strict, Path=/, a finite 30-day lifetime and Secure on HTTPS. The root reads it only after ordinary authentication. Its value is untrusted: the product re-queries the conversation and requires its Bot to be Jit. Missing, malformed, duplicate, unavailable and other-Bot values fall back to the latest-created Jit conversation. Explicit deep links select their named conversation directly. No GET creates a conversation, grant, reply or work intent. The ordinary explicit conversation.create command remains unchanged.

## Draft storage

The hashed external enhancement asset stores only the composer's text, completion text and evidence-target text in localStorage. Each record also has a last-edit timestamp and an optional pending request ID for clearing after a committed submission. Keys are scoped to a public digest of this installation's initial Jit conversation and current owner generation, plus conversation identity. This digest is not an authentication credential. Other namespaces are cleared on the next authenticated page; expired/malformed/future/oversized/extra-field records are discarded. Each record is size-bounded; browser storage denial/quota failure is visible and cannot block ordinary typing or form submission. Unexpired drafts are not silently evicted to make room for another conversation.

The service's public credential-pattern shapes are included in the hashed asset; actual registered secrets/fingerprints are never sent to the browser. Credential-shaped drafts are removed rather than persisted. Only the ordinary composer participates; connection/password/OAuth/approval/computer-input forms never autosave. This is pattern screening, not a claim that arbitrary unlabelled sensitive text can be identified. Local drafts remain private browser data, outside service backups and exports. Explicit logout clears local draft records; normal session expiry retains them for authenticated recovery within their original lifetime.

Storage is untrusted. Restoring can fill only those three text controls; it cannot restore Work mode, Bot/resource/tool selections, limits, expected revisions, retry keys, approvals or owner identity. Refused server text and explicit owner Start prefills take precedence. History restoration resets Work. A page restored from the browser page cache performs a read-only reload so spent retry IDs, approval controls and lease revisions are not reused. Native history keeps the return entry; no command is automatically retried. Active page-memory retention across a Bot lifecycle transition still preserves the live form's choices without copying old hidden revisions. Closed Bots may show saved text without enabling a composer.

An attempted submit does not delete the draft. Successful message/work-start redirects include their receipt ID. The authenticated query re-reads the durable receipt and verifies kind and conversation before exposing its committed ID to the renderer. The browser clears a pending draft only when that ID matches the recorded submit. Failed/refused/unknown transport retains text; no automatic resubmit occurs. A forged URL or local record cannot assert success or create execution authority.

## Delivery and limits

No application schema, Schway integration, external adapter or authority policy changes. The navigation preference works without script. Local draft recovery is progressive enhancement; no-script command forms and refused-post draft retention remain complete. Draft announcements disclose local scope and lifetime. Device-specific storage clearing and actual browser accessibility remain separately labelled evidence, not inferred from deterministic tests.

The Plain design is recorded in docs/design/S14-plain-experience.md. Tests exercise the real shipped asset with fake storage/clocks, and authenticated handler tests cover preference cookies, deep links, receipt validation and unchanged authority.
