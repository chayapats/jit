# S16 installation search

SPACE16-01 (#428), primary-owned implementation of the existing
[experience handoff](S16-rakazo-experience.md), with organization cues from R03
and memory/source distinctions from R06 in the retained
[Mobbin research](S16-mobbin-research.md). No new broad design research, imported
assets or competing backend is used.

Search is a dedicated `/s16/search` page, entered from navigation or Ctrl/Cmd+K.
The initial field receives focus; Enter submits the current phrase and filters.
The page presents type, Bot, exact label and inclusive UTC date filters above
current result count and a compact list. Each result identifies its type,
producer if known, time, title, bounded snippet and labels. Opening a source is
separate from editing labels. Results remain untrusted escaped React text.

Desktop uses a three-column filter grid inside the existing rail/main shell;
mobile uses two columns, retaining the existing Chats/Needs you/Work/More bottom
navigation. The page has no fixed-width result content or horizontal scrolling.
Existing theme variables supply light/dark colors and visible keyboard focus.

Search results are fresh pages, not an accumulated snippet cache. Previous/Next
retain only opaque cursor positions; revisiting a page reacquires current data.
Loading removes earlier results. Empty results explain the current-access
boundary. Errors withhold results and expose a safe code in Details. Session
loss removes the whole projection. Offline/hidden visibility withholds content;
returning online/visible performs a fresh read. Refresh is explicit on the page.

Edit labels opens a form under the selected result. A one-label-per-line field
replaces at most eight labels against the exact current revision; empty removes
them. The explanatory copy says labels organize and do not share or start work.
Conflict requires refresh/review. A lost mutation response retains the original
command and offers read-back; only a conclusive missing receipt offers retry of
that same command. A comma inside a label remains part of the label. The exact
pending command survives view remounts in App RAM while private results are
withheld offline; reconnect with a different authenticated binding clears it.
No automatic replacement mutation is generated.

Source opening resolves the original object again, then enters its existing
protected destination. Old history outside the 32-row thread is fetched with the
same snapshot refresh, shown under its original request identity and focused.
An unavailable source replaces results with a revalidation message; a cursor or
label is never used as a file download, approval or execution handle.

Real Chromium tests exercise English at 1440px and Thai at 390px, Enter and
Ctrl+K, label response loss across service restart, oldest history navigation,
forget/withdrawal and empty states. Screenshots and installation-specific logs
stay in ignored `.local`; public evidence contains only commands, outcomes and
immutable revisions. Real host/device/account acceptance remains separately
owned by #431/#432.
