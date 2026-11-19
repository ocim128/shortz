"""Keep VoxCPM loaded and serve one JSON-line synthesis request at a time."""
import contextlib
import json
import os
import re
import subprocess
import sys
import traceback
from pathlib import Path

DELIVERY_TAG_RE = re.compile(r'\[(?:hook|tactical|twist)\][ \t]*', re.IGNORECASE)


def strip_delivery_tags(text):
    """Tags control energy in the ShortZ pipeline; never speak them.

    The pipeline strips tags before sending, but an older still-running app
    instance could forward raw script text — the worker defends in depth.
    """
    return re.sub(r'[ \t]+', ' ', DELIVERY_TAG_RE.sub(' ', text)).strip()


def chunks(text, limit=120):
    """Keep paragraphs and sentences intact where they fit the model's limit."""
    result = []
    for paragraph in re.split(r'\n\s*\n+', text.strip()):
        current = ''
        sentences = re.split(r'(?<=[.!?…])\s+', paragraph.strip())
        for sentence in sentences:
            sentence = ' '.join(sentence.split())
            if not sentence:
                continue
            if len(sentence) <= limit:
                if current and len(current) + len(sentence) + 1 > limit:
                    result.append(current)
                    current = ''
                current = f'{current} {sentence}'.strip()
                continue
            if current:
                result.append(current)
                current = ''
            # A single long sentence has no safe sentence boundary; split it
            # at words, with a final fallback for exceptionally long words.
            for word in sentence.split():
                while len(word) > limit:
                    if current:
                        result.append(current)
                        current = ''
                    result.append(word[:limit])
                    word = word[limit:]
                if current and len(current) + len(word) + 1 > limit:
                    result.append(current)
                    current = ''
                current = f'{current} {word}'.strip()
            if current:
                result.append(current)
                current = ''
        if current:
            result.append(current)
    return result


def max_chunk_duration(text):
    """Allow slow narration while detecting excessively long model output."""
    return max(4.0, len(text) / 8.0 + 1.0)


class SpeechWorker:
    def __init__(self):
        self.model = None

    def load(self):
        if self.model is None:
            import numpy as np
            import soundfile as sf
            import torch
            from voxcpm import VoxCPM

            # torch.compile is not reliably available on Windows.
            self.model = VoxCPM.from_pretrained('openbmb/VoxCPM2', load_denoiser=False, optimize=False)
            self.np, self.sf, self.torch = np, sf, torch

    def synthesize(self, request):
        self.load()
        np, sf, torch, model = self.np, self.sf, self.torch, self.model
        sample_rate = model.tts_model.sample_rate
        text = strip_delivery_tags(request['text'])
        reference = Path(request['reference'])
        try:
            info = sf.info(str(reference))
            reference_valid = info.frames > 0 and info.samplerate == sample_rate
        except (OSError, RuntimeError):
            reference_valid = False

        if not reference_valid:
            reference_text = 'Malam itu hujan turun tanpa henti, dan kami harus mencari jalan pulang sebelum gelap.'
            torch.manual_seed(request['seed'])
            np.random.seed(request['seed'])
            with torch.inference_mode():
                voice = model.generate(text=f"({request['prompt']}){reference_text}",
                                       cfg_value=2.0, inference_timesteps=10)
            voice = np.asarray(voice, dtype=np.float32).reshape(-1)
            if not len(voice):
                raise RuntimeError('VoxCPM returned an empty reference voice')
            # Write next to the final file so interrupted writes never become cache hits.
            reference.parent.mkdir(parents=True, exist_ok=True)
            temporary = reference.with_name(f'.{reference.name}.{os.getpid()}.tmp.wav')
            denoised = reference.with_name(f'.{reference.name}.{os.getpid()}.denoised.wav')
            try:
                sf.write(str(temporary), voice, sample_rate)
                # Pre-clean the reference once so VoxCPM never clones room noise
                # or vocoder hiss into every chunk of the episode.
                ffmpeg_path = request.get('ffmpeg_path')
                if ffmpeg_path:
                    run = subprocess.run(
                        [ffmpeg_path, '-v', 'error', '-y', '-i', str(temporary),
                         '-af', 'afftdn=nf=-25,highpass=f=85',
                         '-ar', str(sample_rate), '-ac', '1', str(denoised)],
                        capture_output=True, text=True)
                    if run.returncode == 0 and denoised.exists() and denoised.stat().st_size > 44:
                        os.replace(denoised, temporary)
                    else:
                        print(f'Reference denoise skipped: {run.stderr[-300:]}', file=sys.stderr)
                os.replace(temporary, reference)
            finally:
                temporary.unlink(missing_ok=True)
                denoised.unlink(missing_ok=True)

        audio = []
        for index, part in enumerate(chunks(text)):
            wav = None
            for attempt in range(3):
                seed = request['seed'] + attempt * 101
                torch.manual_seed(seed)
                np.random.seed(seed)
                with torch.inference_mode():
                    candidate = np.asarray(model.generate(
                        text=f"({request['prompt']}){part}", reference_wav_path=str(reference),
                        cfg_value=2.0, inference_timesteps=10), dtype=np.float32).reshape(-1)
                if (len(candidate) > 0 and np.isfinite(candidate).all()
                        and np.any(np.abs(candidate) > 0.0001)
                        and len(candidate) / sample_rate <= max_chunk_duration(part)):
                    wav = candidate
                    break
                print(f'VoxCPM produced unusual audio for section {index + 1}; retrying.', file=sys.stderr)
            if wav is None:
                raise RuntimeError(f'Could not generate a clear speech section: {part[:100]}')
            if index:
                audio.append(np.zeros(int(sample_rate * 0.22), dtype=np.float32))
            audio.append(wav)
        sf.write(request['output'], np.concatenate(audio), sample_rate)


def main():
    worker = SpeechWorker()
    protocol = sys.stdout
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            # Older ShortZ instances send one request without an ID and wait
            # for process exit. Keep them working when this file is updated
            # while the desktop app is still running.
            if 'id' not in request:
                request.setdefault('reference', str(Path(request['output']).with_name('reference.wav')))
                try:
                    with contextlib.redirect_stdout(sys.stderr):
                        worker.synthesize(request)
                except Exception:
                    traceback.print_exc(file=sys.stderr)
                    return 1
                return 0
            request_id = request['id']
            # Third-party progress logs must not corrupt the response protocol.
            with contextlib.redirect_stdout(sys.stderr):
                worker.synthesize(request)
            response = {'id': request_id, 'ok': True}
        except Exception:
            response = {'id': request_id, 'ok': False, 'error': traceback.format_exc()[-3000:]}
        print(json.dumps(response, ensure_ascii=True), file=protocol, flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
