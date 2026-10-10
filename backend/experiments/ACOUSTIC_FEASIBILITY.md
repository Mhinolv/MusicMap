**No-go for production preview analysis; go for further offline investigation.** Audio features from 30-second previews were evaluated on code-generated tones, pulses and seeded noise. The optional harness and all extraction tests now run successfully: a first extraction takes 3.84 s locally, warm extractions about 10–11 ms, peak process RSS is 296.8 MB, and the installed evaluation environment occupies 327.1 MB. These are macOS measurements, not proof of Vercel fit or improved music discovery. Apple's automated-analysis terms remain unverified; the owner must resolve that separately before any Apple-URL experiment. No production ranking, dependencies or UI changed.

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

Measurements were collected on macOS 15.7.9 arm64, Python 3.12.11, librosa 1.0.0, NumPy 2.5.3 and Numba 0.68.0. The optional pin was updated from 0.11.0 to the locally cached, successfully tested 1.0.0 because network installation is unavailable. Existing backend dependencies were copied into an isolated temporary environment; optional packages were installed from the local cache. `pip install --no-index --no-build-isolation -e '.[dev]'` then succeeded, using the preinstalled build backend and dependencies.

[Raw measurements](acoustic_measurements.json) retain both complete harness outputs (vectors, timings, comparisons and failure checks) and installed package versions. The cold run used a fresh `NUMBA_CACHE_DIR`; the cached run reused it in a new process. Both outputs have identical vectors, scores and membership outcomes, and all four failure checks are true. These are single process runs, not repeated cold-start percentiles; each warm sample comprises ten fixtures, including silence's early return.

The default suite does not require librosa: **69 tests pass and seven extraction cases explicitly skip** in an isolated default-only environment. Setuptools is now a dev dependency so CI executes the packaging regression. That test also supports older test environments by explicitly skipping if the build backend is absent; the pre-existing shared interpreter passes 68 tests with eight skips. The complete optional suite passes **76 tests**, including all seven extraction cases and the packaging regression. Frontend typecheck, build and lint pass (three existing lint warnings). A default-suite pass alone does not validate extraction. The packaging regression was added before fixing discovery and failed with `Multiple top-level packages discovered in a flat-layout: ['app', 'experiments']`; explicit discovery now includes only `app` and its subpackages. Running `python -m experiments.acoustic_similarity` from the backend checkout still works.

## Timing and limits

All sizes use decimal MB. The checked-in `vercel.json` sets a **30-second total request budget**, including existing provider work. No deployment limits were fetched during this offline investigation. The earlier 500 MB uncompressed Python bundle reference remains unverified and must be rechecked before deployment.

| metric | cold | warm | Vercel limit | fits? |
| --- | --- | --- | --- | --- |
| Import time | 0.202 s | 0.043 s, new cached process | Part of 30 s request budget | Locally below budget; target unmeasured |
| First extraction of one 30 s clip | 3.841 s, empty Numba cache | 1.023 s, new process with populated Numba cache | Part of 30 s request budget | Locally below budget; target unmeasured |
| Subsequent in-process extraction | Median 0.00968 s / max 0.01035 s | Median 0.01122 s / max 0.01167 s | Part of 30 s request budget | Locally below budget; target unmeasured |
| Sequential ten-fixture batch after first extraction | 0.08860 s | 0.10157 s | 30 s total, less provider overhead | Local batch fits; seed + 20 unmeasured |
| Peak process RSS through extraction | 296.8 MB | 287.3 MB | Memory allocation not specified in this repo | Unknown on target |
| Prospective installed evaluation environment | 327.1 MB | Same packages | 500 MB uncompressed reference, unverified | Proxy below reference; actual artifact unmeasured |
| WAV fixture bytes | 480,044 per 30 s clip | Same | Temporary local files only | No deployment implication |

Import plus first extraction totals 4.042 s cold and 1.066 s in the cached process. The batch is ten fixtures after that first extraction, not a seed-plus-20 simulation. Warm medians/maxima are in-process values; they must not be confused with the first extraction in a new cached process. Peak RSS is the cumulative high-water mark sampled after extraction, before baseline comparison. `resource.ru_maxrss` is converted from bytes on macOS and KiB on Linux.

Installed-package size sums metadata-listed file bytes across the whole evaluation environment, including backend, development and build dependencies. It is a prospective size proxy, not a Vercel deployment artifact. It excludes application source, generated bytecode and system libraries, can double-count shared files, and includes macOS-specific native wheels. A Linux artifact can differ substantially. Actual target-platform packaging, memory, cold start and full seed-plus-20 latency remain mandatory exit evidence. No dependencies were added to production `requirements.txt`; no deployed route imports the experiment.

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

**Measured membership findings:** weight 0 changes 0/10 expansions (0%); weight 0.2 changes 1/10 (10%); weight 0.4 changes 4/10 (40%); weight 1 changes 9/10 (90%). These percentages measure seven-item set changes, not reordering. The silence seed retains baseline membership at every weight because its vector is unknown. Cold and cached runs produce identical results. Tests with handcrafted vectors separately verify set-change accounting, the zero-weight control and missing-vector fallback. These synthetic distinctions demonstrate sensitivity of candidate selection, not improved discovery or listener relevance.

## If shipped, what would a listener see?

There is no UI or ranking change in this issue. A future blend could alter which seven songs appear only if applied to a larger candidate pool before truncation. The required membership measure is the share of ten fixture expansions whose seven-song **sets** change, separately for each experimental weight; that share is 0%, 10%, 40% and 90% at weights 0, 0.2, 0.4 and 1 respectively in this synthetic experiment. Reordering an already-truncated seven-song list cannot change membership. Any later explanation would describe audio features from 30-second previews in the shared song-panel hint line alongside journey and tag steering; no additional tooltip or score is proposed.

## Conditions for a future go decision

- Resolve Apple's automated-analysis terms with the owner before accessing any Apple preview URL.
- Repeat the passing optional suite and retained cold/cached-process measurements on the actual deployment target; measure MP3/AAC decoding separately with permitted sources.
- Measure actual bundle size, target memory, cold start and seed-plus-20 request time against verified deployment limits and remaining provider budget.
- Establish relevance with a rights-approved music dataset and listener evaluation, including sparse/missing audio, loudness differences and clip-position variation. Synthetic clips provide correctness controls only.
- Only then scope a separate production proposal. No application routes, similarity services, storage formats, artist behavior, frontend files or snapshot scenarios changed here.
