# Technical — Data & Storage

Local filesystem only. Two modes:

| Mode | Root data dir | How |
|---|---|---|
| Installed (default) | `%APPDATA%\shortz\` (e.g. `C:\Users\user\AppData\Roaming\shortz\`) | default |
| Portable | `.\data\` next to the exe | presence of `portable.flag` file next to exe |

Everything below is relative to the data dir.

## Folder layout

```
<data>/
  settings.json               # app settings (below)
  editor-configs/             # named editor configurations (below)
    <configId>.json           # configId = ULID
  projects/
    <projectId>\              # projectId = ULID
      project.json            # the project document (below)
      thumb.jpg               # 360px-wide source thumbnail (generated at import)
  templates/
    user\                     # user-authored template JSONs (picked up at startup)
      my-template.json
  cache/
    probes\                   # ffprobe results, key = sha1(path|size|mtime)
      <hash>.json
```

Output videos go to a **user-chosen** directory (default `%USERPROFILE%\Videos\ShortZ\`) — never inside the data dir, so users can point at Dropbox/obsidian-style folders if they want.

## Project document (`project.json`)

```jsonc
{
  "schemaVersion": 1,
  "id": "01J8GZ5X7Y…",            // ULID, matches folder name
  "name": "air-17oct2026",         // default = source filename w/o ext; editable
  "createdAt": "2026-10-18T09:12:00Z",
  "updatedAt": "2026-10-18T09:31:44Z",

  "source": {
    "path": "D:\\clips\\air-17oct2026.mp4",
    "probe": {                     // last known probe snapshot (re-validated on open)
      "width": 1920, "height": 1080, "fps": 30,
      "duration": 27.4, "hasAudio": true, "videoCodec": "h264"
    }
  },

  "templateId": "hook-letterbox",
  "values": {
    "fields": { "hook": "A wildlife photographer put a microphone beside a baby squirrel. These are its actual eating sounds." },
    "knobs": { "backgroundStyle": "black", "videoTop": 520, "videoCornerRadius": 24, "textAlign": "left" }
  },

  "trim": { "start": 3.2, "end": 21.0 },
  "audio": "keep",                  // 'keep' | 'mute'

  "exportHistory": [
    {
      "path": "C:\\Users\\user\\Videos\\ShortZ\\air-17oct2026_20261018_0935.mp4",
      "createdAt": "2026-10-18T09:35:12Z",
      "durationSec": 17.8, "sizeBytes": 19847211,
      "encoder": "libx264", "crf": 18
    }
  ]
}
```

Rules:

- **Source paths stored absolute.** No importing/copying media into the data dir in v1 (clips can be GBs). `sourceMissing` state handled in UI (re-link flow keeps values).
- Autosave: debounced 500ms after any change; **atomic write with Windows retry** — `write-file-atomic`, or tmp + `rename` wrapped in an EPERM/EEXIST retry loop (Windows rename over an existing or antivirus-scanned target can fail transiently).
- Deleting a project = move `projects/<id>/` to OS recycle bin if possible, else delete; exports on disk are untouched.

## `settings.json`

```jsonc
{
  "schemaVersion": 1,
  "output": {
    "dir": "C:\\Users\\user\\Videos\\ShortZ",
    "filenamePattern": "{name}_{yyyyMMdd}_{HHmm}"
  },
  "encoder": {
    "preferred": "auto",            // 'auto' | 'libx264' | 'h264_nvenc' | 'h264_amf' | 'h264_qsv'
    "crf": 18,
    "fps": 30                       // 30 | 60 | 'source'
  },
  "ffmpeg": { "source": "auto" },   // 'auto' | 'system' | 'bundled'
  "ui": { "safeZonesDefault": true, "lastProjectId": "01J8…" }
}
```

Unknown keys preserved on write (forward compatibility). Missing file = defaults.

## `editor-configs/`

The editor's **Save config / Load config** controls — named slots under a fixed folder, no file dialogs. Each config snapshots everything the user tweaks in the editor that is not tied to the clip, so a saved setup can be re-applied to any project (the everyday repost flow: same template, same knobs, new video).

```jsonc
// editor-configs/<configId>.json — the id lives in the filename only
{
  "id": "01J…",                              // matches the filename (written for readability)
  "schemaVersion": 1,
  "name": "squirrel reel",                   // display name, unique key (case-insensitive)
  "savedAt": "2026-10-18T15:42:01.000Z",     // stamped on save
  "templateId": "hook-letterbox",
  "values": {                                // same shape as project.json's values
    "fields": { "hook": "…" },
    "knobs": { "backgroundStyle": "black", "videoTop": 520 }
  },
  "trim": { "start": 3.2, "end": 21.0 },     // clamped to the target clip on load
  "audio": "keep"
}
```

Rules:

- Deliberately excludes everything clip/project-specific: source path, name, id, probe, export history.
- **Names are the unique key** (max 60 chars, compared case-insensitively): saving with an existing name updates that config in place; otherwise a new ULID file is minted. The list is newest-first.
- Load applies a config to the active project via the normal patch path, so autosave/dirty tracking just work.
- A corrupt file is skipped by the listing (the healthy configs stay usable) but fails its own load with a readable error — re-saving the same name replaces it. Missing folder = empty list.

## Global export log — deferred out of v0.1

An append-only global log (`exports.jsonl`: timestamp, projectId, templateId, output path, size, encoder — one line per render) is **cut from v0.1** (simplicity audit): per-project `exportHistory` already covers everything the UI shows. It returns in M4 together with the local analytics dashboard — see `technical/future-extensions.md` §7. Never sent anywhere.

## Caches & cleanup

| Cache | Invalidated when | Cleanup |
|---|---|---|
| `cache/probes/<hash>.json` | hash = path+size+mtime → auto | "Clear caches" in settings; also auto-prune > 500 entries (LRU) |
| `%TEMP%\shortz\<jobId>\` | per render job | deleted after render with EBUSY/EPERM retry (150/300/600 ms); startup sweep removes dirs older than 24h |

## Concurrency & integrity

- Single app instance enforced (Electron `requestSingleInstanceLock`); second launch focuses existing window and opens the passed project if argv had a file.
- All writes atomic (tmp+rename). A corrupted `project.json` → quarantined as `project.corrupt-<ts>.json` and surfaced in Home as a recoverable card (values lost but source path salvageable).
- No database in v1 — file count stays small (tens of projects). A SQLite (better-sqlite3) migration path is documented but only triggered if Home feels slow (> 200 projects).

## Backup / sync story (user-facing doc note)

The whole data dir is copy-safe while the app is closed. To move machines: copy `%APPDATA%\shortz` + re-link source clips. This will be written into the in-app About/Help page.
