"""Fast, model-free checks for the narration chunker."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch

try:
    import numpy as np
except ImportError:
    np = None

spec = importlib.util.spec_from_file_location(
    'voxcpm_worker', Path(__file__).resolve().parents[2] / 'resources/tts/voxcpm_worker.py'
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class TagStrippingTests(unittest.TestCase):
    def test_preserves_paragraph_breaks(self):
        text = worker.strip_delivery_tags('Satu. [hook]\n\nDua.')
        self.assertEqual(worker.chunks(text), ['Satu.', 'Dua.'])

    def test_delivery_tags_never_reach_the_model(self):
        self.assertEqual(
            worker.strip_delivery_tags('[hook]Kalau kaca dikut. [tactical]Pertama, kunci.'),
            'Kalau kaca dikut. Pertama, kunci.',
        )

    @unittest.skipIf(np is None, 'numpy is required for synthesis tests')
    def test_synthesize_feeds_stripped_text_to_the_chunker(self):
        instance = worker.SpeechWorker()
        calls = []
        writes = []
        instance.model = SimpleNamespace(
            tts_model=SimpleNamespace(sample_rate=1000),
            generate=lambda **kwargs: (calls.append(kwargs) or np.full(1500, 0.1, dtype=np.float32))
        )
        instance.np = np
        instance.torch = SimpleNamespace(manual_seed=lambda _seed: None, inference_mode=nullcontext)
        instance.sf = SimpleNamespace(
            info=lambda _path: SimpleNamespace(frames=1000, samplerate=1000),
            write=lambda _path, data, _rate: writes.append(data)
        )
        with patch.object(worker.sys, 'stderr', io.StringIO()):
            instance.synthesize({
                'text': '[hook]Kalau kaca dikut. [twist]Dia di belakangmu.',
                'prompt': 'narrator', 'seed': 707,
                'reference': 'reference.wav', 'output': 'output.wav'})
        generated = ' '.join(call['text'] for call in calls)
        self.assertNotIn('[', generated)
        self.assertIn('Kalau kaca dikut.', generated)
        self.assertIn('Dia di belakangmu.', generated)


@unittest.skipIf(np is None, 'numpy is required for reference tests')
class ReferenceDenoiseTests(unittest.TestCase):
    """The single shared reference must be pre-cleaned so VoxCPM never clones
    room noise into every chunk (the hiss-under-speech failure)."""

    def make_worker(self):
        instance = worker.SpeechWorker()
        instance.model = SimpleNamespace(
            tts_model=SimpleNamespace(sample_rate=1000),
            generate=lambda **_kwargs: np.full(1500, 0.1, dtype=np.float32)
        )
        instance.np = np
        instance.torch = SimpleNamespace(manual_seed=lambda _seed: None, inference_mode=nullcontext)
        instance.sf = SimpleNamespace(
            # The reference must read as MISSING so the worker generates one —
            # that generation path is where the denoise step lives.
            info=lambda _path: (_ for _ in ()).throw(RuntimeError('missing reference')),
            write=lambda _path, data, _rate: None
        )
        return instance

    def test_reference_is_denoised_once_with_ffmpeg_when_available(self):
        import tempfile
        instance = self.make_worker()
        calls = []

        def fake_run(argv, **_kwargs):
            calls.append(argv)
            Path(argv[-1]).write_bytes(b'denoised wav bytes' * 4)  # >44B header guard
            return SimpleNamespace(returncode=0, stderr='')

        with tempfile.TemporaryDirectory() as tmp:
            reference = Path(tmp) / 'reference.wav'
            with patch.object(worker.subprocess, 'run', side_effect=fake_run):
                instance.synthesize({
                    'text': 'Halo.', 'prompt': 'narrator', 'seed': 5,
                    'reference': str(reference), 'output': str(Path(tmp) / 'out.wav'),
                    'ffmpeg_path': 'ffmpeg.exe'})
            self.assertEqual(reference.read_bytes(), b'denoised wav bytes' * 4)
        argv = calls[0]
        self.assertIn('afftdn=nf=-25,highpass=f=85', argv)
        self.assertIn('highpass', ' '.join(argv))

    def test_reference_falls_back_to_raw_without_ffmpeg(self):
        import tempfile
        instance = self.make_worker()

        def fake_write(path, data, _rate):
            Path(path).write_bytes(b'raw wav bytes' * 4)

        instance.sf.write = fake_write
        with tempfile.TemporaryDirectory() as tmp:
            reference = Path(tmp) / 'reference.wav'
            with patch.object(worker.subprocess, 'run') as run:
                instance.synthesize({
                    'text': 'Halo.', 'prompt': 'narrator', 'seed': 5,
                    'reference': str(reference), 'output': str(Path(tmp) / 'out.wav')})
            run.assert_not_called()
            self.assertEqual(reference.read_bytes(), b'raw wav bytes' * 4)


class ChunkTests(unittest.TestCase):
    def test_short_sentences_share_one_generation(self):
        text = 'Hujan turun sepanjang malam. Air merendah pinggul. Aku bertahan.'
        self.assertEqual(worker.chunks(text), [text])

    def test_long_text_is_bounded_and_keeps_words(self):
        text = ('Hujan turun sepanjang malam. ' * 30).strip()
        result = worker.chunks(text)
        self.assertTrue(all(len(part) <= 120 for part in result))
        self.assertEqual(' '.join(result), text)

    def test_unusually_long_word_is_split_without_losing_characters(self):
        word = 'a' * 500
        result = worker.chunks(word)
        self.assertTrue(all(len(part) <= 120 for part in result))
        self.assertEqual(''.join(result), word)

    def test_paragraph_breaks_and_short_sentences_are_preserved(self):
        text = 'Langkah kaki mendekat.\n\nSeseorang berhenti di samping mobilmu. Bayangannya menutupi jendela.'
        self.assertEqual(worker.chunks(text), [
            'Langkah kaki mendekat.',
            'Seseorang berhenti di samping mobilmu. Bayangannya menutupi jendela.'
        ])

    def test_sentences_are_not_split_to_fill_the_previous_chunk(self):
        first = 'A' * 80 + '.'
        second = 'Seseorang berhenti di samping mobilmu.'
        self.assertEqual(worker.chunks(f'{first} {second}', limit=100), [first, second])

    def test_duration_limit_catches_the_observed_runaway_short_sentence(self):
        text = 'Kamu meraih gagang pintu.'
        self.assertLess(worker.max_chunk_duration(text), 4.48)
        self.assertGreater(worker.max_chunk_duration(text), 1.6)


class ProtocolTests(unittest.TestCase):
    def test_legacy_one_shot_request_synthesizes_and_exits_successfully(self):
        request = {'text': 'Halo.', 'prompt': 'narrator', 'seed': 1, 'output': 'scratch/speech.wav'}
        with patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request))), \
             patch.object(worker.sys, 'stdout', io.StringIO()) as stdout, \
             patch.object(worker.SpeechWorker, 'synthesize') as synthesize:
            self.assertEqual(worker.main(), 0)
        self.assertEqual(synthesize.call_args.args[0]['reference'], str(Path('scratch/reference.wav')))
        self.assertEqual(stdout.getvalue(), '')

    def test_legacy_failure_exits_nonzero_instead_of_reporting_success(self):
        request = {'text': 'Halo.', 'output': 'scratch/speech.wav'}
        with patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request))), \
             patch.object(worker.sys, 'stderr', io.StringIO()) as stderr, \
             patch.object(worker.SpeechWorker, 'synthesize', side_effect=RuntimeError('synthesis failed')):
            self.assertEqual(worker.main(), 1)
        self.assertIn('synthesis failed', stderr.getvalue())

    def test_current_protocol_returns_correlated_success(self):
        request = {'id': 23, 'text': 'Halo.'}
        with patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request))), \
             patch.object(worker.sys, 'stdout', io.StringIO()) as stdout, \
             patch.object(worker.SpeechWorker, 'synthesize'):
            self.assertEqual(worker.main(), 0)
        self.assertEqual(json.loads(stdout.getvalue()), {'id': 23, 'ok': True})


@unittest.skipIf(np is None, 'numpy is required for audio validation tests')
class AudioQualityTests(unittest.TestCase):
    def make_worker(self, durations):
        instance = worker.SpeechWorker()
        generated = iter(durations)
        calls = []
        writes = []
        instance.model = SimpleNamespace(
            tts_model=SimpleNamespace(sample_rate=1000),
            generate=lambda **_kwargs: (calls.append(True) or np.full(int(next(generated) * 1000), 0.1, dtype=np.float32))
        )
        instance.np = np
        instance.torch = SimpleNamespace(manual_seed=lambda _seed: None, inference_mode=nullcontext)
        instance.sf = SimpleNamespace(
            info=lambda _path: SimpleNamespace(frames=1000, samplerate=1000),
            write=lambda _path, data, _sample_rate: writes.append(data)
        )
        return instance, calls, writes

    def test_retries_the_observed_overlong_output(self):
        instance, calls, writes = self.make_worker([4.48, 1.6])
        with patch.object(worker.sys, 'stderr', io.StringIO()):
            instance.synthesize({'text': 'Kamu meraih gagang pintu.', 'prompt': 'narrator',
                                 'seed': 707, 'reference': 'reference.wav', 'output': 'output.wav'})
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(writes[0]), 1600)

    def test_reports_failure_if_all_three_attempts_are_overlong(self):
        instance, calls, writes = self.make_worker([4.48, 4.48, 4.48])
        with patch.object(worker.sys, 'stderr', io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'Could not generate a clear speech section'):
                instance.synthesize({'text': 'Kamu meraih gagang pintu.', 'prompt': 'narrator',
                                     'seed': 707, 'reference': 'reference.wav', 'output': 'output.wav'})
        self.assertEqual(len(calls), 3)
        self.assertFalse(writes)


if __name__ == '__main__':
    unittest.main()
