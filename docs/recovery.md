# Automatic local recovery snapshots

Recovery snapshots protect a long session against an accidental reload, tab
crash or browser restart. They are complete native world Saves kept in this
browser profile only. There is no cloud sync, and capture never restores,
pauses, steps or reseeds the world. Explicit recovery after reload is a
separate, later feature; until then, use **Save world** or a checkpoint to
bring a world back.

## Turning it on

Open **Automatic recovery snapshots** and tick **Capture automatic recovery
snapshots**. Capture is off by default. The choice is remembered in this
browser profile (local storage key `evolab-recovery-capture`). If local
storage is blocked, the switch still works for the current page and says so.
Turning it off keeps any stored snapshots.

## When a snapshot is taken

- The page counts **foreground activity**: time while the tab is visible.
  Hidden or minimised time does not count.
- After 60 seconds of foreground activity, the page requests one snapshot if
  the accepted world changed since the last stored one. A change is a new
  completed tick or any accepted world edit (paint, walls, placement,
  settings, interventions).
- The request is an ordinary complete Save, served by the worker between
  ticks. It reads the world; it never consumes random numbers or advances
  time. Worlds continue identically with capture on or off.
- If the worker, controls or recovery storage are busy, the capture is
  **skipped, not queued**, and the page tries again at its next one-second
  check. At most one capture is in flight.
- Nothing is written on `unload` or `beforeunload`. A reload loses at most the
  activity since the last stored snapshot.

## What is stored

Database `evolab-world-recovery` (version 1, one `entries` store) is
separate from the five manual checkpoint slots in `evolab-world-checkpoints`.
Recovery never opens, counts, overwrites or migrates those slots.

The store holds at most three keys:

| Key     | Content                                       |
| ------- | --------------------------------------------- |
| `1`     | Recovery snapshot record, or empty            |
| `2`     | Recovery snapshot record, or empty            |
| `lease` | Capture ownership: owner, generation, renewal |

Each snapshot record (format `evolab-recovery`, version 1) contains:

| Field          | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `owner`        | Random identity of the capturing page, at most 64 characters   |
| `generation`   | Capture generation: owner plus a per-world counter             |
| `sequence`     | Increasing capture number within that page                     |
| `savedAt`      | Save time in milliseconds since the epoch                      |
| `tick`, `seed` | Completed tick and world seed, read from the Save              |
| `worldVersion` | World file format version of the Save                          |
| `rulesVersion` | Experiment rules version of the build that captured it         |
| `world`        | The complete native Save text, at most 2.5 MB (UTF-8)          |

A record is at most 15 MB of escaped text plus 1 KB of metadata. The world
text is the same Save as **Save world**, limited by the same 2.5 MB bound; an
oversized world is reported and nothing is stored.

## Atomic replacement

Every capture is one IndexedDB read-write transaction. It reads both slots and
the lease, checks ownership and staleness, writes the new record into an
empty slot (otherwise over the oldest replaceable one) and renews the lease.
The previous record is only gone if the whole transaction commits. A quota
error, abort, crash or storage failure keeps both earlier slots unchanged; the
status line says so and the next interval retries.

## Ownership across tabs

- **One tab captures at a time.** The first committed capture claims the
  lease; each later capture renews it.
- Another tab's capture is refused while the lease was renewed less than
  150 seconds (2.5 capture intervals) ago. The refused tab reports
  "Another EvoLab tab owns automatic recovery" and keeps running.
- A lease older than 150 seconds is abandoned (the owner closed, crashed or
  was hidden) and the next foreground tab takes over in its own transaction.
  A lease dated more than 150 seconds in the future is also treated as
  abandoned, so a changed clock cannot lock capture forever.
- Within one tab, a completion whose sequence is not newer than a stored
  record from the same page is rejected, and a completion for a world that was
  reset, imported or restored in the meantime is discarded before storage.
  An earlier owner's late completion is rejected once another tab holds the
  lease.
- A reload is a new page identity. Its first capture waits until the previous
  page's lease lapses, which keeps the pre-reload snapshots for at least
  150 seconds.

Reset, import and checkpoint restore start a **new
capture generation**, so later snapshots of the new world never claim to
continue the old one.

## Unsupported and damaged data

- Records with another format or version, values that are not text, and
  values over the size bound are **preserved read-only**. They are never
  replaced or deleted. If both slots hold such records, capture reports that
  nothing was saved.
- An unknown lease, an unknown key or a newer database version leaves the
  store untouched and pauses capture with a status message.
- A damaged version-1 record is reported and may be replaced by the next
  capture.
- Blocked, unavailable or full storage reports a bounded status. The world
  keeps running and capture retries on later intervals.

## Limitations

Browser clearing, private windows and storage eviction can remove recovery
snapshots. They are not a backup: download worlds you want to keep. This is
artificial life, not a calibrated biological model.
