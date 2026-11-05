# Retained file selection and identity recovery

This refinement preserves the authored S16 rail, transcript, source chips, composer, notices and inspector.

1. A file-only message shows Received only after its durable receipt, without starting work from file contents.
2. Current authorized source chips offer **Use in next message** for the same conversation, including after reload. Selection adds one composer chip, deduplicates and focuses the prompt. It never sends or automatically selects prior files.
3. Removing a selected retained chip affects only the next message. **Withdraw** remains a separate source action with the existing impact explanation. Cancelling a new uncommitted upload still stops staging.
4. An uncertain send keeps its original request ID in the URL hash and existing notice. Reload restores only identity and queries that original before enabling replacement. It never reconstructs or automatically resends text/files/decisions.
5. A found request shows actual guarded state. Failed queries keep unknown and the existing recovery action. Only confirmed absence offers **Compose replacement**, which opens an empty composer for new explicit text/file selection and Send. An in-memory retained exact command can still offer its existing explicit same-ID retry after confirmed absence.
6. Preview/download authentication failure closes the inspector and immediately withholds every private projection, recent label, source/artifact, search term and conversation draft/chip. Suspend commands and focus the existing nonprivate authentication notice.
7. Reauthentication adopts only newly authorized projections. Late responses cannot restore private content, drafts or work. No new layout or product surface is introduced.

Copy keys: `s16.files.useNext`, `s16.files.removeFromMessage`, `s16.chat.originalNotFound`, `s16.chat.composeReplacement`, `s16.common.authenticationRequired`, with matching English/Thai dictionaries. Backend identity, policy, source integrity, byte custody and receipt/root validation remain separate implementation contracts.
