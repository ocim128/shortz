# Investigator voice

ShortZ's default Investigator is a Google Cloud designed voice, synthesized with **Gemini 3.8 Flash TTS** through Agent Platform. The Speech screen plays the matching local preview and uses this identity for generation.

- Cloud project number: `241089263319` (the voice is available only in its owning project).
- Voice ID: `voice_71a5a701-796e-421d-840e-0adc00b0816a`.
- Language: Indonesian (`id-ID`); model: `gemini-3.8-flash-tts`; location: `global`.
- Created: 2026-11-19 UTC.
- Voice-design prompt: “A mature Indonesian male investigator with a clear mid-low voice, measured authority and quiet curiosity, speaking natural Bahasa Indonesia with precise articulation.”
- Preview: `resources/tts/investigator-preview.mp3`.

The earlier AI Studio Investigator is `voice_486ejtx78ywn`. It is a different voice in another project; the Cloud Investigator was generated from the same description, not transferred or cloned. Voice design is nondeterministic: this description and the saved audio help audition a replacement, but cannot guarantee recreating the identical voice if Google deletes the stored identity. Google documents a one-year retention period after the last use for stored voices; generation or remixing resets it. See [Google voice design](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/text-to-speech/voice-design) and [voice retention](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/text-to-speech/overview#custom-voice-limits-and-ttl).

## Setup

1. Enable billing and the Agent Platform API in the owning Google Cloud project. Gemini generation is paid usage. Google says its $300 free-trial credit cannot pay for Gemini platform services if the trial was started or upgraded on or after November 16, 2026; check the [current trial terms](https://docs.cloud.google.com/free/docs/free-cloud-features).
2. Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) and sign in with `gcloud auth application-default login`. The account needs permission to use the model, such as the Vertex AI User role (`roles/aiplatform.user`). Service account Application Default Credentials also work.
3. Set `SHORTZ_GOOGLE_CLOUD_PROJECT=241089263319` in the project's `api.env` or `.env`, or in the process environment. For the packaged application, use ShortZ's user data directory for the configuration file.
4. Run `pnpm cli tts --provider gemini-cloud --text-file path/to/narasi.txt --output path/to/narration.mp3`, or select Investigator in Speech. The output includes a verification report and timestamps.

Keep credentials out of Git and never place API keys or credential JSON in this document. The voice ID and project number are identifiers, not credentials.
