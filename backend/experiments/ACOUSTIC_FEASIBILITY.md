**No-go for production preview analysis.** This prototype defines an offline evaluation of audio features from 30-second previews using exclusively code-generated tones, pulses and seeded noise. It establishes testable failure handling and comparison methodology, but extraction measurements are **not available in this sandbox**: librosa is absent and installation failed because PyPI DNS/network access is unavailable. No relevance, deployment-fit or permission conclusion can be drawn from unexecuted extraction. Apple's terms for automated analysis remain unverified; the owner must resolve that separately before any Apple-URL experiment. The synthetic investigation can continue in an environment with the optional dependencies installed.

## Reproduce the investigation

From `backend/`, use an isolated environment (Python >=3.11):

```sh
python -m venv /tmp/tunegraph-acoustic
/tmp/tunegraph-acoustic/bin/python -m pip install -e '.[dev,acoustic]'
NUMBA_CACHE_DIR=/tmp/tunegraph-numba /tmp/tunegraph-acoustic/bin/python -m experiments.acoustic_similarity --output /tmp/acoustic-cold.json
NUMBA_CACHE_DIR=/tmp/tunegraph-numba /tmp/tunegraph-acoustic/bin/python -m experiments.acoustic_similarity --output /tmp/acoustic-cached-process.json
/tmp/tunegraph-acoustic/bin/python -m pytest -q tests/test_acoustic_experiment.py
```

The first run should use an empty Numba cache; the second measures a new process with populated compilation caches. Each invocation also measures a first extraction and ten subsequent in-process extractions. These are different notions of cold/warm and must not be mixed. Fixture generation is outside extraction timing; import time is separate. JSON is written only to the requested local path. Generated WAVs are temporary and removed automatically. There is no URL input, audio download or committed audio. Synthetic fixtures are bundled as generator definitions, not binary assets.

The default CI suite requires no optional packages: 23 experiment tests pass, seven extraction cases skip explicitly when librosa is absent. An optional environment must run those seven cases; a default-suite pass alone does not validate extraction. This is a feature investigation, so a pre-fix bug regression is not applicable.

## Timing and limits

All unmeasured values below are deliberate gaps, not estimates or zeros. Collect the JSON before replacing them with findings. The checked-in `vercel.json` sets a **30-second total request budget**, including all existing provider work. No deployment limits were fetched during this offline investigation. Research's 500 MB uncompressed Python bundle limit is a prospective comparison reference that must be reverified before deployment.

| metric | cold | warm | Vercel limit | fits? |
| --- | --- | --- | --- | --- |
| Import time | Not measured (`import_seconds`) | Process-local cached imports; not separately timed | Part of 30 s request budget | Unknown |
| Extraction of one 30 s clip | Not measured (`first_extraction_seconds`, includes lazy imports/compilation) | Not measured (`warm_median_seconds` / `warm_max_seconds`, ten fixtures) | Part of 30 s request budget | Unknown |
| Sequential batch | Not measured | Not measured (`warm_batch_seconds`, ten clips); seed + 20 candidates would require separate measurement | 30 s total, less provider overhead | Unknown |
| Peak process RSS | Not measured | Not separately sampled; `peak_rss_bytes` is cumulative high-water mark | Memory allocation not specified in this repo | Unknown |
| Prospective scientific environment bytes | Not measured (`installed_environment_bytes`) | Same installed packages | 500 MB uncompressed reference, unverified here | Unknown; not a deployment bundle measurement |
| WAV fixture bytes | 480,044 per 30 s clip (44-byte header + 240,000 mono int16 samples) | Same | Temporary local files only | No deployment implication |

`resource.ru_maxrss` is converted correctly from bytes on macOS and KiB on Linux. Installed-package size sums metadata-listed file bytes across **the whole evaluation environment**, including development dependencies; this is a conservative proxy, not a Vercel artifact. It excludes app packaging and system codec libraries, and can double-count shared files. A real target-platform deployment artifact, cold start and full seed-plus-20 budget remain mandatory exit evidence. No dependencies were added to production `requirements.txt`; no deployed route imports the experiment.

## Vector and boundaries

Each accepted clip is mono 16-bit PCM WAV, 8 kHz, one sample through 30 seconds. The fixed four-component vector is:

1. Whole-clip RMS amplitude of float PCM divided by 32768.
2. Mean spectral centroid divided by the 4 kHz Nyquist frequency.
3. Mean zero-crossing rate.
4. Mean librosa onset strength (positive spectral change) divided by 20 and capped at 1.

STFT uses 512 samples and a 128-sample hop. Clips shorter than a frame are zero-padded. The fixed scaling is a **heuristic**, not learned calibration; equal component weights can overemphasize related spectral descriptors. Euclidean distance divided by sqrt(4) becomes similarity `max(0, 1 - distance)`. RMS is sensitive to loudness and recording conditions; this does not establish song-level musical properties. An 8 kHz synthetic experiment cannot establish validity on catalog previews.

Missing files, corrupt headers, truncated PCM, unsupported channels/sample width/rate, empty or oversized clips and silence return `None` (unknown). Unknown seed/candidate audio keeps the original baseline exactly. Installation/import failures deliberately raise instead of silently degrading the whole experiment. The harness fails visibly if required optional dependencies are absent. No MP3, AAC/M4A, network codec or resampling path is implemented or measured; production preview decoding would require a separate rights-approved, target-platform investigation.

## Comparison methodology and findings

Ten deterministic fixtures cover low/mid/high tones at different levels, two pulse rates, seeded noise and silence. Each seed has the other nine fixtures as candidates; choose seven **after** scoring. Tags and co-listening values are manufactured, explicitly not Last.fm observations or human relevance judgments. The baseline imports production `tag_similarity` and `blend` unchanged: 0.6 co-listening / 0.4 tag cosine, preserving its missing-tag fallback.

Compare baseline with `(1 - w) * baseline + w * audio_similarity` at `w = 0, 0.2, 0.4, 1`. Unknown audio falls back to baseline at every weight. Ties preserve fixture order. JSON includes every score-selection outcome, both seven-item lists, order change, set membership change and number replaced. `membership` aggregates changed expansions divided by all ten expansions for each weight; silence is included to expose fallback behavior. Weight zero is the baseline control. Weight one is an audio-only sensitivity check for valid audio, still using baseline for missing audio. These weights are exploratory and not proposed production settings.

**Measured membership findings: unavailable.** No actual fixture extraction succeeded in this environment; no synthetic audio membership percentages are asserted. Separate default tests with handcrafted vectors verify that the evaluator detects set changes, that zero weight preserves order, and that missing vectors preserve baseline at all weights. Those tests verify the metric implementation, not effectiveness of extracted audio features. Synthetic distinctions cannot prove improved discovery or listener relevance even after a successful optional run.

## If shipped, what would a listener see?

There is no UI or ranking change in this issue. A future blend could alter which seven songs appear only if applied to a larger candidate pool before truncation. The required membership measure is the share of ten fixture expansions whose seven-song **sets** change, separately for each experimental weight; that measure remains unexecuted here. Reordering an already-truncated seven-song list cannot change membership. Any later explanation would describe audio features from 30-second previews in the shared song-panel hint line alongside journey and tag steering; no additional tooltip or score is proposed.

## Conditions for a future go decision

- Resolve Apple's automated-analysis terms with the owner before accessing any Apple preview URL.
- Run the optional suite and retain cold/cached-process JSON on a stated target platform; measure MP3/AAC decoding separately with permitted sources.
- Measure actual bundle size, target memory, cold start and seed-plus-20 request time against verified deployment limits and remaining provider budget.
- Establish relevance with a rights-approved music dataset and listener evaluation, including sparse/missing audio, loudness differences and clip-position variation. Synthetic clips provide correctness controls only.
- Only then scope a separate production proposal. No application routes, similarity services, storage formats, artist behavior, frontend files or snapshot scenarios changed here.
