# ShortZ

A small local desktop app that turns a raw clip into a ready-to-post TikTok video in about a minute: drop a landscape video, pick a template, type a hook, export a 1080×1920 MP4. **Templates, not timelines** — no CapCut, no accounts, no cloud.

The complete, audited plan (architecture, template schema, render pipeline, UI spec) lives in **[docs/README.md](docs/README.md)** — that is the real documentation; this file is only the dev quickstart.

## Dev quickstart (Windows)

```powershell
pnpm install
pnpm dev          # Electron app with HMR (dark shell: Home + Editor)
pnpm test:ui      # UI end-to-end suite (spawns its own pnpm dev via CDP)
pnpm test         # engine unit/integration suites (vitest)
pnpm typecheck    # tsc across all tier configs
pnpm dist         # NSIS installer + portable exe into dist/
```

Notes:

- To launch from the Windows taskbar, run `run.bat` once, then right-click the ShortZ taskbar icon and choose **Pin to taskbar**. The pin starts the same development app through `run.bat`, including its Vite server. Existing pins that opened Electron's welcome screen are repaired when ShortZ starts; if Windows still shows the old Electron label or icon, unpin it and pin the ShortZ window again.
- `pnpm dist` on a machine without symlink privileges (no Developer Mode/admin) needs the winCodeSign cache pre-populated once (a known electron-builder Windows quirk; a machine with Developer Mode enabled needs nothing).
- Portable mode: drop a `portable.flag` file next to `ShortZ.exe` → data moves to `.\data\` next to the exe instead of `%APPDATA%\shortz`.
- The E2E suite kills running `electron.exe`/`ShortZ.exe` instances first — dev and packaged builds share the single-instance lock.

**Status:** end-to-end functional — import → edit → preview (shared layout engine) → export/batch render through FFmpeg, plus a headless render CLI (`pnpm cli render project.json`).

The Downloader accepts X post links and public Instagram post links, including Instagram photos and videos in carousels. Each Instagram post's files are grouped in a folder named for its shortcode, within the selected download layout. Instagram lookups use the third-party OGInstagram service, which receives the post link and your IP address; availability depends on that service and Instagram. Private or login-required posts are not supported.

Use **Compress video** on the home screen to create a smaller H.264 MP4 next to a selected video. Choose a quality level; the original is kept and existing output files are never replaced. Results vary with the source, and an already compressed video may produce a larger file.

## Speech setup (Windows)

Speech uses the local [VoxCPM2](https://github.com/OpenBMB/VoxCPM) model. Install Python 3.10–3.12, then run these commands once in PowerShell. The CUDA wheel is for NVIDIA GPUs; for other hardware, install the appropriate PyTorch build following the [PyTorch instructions](https://pytorch.org/get-started/locally/).

```powershell
py -3.12 -m venv "$env:LOCALAPPDATA\ShortZ\voxcpm"
& "$env:LOCALAPPDATA\ShortZ\voxcpm\Scripts\python.exe" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
& "$env:LOCALAPPDATA\ShortZ\voxcpm\Scripts\python.exe" -m pip install voxcpm==2.0.3
```

The runtime and model require several gigabytes. The first preview or generation downloads model weights from Hugging Face and can take a while; later runs use the local cache. ShortZ keeps the model loaded for two minutes after a request and caches each designed reference voice, so subsequent generations are faster. The voices are AI-generated designs and pronunciation, accent, and consistency can vary. To use a different environment, set `SHORTZ_VOXCPM_PYTHON` to its Python executable before starting ShortZ. Run `pnpm exec tsx scripts/tts-smoke.ts` to test the installed model.
