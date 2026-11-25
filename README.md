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

Speech defaults to the custom **Investigator** voice using Gemini online. The default narrator and the verified CLI pipeline require a local Python runtime with `faster-whisper` for verification. The other desktop voices use the local [VoxCPM2](https://github.com/OpenBMB/VoxCPM) model. To set up both, install Python 3.10–3.12, then run these commands once in PowerShell. The CUDA wheel is for NVIDIA GPUs; for other hardware, install the appropriate PyTorch build following the [PyTorch instructions](https://pytorch.org/get-started/locally/).

```powershell
py -3.12 -m venv "$env:LOCALAPPDATA\ShortZ\voxcpm"
& "$env:LOCALAPPDATA\ShortZ\voxcpm\Scripts\python.exe" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
& "$env:LOCALAPPDATA\ShortZ\voxcpm\Scripts\python.exe" -m pip install voxcpm==2.0.3 faster-whisper
```

The runtime and model require several gigabytes. The first preview or generation downloads model weights from Hugging Face and can take a while; later runs use the local cache. VoxCPM2 Ultimate Cloning requires one Indonesian WAV and its exact transcript. Set `SHORTZ_VOX_REFERENCE_WAV` to its path and `SHORTZ_VOX_REFERENCE_TEXT` to the exact words before starting ShortZ. The reference is denoised and cached, then supplied as both the prompt and reference for every generation. The reference determines the voice; preset descriptions cannot change its identity. Use a reference you are authorized to use. To use a different Python environment, set `SHORTZ_VOXCPM_PYTHON`. `faster-whisper` powers the CLI's per-chunk ASR verification. Run `pnpm exec tsx scripts/tts-smoke.ts` to test the installed model.

In Speech, Investigator is selected by default and its preview plays without an API request. Generation uses Gemini 3.8 Flash through Google Cloud Agent Platform, sends text to Google, and saves a verification report alongside the MP3; the screen flags failed verification. Set `SHORTZ_GOOGLE_CLOUD_PROJECT` to the voice's owning project in the repository's `api.env` or `.env`, and sign in with Google Application Default Credentials. In a packaged app, put that file in ShortZ's user data directory (normally `%APPDATA%\shortz`, or `SHORTZ_DATA_DIR` when set), or set the environment variable before starting the app. See [Investigator voice and setup](docs/investigator-voice.md). `SHORTZ_ASR_PYTHON` can point to a different Python executable with the verifier installed. Enter a file name to save in the configured output folder, or a full path to choose a specific folder and file name. Existing files are never overwritten.

Speech also offers **Archipelago**, a custom Indonesian documentary narrator with its own local preview and delivery styles. To use it from the CLI, select `--provider gemini-cloud --voice archipelago`. See [Archipelago voice](docs/archipelago-voice.md).

### Generate narration from the CLI

The CLI synthesizes up to three sentences per chunk, checks raw and conditioned audio with local speech recognition, retries up to three times, and masters the result toward −14 LUFS. Any normalized word mismatch or suspected truncated last word fails verification. Whisper can mishear correct audio and cannot guarantee pronunciation or accent; listen to the result. The CLI prints the finished file paths and measured loudness, and refuses to overwrite an existing output.

```powershell
pnpm cli tts --list-voices
pnpm cli tts --voice jejak --text-file "C:/path/to/narasi.txt" --output "C:/path/to/narasi.mp3"
pnpm cli tts --provider edge --list-voices
pnpm cli tts --provider edge --voice rimba --text-file "C:/path/to/narasi.txt" --output "C:/path/to/narasi.mp3"
pnpm cli tts --provider cloud --text-file "C:/path/to/narasi.txt" --output "C:/path/to/cloud.mp3"
pnpm cli tts --provider gemini-cloud --text-file "C:/path/to/narasi-tagged.txt" --output "C:/path/to/narration.mp3"
```

Embed delivery tags in the script to shape the episode's rhythm — each tag adjusts level, pacing (≤3% slow-down only, never a speed-up), and the silence around it, while the voice itself stays one consistent narrator:

- `[hook]` — +1.5 dB, tight 100 ms gaps, for the opening hook
- `[tactical]` — neutral level, 160–260 ms structured gaps, for numbered survival steps
- `[twist]` — −3 dB, subtle 0.97× pacing, 450 ms pre-reveal pause, for the final reveal

A tag applies from its position until the next tag or the end of the script. Silence gaps follow the script's own structure automatically.

Voice presets are specific to each provider. The default is `penjelajah` for VoxCPM and `rimba` for Edge; use `--provider edge --list-voices` to see the Edge presets. Edge uses an online speech service; verification still runs locally.

For `--provider cloud`, set `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in the environment. The model defaults to `eleven_multilingual_v2` and can be set with `ELEVENLABS_MODEL_ID`. Cloud synthesis sends the script to ElevenLabs and may incur usage charges; verification and mastering remain local. Cloud voice IDs can also be supplied using `--voice`.

The default `gemini-cloud` provider uses Google Cloud Application Default Credentials and `SHORTZ_GOOGLE_CLOUD_PROJECT`. Its default model is `gemini-3.8-flash-tts`, and Investigator is the project-scoped Cloud voice. Use `--model gemini-3.8-flash-lite-tts` to select Lite. Tagged delivery is sent as speech metadata; the script text is sent to Google. Gemini audio skips VoxCPM denoising and pacing, uses light EQ and loudness normalization, and receives a final Whisper alignment after stitching. Cloud usage can incur charges; see [Google pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing). `.env` and `api.env` are ignored by Git.

The optional `gemini-tts` provider uses Google AI Studio and `GEMINI_API_KEY`. Process environment variables take precedence over `.env`, which takes precedence over `api.env`. Its default designed voice is the earlier AI Studio Investigator, scoped to that voice's original project. `SHORTZ_TTS_PROVIDER` or an explicit `--provider` selects the provider.

Optionally set `GEMINI_API_KEY2` through `GEMINI_API_KEY7` in the same file. ShortZ tries another distinct key when Google returns HTTP 429 for a prebuilt voice; other errors are surfaced immediately. Keys from the same Google project share that project's quota. Completed Gemini synthesis attempts are cached under `.shortz-tts-cache` in the output folder so rerunning the same command after a quota error or cancellation resumes without regenerating them. The cache contains audio, is ignored by Git, and is removed when all final artifacts are published; delete it manually to discard interrupted work.

Gemini Voice Design IDs (`voice_...`) are also accepted with `--voice`. Designed voices belong to the project that created them, so ShortZ pins these requests to the first configured key instead of rotating across projects. To choose a different owning project, add `--gemini-key-index 2` (or another index up to `7`); the index refers to the ordered, nonempty keys in your configuration. Changing projects may change available quota, but a different project cannot use a voice it does not own.

Use `[sfx:knock]` for a non-spoken sound effect. The marker is stripped from synthesis and appears as a named time in the timestamps artifact; the pipeline does not generate or mix the effect. Repeated literal `Tok. Tok.` is also converted into a `knock` marker.

Each run writes two artifacts next to the MP3 (same stem):

- `<stem>-timestamps.json` — chunk and word timings on the final stitched audio, for caption sync
- `<stem>-report.json` — per-chunk QA (verification attempts, word/WPM scores, retries, failures) plus the measured `integratedLufs`, `loudnessRangeLu`, and estimated `noiseFloorDbfs` against their targets

Exit codes: `0` the narration passed verification · `1` usage or runtime error · `2` the audio was generated but at least one chunk failed verification — review `*-report.json` before using it. `--no-master` skips the mastering chain (for A/B comparisons); `--provider` selects the synthesis engine (voxcpm | edge) without changing the pipeline contract.
