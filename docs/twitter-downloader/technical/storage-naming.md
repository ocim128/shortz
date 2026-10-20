# Technical — Storage & Naming (paths, sidecars, state)

Port of xdl `storage/{naming,sidecar,state}.py` + `DECISIONS.md` #13–17, adapted to ShortZ's data-dir conventions.

## 1. Data layout

```
<Videos>\ShortZ\Downloads\            ← settings.downloads.dir (default; user-configurable)
└─ x\                                 ← fixed marker segment (keeps other tools' files out)
   ├─ <author>\                       ← layout "by-author" (default)
   │  ├─ 1750123456789012352.mp4
   │  ├─ 1750123456789012352.mp4.meta.json
   │  ├─ 1750123456789012352_v2.mp4
   │  └─ 1750123456789012352_v2.mp4.meta.json
   └─ …
%APPDATA%\shortz\
├─ downloads\state.json               ← the index (skip/retry/history)
└─ downloads\cache\posters\<id>_<n>.jpg   ← poster cache for the UI (served via media://)
```

- **Media lives with the user's videos, state lives with the app** — media is content (drag it anywhere), state is bookkeeping. Portable mode: state follows `.\data\`, media default stays in Videos unless the user points it at the portable root.
- The `x\` segment is fixed (not a layout choice): it namespaces the feature inside a folder the user may share with other tools.

## 2. Deterministic naming (the foundation of skip/resume/idempotence)

`renderPath(root, tweet, mediaIndex, opts)` is **pure** (in `src/shared/downloader/naming.ts`): the same post always maps to the same path — re-runs, skip checks and resume all depend on it, and the renderer shows the planned path *before* download using the same function the core will execute.

**Filename template** (settings, default `{id}`):

| Variable | Value |
|---|---|
| `{id}` | the tweet id from the URL (the canonical key) |
| `{date}` | post creation date, **local tz**, `yyyy-MM-dd` |
| `{author}` | `screen_name` from the resolved post |
| `{index}` | 1-based media position |
| `{slug}` | caption → lowercase, `[^a-z0-9-]+ → '-'`, collapsed, stripped, ≤ 30 chars |

- Multi-video: index ≥ 2 appends `_v{index}` (`<id>_v2.mp4`) — the 95% single-video case keeps a clean name (xdl D13).
- Layouts: `by-author` → `x/<author>/`; `by-date` → `x/<yyyy>/<mm>/`; `flat` → `x/`. Switching layout does **not** invalidate state: skip reads the stored `file_path`, so old and new names coexist (xdl D13).
- `{date}` uses the *post's* date, not the download date — a batch downloaded today stays grouped by when it was posted.

**Windows-safe sanitizer** (applied to every segment, port of `sanitize_segment`):

1. NFC normalize.
2. Forbidden chars `< > : " / \ | ? *` → `_`; control chars (0x00–0x1F) → `_`.
3. Strip trailing spaces and dots (invalid on NTFS).
4. Reserved device names (`CON PRN AUX NUL COM1-9 LPT1-9`) → prefix `_`.
5. Cap segments at 120 chars (leaves headroom inside 255-byte names and MAX_PATH with the long-path prefix), truncating on a char boundary **without leaving a lone surrogate**, then re-strip ` .`.
6. Empty result → `_`.
7. Slugs are additionally lowercased ASCII-classed (see `{slug}` above) — captions with emoji/CJK degrade to `-` runs that collapse away.

Hostile-input rule: the caption and author name flow **only** through these functions — a caption containing `..\..\evil`, `CON`, or a 400-character emoji run cannot escape the configured root or break a path.

## 3. Sidecar — `<name>.mp4.meta.json`

One per media file (each `_v2.mp4` is self-describing). Atomic write (`*.meta.json.part` → rename). Schema (superset of xdl's, `shortz_version` added):

```json
{
  "schemaVersion": 1,
  "tweetId": "1750123456789012352",
  "url": "https://x.com/someuser/status/1750123456789012352",
  "text": "caption text, exactly as resolved",
  "createdAt": "2024-01-31T12:34:56.000Z",
  "author": { "screenName": "someuser", "displayName": "Some User", "verified": false },
  "media": [{
    "index": 1,
    "kind": "video",
    "file": "1750123456789012352.mp4",
    "width": 1280, "height": 720,
    "bitrate": 832000,
    "contentType": "video/mp4",
    "sourceVariantUrl": "https://video.twimg.com/…/pl/…mp4?tag=12",
    "sizeBytes": 4211223,
    "posterUrl": "https://pbs.twimg.com/…/…jpg"
  }],
  "source": "syndication",
  "downloadedAt": "2026-10-20T19:02:11Z",
  "shortzVersion": "0.1.0"
}
```

Purpose: the file is self-documenting outside the app (caption, origin, provenance) and the recovery path reads it ("file + sidecar present, no state row" → re-finalize). Write order for crash safety lives in the orchestrator: **media rename → sidecar → state row** — a state row never points at a file that does not exist.

## 4. State index — `<dataDir>\downloads\state.json`

Single JSON document, schema v1 (port of the SQLite tables, one file instead):

```json
{
  "schemaVersion": 1,
  "tweets": {
    "1750123456789012352": {
      "author": "someuser",
      "mediaCount": 2,
      "firstSeen": "2026-10-20T19:01:02Z"
    }
  },
  "downloads": {
    "1750123456789012352:1": {
      "filePath": "C:\\Users\\user\\Videos\\ShortZ\\Downloads\\x\\someuser\\1750123456789012352.mp4",
      "sizeBytes": 4211223,
      "status": "ok",
      "error": null,
      "source": "syndication",
      "batchId": "01JD7…",
      "downloadedAt": "2026-10-20T19:02:11Z",
      "updatedAt": "2026-10-20T19:02:11Z"
    },
    "1750123456789012352:2": { "status": "failed", "error": "NETWORK: connection reset", "…": "…" }
  }
}
```

Rules ported from xdl with the JSON idioms added:

- **`tweets.mediaCount` counts downloadable media (video/gif) only**; the tweet row is written only after `select()` succeeds (a photo-only post must never anchor `mediaCount = 0` — that made every re-run a false skip in xdl's audit).
- **Completeness** = `count(ok downloads for id) === mediaCount` **and** every `filePath` stats as a file. Not "any row exists" — a multi-video post with one failed video is *incomplete*, its ok rows do not skip (xdl audit round 2).
- **Skip** on re-run: complete per the rule above → item `skipped`, no network. `force: true` bypasses.
- **`retry-failed`**: enqueue only rows whose last status is `failed`/`incomplete` (or items of incomplete tweets).
- **Convert/suffix anchoring** (xdl D15, future-proofing): an `.mp4` ok-row must not anchor a different-output run (e.g. a future GIF-conversion mode); mode changes for a completed tweet require `force`. Same rule will guard any new output kind.
- **Flush discipline**: mutations at item boundaries (tweet row, media row, verdict) flush the whole doc atomically (`fs-utils` temp+rename with EPERM retry) — a few writes per item, ~ms each; the single-flight slot guarantees one writer.
- **Crash windows are free**: state loss at worst re-does a rename/sidecar on next run (re-finalize); it cannot corrupt media.
- **Corrupt file**: quarantined as `state.corrupt-<ts>.json`, store rebuilt empty; files on disk are reconciled by re-resolve + re-finalize (no re-download).

**Upgrade path** (when > ~50 k rows or visible flush stalls): swap `StateStore` for `better-sqlite3` behind the same interface — the schema above maps 1:1 to xdl's three tables. Nothing else in the app changes.

## 5. Poster cache

`downloads\cache\posters\<tweetId>_<mediaIndex>.jpg` — fetched by the core during resolve (best-effort; failure never blocks), served to the renderer via `media://` like project thumbnails. Rationale: the renderer performs zero remote I/O; posters must also survive offline later (they are UI state, not content).

## 6. What the state does **not** do

- No render/export coupling: projects reference files by path; deleting a download leaves projects to surface their normal "missing source" banner (already built).
- No sync/backup logic: the state file is disposable by design (rebuild paths exist).
- No global history beyond the feature: the Home "recent projects" list stays project-based.
