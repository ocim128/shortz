"""Keep faster-whisper loaded and serve JSON-line transcription requests.

One request per line: {"id": <n>, "wav": <path>} -> {"id": <n>, "ok": true,
"transcript": str, "words": [{"word", "start", "end"}], "durationSec": float}
or {"id": <n>, "ok": false, "error": str}. Promoted from the verified repair
scripts in tmp/ (transcribe-voice.py, repair-verified.py): Indonesian,
beam_size 5, no VAD, word timestamps for caption timing.

Import failures are reported per-request (ok: false) instead of killing the
process, so the caller can surface a readable setup message.
"""
import json
import sys
import traceback

MODEL_SIZE = 'base'
CPU_THREADS = 4


def load_model():
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    from faster_whisper import WhisperModel

    model = WhisperModel(MODEL_SIZE, device='cpu', compute_type='int8', cpu_threads=CPU_THREADS)
    return np, sf, resample_poly, model


def transcribe(np, sf, resample_poly, model, wav_path):
    samples, rate = sf.read(wav_path, dtype='float32')
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    samples = resample_poly(samples, 16000, rate).astype(np.float32)
    segments, _ = model.transcribe(
        samples, language='id', beam_size=5, vad_filter=False,
        condition_on_previous_text=False, word_timestamps=True)
    words = []
    texts = []
    for segment in segments:
        text = (segment.text or '').strip()
        if text:
            texts.append(text)
        for word in (segment.words or []):
            token = (word.word or '').strip()
            if token:
                words.append({'word': token, 'start': round(word.start, 3),
                              'end': round(word.end, 3)})
    return {
        'transcript': ' '.join(texts).strip(),
        'words': words,
        'durationSec': round(len(samples) / 16000.0, 3),
    }


def main():
    np = sf = resample_poly = model = None
    load_error = None
    try:
        np, sf, resample_poly, model = load_model()
    except Exception:
        load_error = traceback.format_exc()[-2000:]

    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('id')
            if model is None:
                raise RuntimeError(
                    'The speech runtime is missing the verifier. Install it with: '
                    '"<ShortZ voxcpm python>" -m pip install faster-whisper\n' + (load_error or ''))
            result = transcribe(np, sf, resample_poly, model, request['wav'])
            response = {'id': request_id, 'ok': True, **result}
        except Exception:
            response = {'id': request_id, 'ok': False, 'error': traceback.format_exc()[-2000:]}
        print(json.dumps(response, ensure_ascii=True), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
