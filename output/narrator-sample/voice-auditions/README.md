# Narrator voice auditions

The three `*-design-preview.mp3` files are Google's automatically generated samples for three prompted voices made with `gemini-3.8-flash-tts`. The associated WAV files are the original previews. Each sample uses a different passage, so these are preliminary tests of voice and accent, not a controlled comparison of the requested episode excerpt.

- `survivor`: grounded, mature and subtly weathered.
- `investigator`: clear, measured and quietly curious.
- `storyteller`: warm, intimate and conversational.

`audition-script.txt` contains the common Indonesian passage for a fair comparison. `voices.json` records the generated voice IDs, their descriptions and the index of the key whose Google project owns them; it contains no API keys. The primary project's TTS quota was exhausted on 2026-11-19 before the common-passage MP3s could be produced. After the quota resets, run `./output/narrator-sample/voice-auditions/generate-auditions.ps1` from the ShortZ repository root. The script preserves existing files and can be rerun after a quota interruption. A produced MP3 may still need listening review even when automatic verification passes.
