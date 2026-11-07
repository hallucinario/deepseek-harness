---
kind: upgrade-guide
description: "Schedule catalogs now distinguish paused reminders from active and inactive reminders."
---

# Handle paused Schedule records

English | [中文](guide.zh.md)

## Change

Schedule catalog and domain records accept `status: paused` in addition to `active` and `inactive`. Consumers that assume only two statuses must handle paused records. Pausing suppresses future admission, preserving the ID, original Session and delivery history; it does not cancel an admitted inbox request or active turn. Resuming overdue recurring reminders skips elapsed occurrences and retains the configured time zone.

## Migration

1. Update exhaustive handling of `ScheduleCatalogEntry.status` to display `paused` separately and keep its history available. Use `schedule.setPaused({ id, sessionId, paused })` for admission changes.
2. Upgrade Schedule readers and writers together before using pause. Earlier readers do not accept the new durable status; do not reopen paused data with an older implementation. Existing active/inactive records require no conversion.
3. In the Schedule page, pause and resume a reminder; confirm the same ID and saved delivery records remain, and distinguish delivery from execution success.
