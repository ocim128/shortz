"""Keep VoxCPM loaded and serve one JSON-line synthesis request at a time."""
import contextlib
import json
import os
import re
import sys
import traceback
from pathlib import Path


def chunks(text, limit=220):
    """Group short sentences, splitting long ones at word boundaries."""
    parts = re.split(r'(?<=[.!?…])\s+|\n+', text.strip())
    result = []
    current = ''
    for part in parts:
        for word in part.split():
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
    return result


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
            try:
                sf.write(str(temporary), voice, sample_rate)
                os.replace(temporary, reference)
            finally:
                temporary.unlink(missing_ok=True)

        audio = []
        for index, part in enumerate(chunks(request['text'])):
            torch.manual_seed(request['seed'])
            np.random.seed(request['seed'])
            with torch.inference_mode():
                wav = np.asarray(model.generate(
                    text=f"({request['prompt']}){part}", reference_wav_path=str(reference),
                    cfg_value=2.0, inference_timesteps=10), dtype=np.float32).reshape(-1)
            if not len(wav):
                raise RuntimeError('VoxCPM returned empty audio')
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
            request_id = request['id']
            # Third-party progress logs must not corrupt the response protocol.
            with contextlib.redirect_stdout(sys.stderr):
                worker.synthesize(request)
            response = {'id': request_id, 'ok': True}
        except Exception:
            response = {'id': request_id, 'ok': False, 'error': traceback.format_exc()[-3000:]}
        print(json.dumps(response, ensure_ascii=True), file=protocol, flush=True)


if __name__ == '__main__':
    main()
