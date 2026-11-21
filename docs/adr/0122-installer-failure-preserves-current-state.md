---
status: implemented installer preservation; aggregate OPS16 acceptance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Preserve current state when installation fails

The S15 installer previously treated a missing composition manifest as proof
that an initialization had no owner or work. It moved that directory aside and
initialized an empty replacement. It also recursively deleted newly initialized
state after a failed fresh installation. Neither observation proves that the
directory contains no current authority, withdrawal, usage or unknown-effect
facts. A failed health check can follow successful application writes.

Select conservative preservation instead of automatic abandonment. Before host
or configuration changes, refuse an existing state directory without its regular
composition manifest or original valid configuration. Refuse missing state when
an installed unit, release selector or installer receipt indicates an existing
installation. Keep all original bytes in place. Do not infer ownerlessness from a
missing marker, move state aside, or initialize a replacement from a backup.

Recheck the original state directory's identity and required marker immediately
before initialization. If an absent directory appeared, an existing directory
disappeared or its identity changed, refuse rather than adopting or replacing it.
Normal fresh initialization still runs only for the originally absent directory.

On failure, remove only the installer's new service wiring as before; retain any
initialized state and configuration. A rerun can attach to complete retained
state. Partial initialization with no composition manifest requires diagnosis
against current independent authority and refuses automatic reinitialization.
Uninstall continues to retain state, credentials, VM disks and configuration.

The simpler alternative, deleting or renaming a directory according to which
installer step failed, cannot prove the absence of durable application facts.
An independently receipted abandonment protocol would add authority and is not
introduced here. Marker presence is only a necessary installer precondition;
the owning runtime still validates its complete stores before admission.

Fake-root fault cases prove this installer's selection and preservation behavior,
not Linux deployment or compatible S16 service/client fallback. Existing legacy
manifest fallback does not certify selected S16 lifecycle acceptance. That
remaining proof must preserve all current formats and refuse incompatible
readers without restoring old authority.
