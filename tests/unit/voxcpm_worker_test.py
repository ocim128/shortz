"""Model-free tests for the VoxCPM2 worker and Ultimate Cloning contract."""
import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

try:
    import numpy as np
except ImportError:
    np = None

spec = importlib.util.spec_from_file_location('voxcpm_worker', Path(__file__).resolve().parents[2] / 'resources/tts/voxcpm_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class ChunkTests(unittest.TestCase):
    def test_chunk_limit_and_order(self):
        text = ('Hujan turun sepanjang malam. ' * 30).strip()
        result = worker.chunks(text)
        self.assertTrue(all(len(part) <= 300 for part in result))
        self.assertEqual(' '.join(result), text)

    def test_very_long_word_is_split_without_losing_characters(self):
        result = worker.chunks('a' * 700)
        self.assertTrue(all(len(part) <= 300 for part in result))
        self.assertEqual(''.join(result), 'a' * 700)

    def test_paragraph_boundaries_are_retained_for_direct_worker_calls(self):
        self.assertEqual(worker.chunks('Satu.\n\nDua.'), ['Satu.', 'Dua.'])

    def test_strip_delivery_and_sound_effects(self):
        self.assertEqual(worker.strip_delivery_tags('[hook]Hujan turun. [sfx:knock] Tok. Tok. Dia pergi.'), 'Hujan turun. Dia pergi.')

    def test_checkpoint_is_multilingual(self):
        self.assertEqual(worker.CHECKPOINT, 'openbmb/VoxCPM2')

@unittest.skipIf(np is None, 'numpy is required for synthesis tests')
class UltimateCloningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / 'studio.wav'
        self.source.write_bytes(b'reference source')
        self.env = patch.dict(os.environ, {'SHORTZ_VOX_REFERENCE_WAV': str(self.source), 'SHORTZ_VOX_REFERENCE_TEXT': 'Malam itu sunyi.'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.calls = []
        self.writes = []
        self.instance = worker.SpeechWorker()
        self.instance.model = SimpleNamespace(tts_model=SimpleNamespace(sample_rate=1000), generate=lambda **kwargs: (self.calls.append(kwargs) or np.full(1500, 0.1, dtype=np.float32)))
        self.instance.np = np
        self.instance.torch = SimpleNamespace(manual_seed=lambda _seed: None, inference_mode=nullcontext)
        self.instance.sf = SimpleNamespace(info=lambda _path: SimpleNamespace(frames=1000, samplerate=1000), write=lambda *args: self.writes.append(args))
        self.request = {'text': '[hook]Hujan turun. [sfx:knock] Dia pergi.', 'prompt': 'narrator', 'seed': 1, 'reference': str(Path(self.tmp.name) / 'reference.wav'), 'output': str(Path(self.tmp.name) / 'out.wav'), 'ffmpeg_path': 'ffmpeg'}

    def test_every_generation_uses_same_reference_and_exact_prompt(self):
        self.instance.synthesize(self.request)
        call = self.calls[0]
        self.assertEqual(call['prompt_wav_path'], call['reference_wav_path'])
        self.assertEqual(call['prompt_text'], 'Malam itu sunyi.')
        self.assertEqual(call['text'], 'Hujan turun. Dia pergi.')

    def test_missing_reference_fails_without_generating(self):
        with patch.dict(os.environ, {'SHORTZ_VOX_REFERENCE_TEXT': ''}):
            with self.assertRaisesRegex(RuntimeError, 'exact SHORTZ_VOX_REFERENCE_TEXT'):
                self.instance.synthesize(self.request)
        self.assertEqual(self.calls, [])

    def test_denoise_is_cached_by_reference_content_and_transcript(self):
        cache = set()
        def fake_info(p):
            if p not in cache:
                raise RuntimeError('missing')
            return SimpleNamespace(frames=1000, samplerate=1000)
        self.instance.sf.info = fake_info
        def fake_run(argv, **_kwargs):
            Path(argv[-1]).write_bytes(b'x' * 100)
            return SimpleNamespace(returncode=0, stderr='')
        with patch.object(worker.subprocess, 'run', side_effect=fake_run) as run:
            self.instance.synthesize(self.request)
            cache.add(self.calls[-1]['reference_wav_path'])
            self.instance.synthesize(self.request)
            self.assertEqual(run.call_count, 1)
        self.assertIn('afftdn=nf=-25,highpass=f=85', run.call_args.args[0])
        self.assertEqual(self.calls[0]['prompt_wav_path'], self.calls[1]['prompt_wav_path'])

    def test_overlong_synthesis_is_retried(self):
        outputs = iter([np.full(4480, 0.1, dtype=np.float32), np.full(1600, 0.1, dtype=np.float32)])
        self.instance.model.generate = lambda **kw: (self.calls.append(kw) or next(outputs))
        self.request['text'] = 'Kamu meraih gagang pintu.'
        with patch.object(worker.sys, 'stderr', io.StringIO()):
            self.instance.synthesize(self.request)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(self.writes[0][1]), 1600)

    def test_missing_ffmpeg_fails_when_denoising_is_needed(self):
        self.instance.sf.info = lambda _path: (_ for _ in ()).throw(RuntimeError('missing'))
        self.request.pop('ffmpeg_path')
        with self.assertRaisesRegex(RuntimeError, 'ffmpeg_path is required'):
            self.instance.synthesize(self.request)

class ProtocolTests(unittest.TestCase):
    def test_current_protocol_returns_correlated_success(self):
        request = {'id': 23, 'text': 'Halo.'}
        with patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request))), patch.object(worker.sys, 'stdout', io.StringIO()) as stdout, patch.object(worker.SpeechWorker, 'synthesize'):
            self.assertEqual(worker.main(), 0)
        self.assertEqual(json.loads(stdout.getvalue()), {'id': 23, 'ok': True})

    def test_legacy_request_exits_successfully(self):
        request = {'text': 'Halo.', 'output': 'scratch/speech.wav'}
        with patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request))), patch.object(worker.sys, 'stdout', io.StringIO()), patch.object(worker.SpeechWorker, 'synthesize') as synthesize:
            self.assertEqual(worker.main(), 0)
        self.assertEqual(synthesize.call_args.args[0]['reference'], str(Path('scratch/reference.wav')))

    def test_legacy_failure_exits_nonzero(self):
        with patch.object(worker.sys, 'stdin', io.StringIO(json.dumps({'text': 'Halo.', 'output': 'out.wav'}))), patch.object(worker.sys, 'stderr', io.StringIO()), patch.object(worker.SpeechWorker, 'synthesize', side_effect=RuntimeError('failed')):
            self.assertEqual(worker.main(), 1)

if __name__ == '__main__':
    unittest.main()
