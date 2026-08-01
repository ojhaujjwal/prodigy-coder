# Local Wayfinder Tracker

This repository has no connected issue-tracker integration, so Wayfinder uses this directory as its local Markdown tracker.

- The canonical map is [`map.md`](./map.md).
- Open child tickets live in [`tickets/`](./tickets/).
- Ticket identity is the filename and title.
- `status: open` or `status: closed` records lifecycle.
- `type: wayfinder:<type>` records the ticket type.
- `parent` points to the map.
- `blocked_by` lists ticket filenames; this is the local fallback for native tracker dependencies.
- Add `assignee` to claim an open ticket before working on it.
- A resolved ticket should gain a `## Resolution` section, a resolution date, and `status: closed`.
- The map’s `Decisions so far` section should link only to closed tickets; open tickets are discovered from the ticket directory.
