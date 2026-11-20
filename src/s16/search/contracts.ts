/** Durable owning identity. A label or search result is never an authority handle. */
export interface SearchTarget { kind: SearchKind; id: string }
export type SearchKind = 'history' | 'work' | 'routine' | 'memory' | 'artifact';
/** Strict, live-view filters; an opaque cursor contains positions, never cached content. */
export interface SearchQuery { q: string; kind: 'all' | SearchKind; bot: string | null; label: string | null; from: number | null; to: number | null; after: string | null }
/** Guarded destination; clients still use its existing owning read before displaying content. */
export type SearchSource = { kind: 'chat'; conversationId: string; requestId: string } | { kind: 'routine' | 'memory' | 'artifact'; id: string };
export interface SearchLabels { revision: number; labels: string[] }
/** Public current projection. No full indexed body, credential, work grant or private cache is shipped. */
export interface SearchItem { target: SearchTarget; title: string; snippet: string; state: string; at: number; botId: string | null; source: SearchSource; organization: SearchLabels }
export interface SearchPage { contract: 's16-client-search/v1'; query: SearchQuery; items: SearchItem[]; total: number; limit: 25; next: string | null; labels: { name: string; count: number }[] }
/** Exact owner-only organization; replacing a label does not move or release its source. */
export interface SearchLabelCommand { contract: 's16-search-labels/v1'; requestId: string; target: SearchTarget; revision: number; labels: string[] }
export interface SearchLabelReceipt { contract: 's16-search-label-receipt/v1'; requestId: string; target: SearchTarget; appliedRevision: number; current: SearchLabels }
/** Protected transient owner projection, never persisted in the organization tables or a search index. */
export interface SearchDocument extends Omit<SearchItem, 'organization' | 'snippet'> { text: string; /** MEM checks the complete dependency scope for a selected Bot before returning true. */ visibleToBot?: (bot: string) => boolean }
