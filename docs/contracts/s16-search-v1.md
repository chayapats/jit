# s16-client-search/v1

SPACE16-01 (#428), [ADR 0101](../adr/0101-s16-authorized-search-and-labels.md).
This is an authenticated owner projection, not model retrieval or a grant.

## Objects and visibility

Kinds are `history` (root CHAT request), `work` (WORK responsibility), `routine`,
`memory` (MEM claim), and `artifact` (committed immutable file). IDs are their
original owning IDs, never hashes of display text. Each result has a bounded
title/snippet, current state, timestamp, producer Bot if known, original source
destination and current label-set revision. History includes retained requests
beyond the 32-row thread/64-conversation navigation windows. Work includes both
CHAT tool work and separately assigned WORK responsibilities without pretending
one is the other.

Every read resolves current ownership, generation, original service guards,
file/claim/source withdrawals and MEM history suppression before projecting
content. A completed CHAT result whose publication is withheld is absent,
including its owner-message title. Non-published rows may expose only currently
safe owner ingress. Memory includes active/current claims only; erased/inactive
text and unavailable file pins cannot match. Artifacts use the exact existing
committed-library intersection and original download/preview guards.

The owner can inspect their own authorized private scopes; `bot` narrows
producer/history ownership, and MEM also intersects transitive Bot-private
scopes before matching. Filters and labels never supply a principal, source
release or execution authority. Source opening revalidates, even if the result
was visible earlier. Current owners retain their existing final I/O guards.

## Reads

`GET /api/s16/client/search` accepts each known key at most once:
`q` (well-formed text, <=256 UTF-16 units, no control characters), `kind`
(`all` or one object kind), optional `bot` (an ordinary <=128-character ID),
optional `label` (one exact owner label), optional inclusive millisecond `from`
and `to` (safe nonnegative integers), and `after` (opaque bounded cursor).
Unknown/malformed/duplicate filters refuse instead of broadening the search.

The fresh result is `{contract, query, items, total, limit, next, labels}`.
Page size is 25. Labels/counts contain only current objects inside the scope,
type and date filters. Query matching/ranking uses existing bounded English/
Thai lexical terms plus literal substring matching. Order is score descending,
timestamp descending, kind/ID ascending. Cursor version and filter digest bind
that complete order; the cursor contains no content and confers no authority.
Every page recomputes current visibility and totals. Concurrent changes may
change rank; pagination is a live view, not a frozen private snapshot.

Candidate capacity is 10,000 across all families; overflow returns
`search_capacity` (413), never partial results/counts. Searchable text is bounded
per owner record and response uses the existing client byte ceiling. No body,
query history or projection is written to an index, log or browser storage.

`GET /api/s16/client/search/objects/:kind/:id` resolves one current result and
its exact owning source destination again. Unavailable objects return
`search_object_unavailable` (409), with no prior title/snippet/labels. Opening
the destination uses its own protected read; artifacts do not gain a new byte
or preview endpoint.

## Label commands and recovery

`POST /api/s16/client/search/labels` receives exactly
`{contract:"s16-search-labels/v1",requestId,target:{kind,id},revision,labels}`.
The target must currently be readable. Revision starts at 0 for an unlabelled
object. The exact current revision is required and advances once. Labels are
NFKC-normalized, trimmed, nonempty, distinct, <=48 code points/192 UTF-8 bytes,
without control characters; at most eight per object and 128 distinct currently
retained labels per owner/generation. A command does not rename another object.
Replacing `Research` with `Ready` is a label move, not a source move.

Commands authenticate owner/session/CSRF again after the body and inside the
CHAT transaction. Each owner/generation/request identity binds the entire exact
command; changed bytes conflict. Return the original applied revision plus the
current target label set. `GET /api/s16/client/search/commands/:requestId`
recovers that original command, checks current target visibility and returns no
cached object content. A missing identity returns 404. Never convert an unknown
label mutation into a new command automatically. Source withdrawal also blocks
command recovery; it does not erase the owner's source or execute anything.

Additive tables hold at most 10,000 object label sets and 10,000 command
receipts; capacity refuses new admissions without evicting unknown receipts.
No new composition journal or format stamp is needed. Old releases may ignore
organization, while source/file/skill authority stamps remain effective.

## Evidence obligations

Exercise actual protected HTTP/client composition, no model-only proof: all
five families; scope before ranking/counts/facets; correction/forget/file and
policy withdrawal; stale cursor/open/download; oldest retained history; label
conflict, response loss and original identity after restart; model/computer
change; exact lineage/authority equality before and after organization; strict
Host/Origin/session/CSRF; real rendered English/Thai keyboard/mobile states.
