# 01 — Goals & Scope

## The problem

Posting short videos on TikTok from desktop sources is slow:

- Most source clips are **landscape 16:9** (screen recordings, YouTube downloads, camera BTS footage). TikTok wants **9:16 portrait**.
- Raw clips have **no hook text**, and TikTok videos without an on-screen hook perform badly.
- Doing this in CapCut / Premiere every time means: new project, set canvas, position clip, pick font, type text, position text, check safe zones, export, wait. That is 10–20 repetitive minutes per video for what is really **the same 6 operations every time**.
- Existing tools are either too heavy (Premiere), too manual (CapCut), or cloud SaaS (upload your footage to someone else's server).

## The goal

Build a local desktop app where the loop is:

```
drop clip → pick template → type hook → check preview → export → post
```

**Time budget: under 2 minutes from drop to finished MP4** (excluding render time, which should be roughly real-time or faster on this machine).

The output must be **TikTok-ready**: 1080×1920, H.264/AAC, correct safe zones, no re-encoding needed by the platform.

## Product goals

| # | Goal | Measure |
|---|------|---------|
| G1 | Template-based transform: raw clip → styled vertical video | Template 1 shipped, JSON-driven |
| G2 | Speed: one screen, no timeline, sensible defaults | ≤ 2 min human time per video |
| G3 | WYSIWYG preview that matches the final render | Preview and export use same layout math + same fonts |
| G4 | Deterministic, high-quality render via FFmpeg | Same inputs → byte-similar outputs; CRF 18 quality |
| G5 | Extensible template library | Adding a template = adding a JSON file, no recompile |
| G6 | Runs fully offline, zero accounts, zero telemetry | No *unprompted* network. The optional Downloader feature (`twitter-downloader/01-goals.md` §G6′) is the sole, explicitly user-triggered exception |
| G7 | Never blocks the UI | Renders run in child processes, cancel any time |

## Non-goals (MVP — deliberately out of scope)

- **No multi-track timeline editing.** If a project needs frame-level editing, it belongs in CapCut. ShortZ handles the 90% case: one clip, styled.
- **No direct TikTok upload.** The TikTok Content Posting API requires an approved developer app and is unreliable for personal accounts. MVP = export file + "open output folder" button. (Revisit in phase 3, see `technical/future-extensions.md`.)
- **No cloud, no sync, no collaboration.** Local files only.
- **No mobile app.** Windows desktop first (the source clips live here).
- **No AI generation of video content.** (AI *text suggestions* are a possible later addition.)
- **No fancy motion graphics in v1.** Static layouts + simple fades. Animations are phase 2+.

## User stories

### US1 — The daily repost (primary)
> As a poster, I drop a 16:9 clip I downloaded, pick "Hook Letterbox", paste a hook line I wrote, and export a 9:16 video with the clip framed and the hook on top — in under 2 minutes.

### US2 — Trim the boring part
> As a poster, I set start/end trim points on the clip before exporting, so the video starts on the action.

### US3 — Audio control
> As a poster, I can mute the original audio (or keep it) — for reposts where I will add TikTok's native sound instead.

### US4 — Safe zones, visible
> As a poster, I toggle a TikTok UI overlay in the preview so I can see that my text avoids the username/caption area and the right-side button rail.

### US5 — Re-run with a different hook
> As a poster, I reopen last week's project, change only the text, and re-export. The project remembers the clip, template, and settings.

### US6 — New template without code
> As a tinkerer, I copy a template JSON into `templates/user/`, tweak positions/colors, restart, and the new template appears in the picker.

## MVP definition (v0.1)

**Must have:**
1. Import one video file (drag & drop or file picker), auto-probe duration/resolution/fps/codecs.
2. Template 1 "Hook Letterbox" (see `04-templates.md`), fully JSON-driven.
3. Text input for the hook with live preview, shrink-to-fit up to 4 lines.
4. Trim (start/end) with preview scrub.
5. Audio: keep / mute.
6. Export → MP4 1080×1920, H.264 CRF 18, AAC, `+faststart`, into a chosen output folder, with progress bar and cancel.
7. "Open output folder" after export.
8. Projects saved/restored (see `technical/data-storage.md`).

**Nice to have in v0.1** (cut if slow): safe-zone overlay toggle, recent-projects list, output filename pattern.

**Explicitly not in v0.1:** captions, music, batch, multi-clip, animations, upload.

## Acceptance tests (MVP)

- A1: Drop `air-17oct2026.mp4` (or any 16:9 H.264 clip) → export → resulting file is 1080×1920, plays in Windows Media Player, uploads to TikTok web without "unsupported format".
- A2: The exported frame at t=2s looks like the preview at t=2s (same text position/size/color, same video placement) within ~2px tolerance.
- A3: A 30s 1080p clip renders in ≤ 30s on the dev machine.
- A4: Cancel during render leaves no locked files, no zombie ffmpeg.exe in Task Manager.
- A5: Kill the app mid-render → relaunch → app works, temp files cleaned.
- A6: Move a source clip to another folder → reopening the project shows a clear "source missing, re-link?" message, not a crash.
