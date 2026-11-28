"""Fast, model-free checks for the ASR verification worker protocol."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch

try:
    import numpy as np
except ImportError:
    np = None

spec = importlib.util.spec_from_file_location(
    'asr_worker', Path(__file__).resolve().parents[2] / 'resources/tts/asr_worker.py'
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def make_stubs(heard_text, words, sample_count=16000):
    """np/sf/resample stubs plus a WhisperModel stand-in (needs numpy — the
    real soundfile.read returns an ndarray and transcribe() relies on that)."""
    read_files = []

    mono = np.zeros(sample_count, dtype=np.float32)

    class SfStub:
        @staticmethod
        def read(path, dtype=None):
            read_files.append(path)
            return mono, 16000

    model = SimpleNamespace(
        transcribe=lambda samples, **kwargs: (
            iter([SimpleNamespace(text=f' {heard_text} ', words=[
                SimpleNamespace(word=f' {w} ', start=s, end=e) for (w, s, e) in words
            ])]),
            None,
        )
    )
    resample = lambda samples, up, down: samples
    return np, SfStub, resample, model, read_files


class ProtocolTests(unittest.TestCase):
    def test_reports_a_missing_verifier_per_request_instead_of_dying(self):
        request = json.dumps({'id': 7, 'wav': 'x.wav'})
        with patch.object(worker.sys, 'stdin', io.StringIO(request)), \
             patch.object(worker.sys, 'stdout', io.StringIO()) as stdout, \
             patch.object(worker, 'load_model', side_effect=ImportError("No module named 'faster_whisper'")):
            self.assertEqual(worker.main(), 0)
        response = json.loads(stdout.getvalue())
        self.assertEqual(response['id'], 7)
        self.assertFalse(response['ok'])
        self.assertIn('pip install faster-whisper', response['error'])

    @unittest.skipIf(np is None, 'numpy is required for model-size tests')
    def test_model_size_is_configurable_per_request_and_cached(self):
        np_stub, sf_stub, resample, model, _read = make_stubs('Hujan.', [('Hujan', 0.1, 0.5)])
        sizes = []

        def recording_load(size):
            sizes.append(size)
            return np_stub, sf_stub, resample, model

        lines = '\n'.join([
            json.dumps({'id': 1, 'wav': 'a.wav'}),                      # default
            json.dumps({'id': 2, 'wav': 'b.wav'}),                      # cached 'small'
            json.dumps({'id': 3, 'wav': 'c.wav', 'model': 'base'}),     # explicit size
        ])
        with patch.object(worker.sys, 'stdin', io.StringIO(lines)), \
             patch.object(worker.sys, 'stdout', io.StringIO()) as stdout, \
             patch.object(worker, 'load_model', side_effect=recording_load):
            self.assertEqual(worker.main(), 0)
        responses = [json.loads(line) for line in stdout.getvalue().strip().split('\n')]
        self.assertTrue(all(r['ok'] for r in responses))
        # Default is small (not base) for Indonesian accuracy.
        self.assertEqual(sizes, ['small', 'base'])
        # One load per size, not per request.
        self.assertEqual(len(sizes), 2)

    @unittest.skipIf(np is None, 'numpy is required for transcription stubs')
    def test_transcribes_id_with_beam_five_and_maps_word_times(self):
        np_stub, sf_stub, resample, model, read_files = make_stubs(
            'Kamu meraih gagang pintu.',
            [('Kamu', 0.1004, 0.3001), ('meraih', 0.3, 0.7002), ('pintu.', 1.1, 1.6)],
        )
        transcribe_args = {}
        original = model.transcribe

        def recording(samples, **kwargs):
            transcribe_args.update(kwargs)
            return original(samples, **kwargs)

        model.transcribe = recording
        request = json.dumps({'id': 3, 'wav': 'chunk.wav'})
        with patch.object(worker.sys, 'stdin', io.StringIO(request)), \
             patch.object(worker.sys, 'stdout', io.StringIO()) as stdout, \
             patch.object(worker, 'load_model', return_value=(np_stub, sf_stub, resample, model)):
            self.assertEqual(worker.main(), 0)
        response = json.loads(stdout.getvalue())
        self.assertTrue(response['ok'])
        self.assertEqual(response['transcript'], 'Kamu meraih gagang pintu.')
        # Whisper pinned to Indonesian, beam 5, no VAD, no context carryover.
        self.assertEqual(transcribe_args['language'], 'id')
        self.assertEqual(transcribe_args['beam_size'], 5)
        self.assertFalse(transcribe_args['vad_filter'])
        self.assertFalse(transcribe_args['condition_on_previous_text'])
        self.assertTrue(transcribe_args['word_timestamps'])
        # Word tokens are stripped and times rounded to milliseconds.
        self.assertEqual(response['words'][0], {'word': 'Kamu', 'start': 0.1, 'end': 0.3})
        self.assertEqual(response['durationSec'], 1.0)
        self.assertEqual(read_files, ['chunk.wav'])

    @unittest.skipIf(np is None, 'numpy is required for transcription stubs')
    def test_forwards_requested_language_to_whisper(self):
        np_stub, sf_stub, resample, model, _read = make_stubs(
            'A Javanese jong.',
            [('A', 0.1, 0.2), ('Javanese', 0.2, 0.6), ('jong.', 0.6, 0.9)],
        )
        transcribe_args = {}
        original = model.transcribe

        def recording(samples, **kwargs):
            transcribe_args.update(kwargs)
            return original(samples, **kwargs)

        model.transcribe = recording
        request = json.dumps({'id': 4, 'wav': 'en.wav', 'language': 'en'})
        with patch.object(worker.sys, 'stdin', io.StringIO(request)), \
             patch.object(worker.sys, 'stdout', io.StringIO()) as stdout, \
             patch.object(worker, 'load_model', return_value=(np_stub, sf_stub, resample, model)):
            self.assertEqual(worker.main(), 0)
        response = json.loads(stdout.getvalue())
        self.assertTrue(response['ok'])
        self.assertEqual(transcribe_args['language'], 'en')

    @unittest.skipIf(np is None, 'numpy is required for transcription stubs')
    def test_a_transcribe_failure_becomes_ok_false_not_a_crash(self):
        np_stub, sf_stub, resample, _model, _read = make_stubs('', [])

        def boom(_samples, **_kwargs):
            raise RuntimeError('asr exploded')

        model = SimpleNamespace(transcribe=boom)
        request = json.dumps({'id': 9, 'wav': 'x.wav'})
        with patch.object(worker.sys, 'stdin', io.StringIO(request)), \
             patch.object(worker.sys, 'stdout', io.StringIO()) as stdout, \
             patch.object(worker, 'load_model', return_value=(np_stub, sf_stub, resample, model)):
            self.assertEqual(worker.main(), 0)
        response = json.loads(stdout.getvalue())
        self.assertEqual(response['id'], 9)
        self.assertFalse(response['ok'])
        self.assertIn('asr exploded', response['error'])


if __name__ == '__main__':
    unittest.main()
