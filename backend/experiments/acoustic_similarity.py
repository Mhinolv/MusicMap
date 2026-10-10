"""Offline, synthetic-only evaluation. Never imported by application routes.

Run from backend: python -m experiments.acoustic_similarity --output /tmp/acoustic.json
Optional environment: pip install -e '.[acoustic]'
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
from pathlib import Path
import platform
import random
import resource
import statistics
import struct
import sys
import time
import wave
from tempfile import TemporaryDirectory

SAMPLE_RATE = 8000
DURATION = 30
FEATURE_NAMES = ("rms", "centroid_over_nyquist", "zero_crossing_rate", "onset_strength_over_20")
FIXTURES = (
    ("low", "tone", 110, .3, ("low", "steady")),
    ("low_quiet", "tone", 130, .1, ("low", "steady")),
    ("mid", "tone", 440, .3, ("mid", "steady")),
    ("mid_loud", "tone", 480, .6, ("mid", "steady")),
    ("high", "tone", 1600, .3, ("high", "steady")),
    ("high_quiet", "tone", 1800, .1, ("high", "steady")),
    ("slow_pulse", "pulse", 220, .4, ("pulse", "slow")),
    ("fast_pulse", "pulse", 220, .6, ("pulse", "fast")),
    ("noise", "noise", 0, .2, ("noise",)),
    ("silence", "tone", 0, 0, ()),
)


def generate_fixture(path: Path, kind: str, frequency: float, amplitude: float,
                     duration: float = DURATION) -> None:
    """Seeded PCM WAV; no audio assets, URLs or external files required."""
    if kind not in {"tone", "pulse", "noise"}:
        raise ValueError("unknown synthetic kind")
    if not 0 < duration <= DURATION or not 0 <= amplitude <= 1:
        raise ValueError("duration/amplitude out of bounds")
    if not 0 <= frequency < SAMPLE_RATE / 2:
        raise ValueError("frequency out of bounds")
    rng = random.Random(9)
    samples = bytearray()
    for i in range(round(duration * SAMPLE_RATE)):
        t = i / SAMPLE_RATE
        value = rng.uniform(-1, 1) if kind == "noise" else math.sin(2 * math.pi * frequency * t)
        if kind == "pulse":
            rate = 2 if amplitude < .5 else 4
            value *= math.exp(-25 * (t % (1 / rate)))
        samples.extend(struct.pack("<h", round(value * amplitude * 32767)))
    with wave.open(str(path), "wb") as wav:
        wav.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
        wav.writeframes(samples)


def extract(path: Path) -> tuple[float, ...] | None:
    """Missing/corrupt/unsupported files are unknown, never a zero-distance match.

    Only bounded, mono, 16-bit PCM WAV is accepted. Silence is also unknown.
    Dependency/import errors deliberately propagate (installation failures).
    """
    import librosa
    import numpy as np

    try:
        with wave.open(str(path), "rb") as wav:
            if (wav.getnchannels() != 1 or wav.getsampwidth() != 2
                    or wav.getframerate() != SAMPLE_RATE
                    or not 1 <= wav.getnframes() <= DURATION * SAMPLE_RATE):
                return None
            count = wav.getnframes()
            raw = wav.readframes(count)
            if len(raw) != count * 2:
                return None
    except (OSError, EOFError, wave.Error):
        return None
    y = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    if not np.any(y):
        return None
    # Pad very short clips explicitly, avoiding FFT warnings and undefined frames.
    y = np.pad(y, (0, max(0, 512 - len(y))))
    spectrum = abs(librosa.stft(y, n_fft=512, hop_length=128))
    onset = librosa.onset.onset_strength(S=librosa.amplitude_to_db(spectrum), sr=SAMPLE_RATE,
                                         hop_length=128, n_fft=512)
    vector = (
        float(np.sqrt(np.mean(y * y))),
        float(np.mean(librosa.feature.spectral_centroid(S=spectrum, sr=SAMPLE_RATE))) / (SAMPLE_RATE / 2),
        float(np.mean(librosa.feature.zero_crossing_rate(y, frame_length=512, hop_length=128))),
        min(1.0, float(np.mean(onset)) / 20),
    )
    return vector if all(math.isfinite(v) for v in vector) else None


def audio_similarity(a: tuple[float, ...] | None, b: tuple[float, ...] | None) -> float | None:
    if a is None or b is None:
        return None
    if len(a) != len(FEATURE_NAMES) or len(b) != len(FEATURE_NAMES):
        raise ValueError("wrong feature vector length")
    return max(0., 1 - math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)) / len(a)))


def experimental_blend(baseline: float | None, acoustic: float | None, weight: float) -> float | None:
    if not 0 <= weight <= 1:
        raise ValueError("weight must be in [0, 1]")
    if acoustic is None:
        return baseline
    if baseline is None:
        return acoustic if weight else None
    return (1 - weight) * baseline + weight * acoustic


def compare(vectors: dict[str, tuple[float, ...] | None]) -> list[dict]:
    # Use the actual production tag/co-listening baseline, with manufactured inputs.
    from app.services.similarity import blend, tag_similarity
    results = []
    for seed_index, seed in enumerate(FIXTURES):
        candidates = [f for f in FIXTURES if f != seed]
        baseline = {}
        for candidate in candidates:
            content, _ = tag_similarity(list(seed[4]), list(candidate[4]))
            # Deliberately synthetic co-listening proxy, independent of the audio.
            collab = .95 - .06 * ((FIXTURES.index(candidate) + seed_index) % len(FIXTURES))
            baseline[candidate[0]] = blend(collab, content)
        def top(scores):
            return sorted(scores, key=lambda name: -(scores[name] if scores[name] is not None else -1))[:7]
        original = top(baseline)
        for weight in (0., .2, .4, 1.):
            scores = {name: experimental_blend(value, audio_similarity(vectors[seed[0]], vectors[name]), weight)
                      for name, value in baseline.items()}
            selected = top(scores)
            results.append({"seed": seed[0], "weight": weight, "baseline": original,
                            "selected": selected, "baseline_scores": baseline, "experimental_scores": scores, "membership_changed": set(original) != set(selected),
                            "replaced": len(set(original) - set(selected)), "order_changed": original != selected})
    return results


def run() -> dict:
    import_start = time.perf_counter()
    import librosa
    import numpy
    # Imports are lazy; the first extraction includes compilation and feature imports.
    import_seconds = time.perf_counter() - import_start
    with TemporaryDirectory(prefix="tunegraph-synthetic-") as directory:
        paths = {}
        for name, kind, freq, amp, _ in FIXTURES:
            paths[name] = Path(directory) / f"{name}.wav"
            generate_fixture(paths[name], kind, freq, amp)
        start = time.perf_counter()
        first = extract(paths["low"])
        cold_seconds = time.perf_counter() - start
        vectors, timings = {}, []
        for name, path in paths.items():
            start = time.perf_counter()
            vectors[name] = extract(path)
            timings.append(time.perf_counter() - start)
        missing = extract(Path(directory) / "missing.wav")
        corrupt = Path(directory) / "corrupt.wav"
        corrupt.write_bytes(b"not a wave file")
        failure_checks = {"missing_unknown": missing is None, "corrupt_unknown": extract(corrupt) is None,
                          "silence_unknown": vectors["silence"] is None,
                          "cold_warm_equal": first == vectors["low"]}
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # Installed package bytes, including unrelated environment packages: upper-bound proxy.
    package_bytes = sum(path.stat().st_size for dist in importlib.metadata.distributions()
                        for file in (dist.files or []) if (path := Path(dist.locate_file(file))).is_file())
    comparisons = compare(vectors)
    membership = {str(weight): {"expansions": len(FIXTURES),
                  "changed": sum(r["membership_changed"] for r in comparisons if r["weight"] == weight),
                  "share_changed": sum(r["membership_changed"] for r in comparisons if r["weight"] == weight) / len(FIXTURES)}
                  for weight in (0., .2, .4, 1.)}
    return {"environment": {"python": platform.python_version(), "platform": platform.platform(),
                            "librosa": librosa.__version__, "numpy": numpy.__version__},
            "duration_seconds": DURATION, "sample_rate": SAMPLE_RATE,
            "features": FEATURE_NAMES, "vectors": vectors, "failure_checks": failure_checks,
            "metrics": {"import_seconds": import_seconds, "first_extraction_seconds": cold_seconds,
                        "warm_median_seconds": statistics.median(timings), "warm_max_seconds": max(timings),
                        "warm_batch_seconds": sum(timings),
                        "peak_rss_bytes": rss if sys.platform == "darwin" else rss * 1024,
                        "installed_environment_bytes": package_bytes}, "comparisons": comparisons, "membership": membership}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = run()
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["metrics"], indent=2))


if __name__ == "__main__":
    main()
