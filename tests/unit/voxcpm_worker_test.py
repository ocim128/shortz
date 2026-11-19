"""Fast, model-free checks for the narration chunker."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'voxcpm_worker', Path(__file__).resolve().parents[2] / 'resources/tts/voxcpm_worker.py'
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ChunkTests(unittest.TestCase):
    def test_short_sentences_share_one_generation(self):
        text = 'Hujan turun sepanjang malam. Air merendah pinggul. Aku bertahan.'
        self.assertEqual(worker.chunks(text), [text])

    def test_long_text_is_bounded_and_keeps_words(self):
        text = ('Hujan turun sepanjang malam. ' * 30).strip()
        result = worker.chunks(text)
        self.assertTrue(all(len(part) <= 220 for part in result))
        self.assertEqual(' '.join(result), text)

    def test_unusually_long_word_is_split_without_losing_characters(self):
        word = 'a' * 500
        result = worker.chunks(word)
        self.assertTrue(all(len(part) <= 220 for part in result))
        self.assertEqual(''.join(result), word)


if __name__ == '__main__':
    unittest.main()
