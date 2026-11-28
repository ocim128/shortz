# Archipelago (EN) voice

Archipelago (EN) is a Google Cloud designed voice for English historical and science documentaries — the English counterpart to [Archipelago](archipelago-voice.md), synthesized with **Gemini 3.8 Flash TTS** through Agent Platform. Speech plays a local preview from the selected audition and generates with the same identity.

- Cloud project number: `241089263319` (the voice is available only in its owning project).
- Voice ID: `voice_22553e13-388a-44ac-94a4-306a4833db3a`; CLI alias: `archipelago-en` with `--provider gemini-cloud`.
- Language: English (`en-US`), Whisper ASR language: `en`; model: `gemini-3.8-flash-tts`; location: `global`.
- Created: 2026-11-28 UTC (Audition Candidate A — Warm Archival Baritone).
- Voice-design prompt: “A male history and science documentary narrator in his late thirties to forties with a warm, intimate close-mic mid-low baritone and subtle mature vocal texture. He speaks clean, natural American English with lively pitch dynamics, expressive conversational phrasing, and a curious, thoughtful storytelling presence — never stiff like a news anchor or booming like a movie trailer.”
- Preview: `resources/tts/archipelago-en-preview.mp3`.

The voice is project-scoped. Voice design is nondeterministic, so the prompt cannot guarantee recreating the same identity. Google documents a one-year retention period after a stored voice's last use; generating speech or remixing the voice resets it. See [Google voice design](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/text-to-speech/voice-design).

## Delivery styles

- `hook`: Intriguing, composed, quietly urgent English documentary narrator with natural pitch dynamics and curiosity.
- `tactical`: Clear, grounded, engaging English historical-geological documentary narrator with expressive cadence and natural phrasing.
- `twist`: Measured, hushed, reflective English documentary reveal with emotional weight, deliberate pacing, and wonder.

These styles apply to this voice ID; Archipelago (`id-ID`) and Investigator retain their own existing styles and language settings. Delivery tags also control existing pauses and level shaping in the narration pipeline.

## Setup and use

Use the same Google Cloud project, billing and Application Default Credentials setup described in [Investigator voice and setup](investigator-voice.md). Select **Archipelago (EN)** in Speech, or run:

```powershell
pnpm cli tts --provider gemini-cloud --voice archipelago-en --text-file path/to/script.txt --output path/to/narration.mp3
```

Generation sends the script to Google and can incur charges. The output includes an MP3, a verification report, and English word-aligned timestamps; local preview does not call the API. Keep credentials out of Git and this document.
