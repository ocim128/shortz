# Episode 001 ? offline strict verification

Checkpoint: `openbmb/VoxCPM2`; ASR: faster-whisper `small`.
Result: FAIL; 3/6 chunks verified; duration 62.508 seconds.
Reference: recovered synthetic `voice-assets/narrator-v4-reference.wav`; its prompt transcript matches the project audition passage and was checked by ASR only, not by a human listener.
Cloud A/B was not run: offline was requested and no cloud credentials are configured.

The target words Pertama and Air occur in chunks 2 and 5 respectively. Both are matched by the selected raw and conditioned transcripts (0/1 word errors for each target); chunk 2 still fails because of another mismatch. This is an ASR result, not a pronunciation guarantee.

## Chunk 1: verified (0 retries; selected attempt 1)

Kalau kaca diketuk, jangan langsung menoleh. Saat wabah menutup jalan tol, dua langkah ini bisa menyembunyikanmu. Satu bunyi bisa membuatmu salah melihat arah.

- Attempt 1: raw mismatches: none; conditioned mismatches: none; raw end flagged: False; conditioned end flagged: False.

## Chunk 2: failed (2 retries; selected attempt 3)

Pertama, kunci semua pintu. Mobil di depan dan belakang sudah rapat. Gagang pintu tinggal sejengkal dari tanganmu saat seseorang diterkam di sela mobil.

- Attempt 1: raw mismatches: sela ? salah; conditioned mismatches: sela ? salah; raw end flagged: False; conditioned end flagged: False.
- Attempt 2: raw mismatches: sela ? selam; conditioned mismatches: sejengkal ? sejenkal; sela ? selam; raw end flagged: False; conditioned end flagged: False.
- Attempt 3: raw mismatches: sela ? selam; conditioned mismatches: sela ? selam; raw end flagged: False; conditioned end flagged: False.

## Chunk 3: verified (0 retries; selected attempt 1)

Tarik tanganmu. Tekan kunci. Kalau mobil tak bisa maju, pintu tertutup itu satu-satunya batas antara kamu dan jalan.

- Attempt 1: raw mismatches: none; conditioned mismatches: none; raw end flagged: False; conditioned end flagged: False.

## Chunk 4: failed (2 retries; selected attempt 1)

Kedua, hilangkan tanda kalau ada orang di dalam. Matikan mesin, lampu, dan radio. Turunkan badan sampai garis jendela ada di atas kepalamu.

- Attempt 1: raw mismatches: jendela ? cendela; conditioned mismatches: jendela ? cendela; raw end flagged: False; conditioned end flagged: False.
- Attempt 2: raw mismatches: jendela ? cendela; conditioned mismatches: jendela ? cendela; raw end flagged: False; conditioned end flagged: False.
- Attempt 3: raw mismatches: jendela ? cendela; conditioned mismatches: jendela ? cendela; raw end flagged: False; conditioned end flagged: False.

## Chunk 5: verified (1 retries; selected attempt 2)

Kalau langkah berhenti di samping pintu, biarkan bayangannya lewat dulu. Air tinggal setengah botol, baterai enam puluh persen. Kamu cuma perlu bertahan sampai pagi.

- Attempt 1: raw mismatches: baterai ? bateri; conditioned mismatches: baterai ? bateri; raw end flagged: False; conditioned end flagged: False.
- Attempt 2: raw mismatches: none; conditioned mismatches: none; raw end flagged: False; conditioned end flagged: False.

## Chunk 6: failed (2 retries; selected attempt 3)

Pukul tiga pagi, jalan akhirnya sunyi. Jendelanya kosong. Yang mengetuk duduk tepat di belakangmu.

- Attempt 1: raw mismatches: sunyi ? suni; jendelanya ? jendelannya; belakangmu ? belakang; conditioned mismatches: pukul ? bukul; jendelanya ? jendelannya; belakangmu ? belakang; raw end flagged: True; conditioned end flagged: True.
- Attempt 2: raw mismatches: jendelanya ? jendelannya; conditioned mismatches: pukul ? bukul; raw end flagged: False; conditioned end flagged: False.
- Attempt 3: raw mismatches: sunyi ? suni; jendelanya ? jendelannya; conditioned mismatches: jendelanya ? jendelannya; raw end flagged: False; conditioned end flagged: False.

A strict failure is retained as review audio and must not be treated as verified. The checker cannot prove pronunciation, language accent, or recover audio missing from the model output.
