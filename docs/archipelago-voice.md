# Archipelago voice

Archipelago is a Google Cloud designed voice for Indonesian historical and geological documentaries, synthesized with **Gemini 3.8 Flash TTS** through Agent Platform. Speech plays a local preview from the selected audition and generates with the same identity.

- Cloud project number: `241089263319` (the voice is available only in its owning project).
- Voice ID: `voice_6eca01c6-096f-4dcc-844b-bf11ebd10b55`; CLI alias: `archipelago` with `--provider gemini-cloud`.
- Language: Indonesian (`id-ID`); model: `gemini-3.8-flash-tts`; location: `global`.
- Created: 2026-11-25 UTC.
- Voice-design prompt: “An Indonesian male archival researcher in his late thirties to forties with an intimate, close-mic mid-low voice and a touch of mature texture. His natural Bahasa Indonesia is precise and conversational, with a thoughtful, curious presence and comfortable flowing cadence.”
- Preview: `resources/tts/archipelago-preview.mp3`.

The voice is project-scoped. Voice design is nondeterministic, so the prompt cannot guarantee recreating the same identity. Google documents a one-year retention period after a stored voice's last use; generating speech or remixing the voice resets it. See [Google voice design](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/text-to-speech/voice-design).

## Delivery styles

- `hook`: Intriguing, warm, composed Indonesian documentary narrator with quiet urgency and curiosity.
- `tactical`: Clear, grounded, engaging Indonesian historical-geological documentary narrator, steady natural pacing.
- `twist`: Measured, reflective, slightly hushed Indonesian documentary reveal with weight and wonder.

These styles apply to this voice ID; Investigator retains its own existing styles. Delivery tags also control existing pauses and level shaping in the narration pipeline.

## Setup and use

Use the same Google Cloud project, billing and Application Default Credentials setup described in [Investigator voice and setup](investigator-voice.md). Select Archipelago in Speech, or run:

```powershell
pnpm cli tts --provider gemini-cloud --voice archipelago --text-file path/to/narasi.txt --output path/to/narration.mp3
```

Generation sends the script to Google and can incur charges. The output includes an MP3, a verification report and timestamps; local preview does not call the API. Keep credentials out of Git and this document.
