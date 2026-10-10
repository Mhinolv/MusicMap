"""Default tests use stdlib only; extraction tests require the acoustic extra."""
import math
import wave

import pytest

from experiments.acoustic_similarity import (
    DURATION, SAMPLE_RATE, FIXTURES, audio_similarity, compare,
    experimental_blend, extract, generate_fixture,
)


@pytest.mark.parametrize("kind", ["tone", "pulse", "noise"])
@pytest.mark.parametrize("duration", [1 / SAMPLE_RATE, DURATION])
def test_synthetic_generation_bounded_and_repeatable(tmp_path, kind, duration):
    a, b = tmp_path / "a.wav", tmp_path / "b.wav"
    generate_fixture(a, kind, 220, .3, duration)
    generate_fixture(b, kind, 220, .3, duration)
    assert a.read_bytes() == b.read_bytes()
    with wave.open(str(a)) as wav:
        assert wav.getparams()[:4] == (1, 2, SAMPLE_RATE, round(duration * SAMPLE_RATE))


@pytest.mark.parametrize("kwargs", [dict(kind="unknown"), dict(duration=0),
    dict(duration=31), dict(amplitude=-.1), dict(amplitude=1.1),
    dict(frequency=-1), dict(frequency=4000)])
def test_invalid_generation_rejected(tmp_path, kwargs):
    args = dict(kind="tone", frequency=220, amplitude=.3)
    args.update(kwargs)
    with pytest.raises(ValueError):
        generate_fixture(tmp_path / "invalid.wav", **args)


@pytest.mark.parametrize("weight", [0, .2, .4, 1])
def test_blend_fallbacks_and_endpoints(weight):
    assert experimental_blend(.8, None, weight) == .8
    assert experimental_blend(None, None, weight) is None
    assert experimental_blend(None, .2, weight) == (.2 if weight else None)
    assert experimental_blend(.8, .2, weight) == pytest.approx((1-weight)*.8 + weight*.2)


@pytest.mark.parametrize("weight", [-1, 1.1, float("nan")])
def test_invalid_weight(weight):
    with pytest.raises(ValueError):
        experimental_blend(.8, .2, weight)


def test_distance_identity_bounds_and_missing():
    assert audio_similarity((0, 0, 0, 0), (0, 0, 0, 0)) == 1
    assert audio_similarity((0, 0, 0, 0), (1, 1, 1, 1)) == 0
    assert audio_similarity(None, (0, 0, 0, 0)) is None
    with pytest.raises(ValueError):
        audio_similarity((0,), (0,))


def test_membership_compares_sets_and_missing_keeps_baseline():
    rows = compare({f[0]: None for f in FIXTURES})
    assert len(rows) == 40
    for row in rows:
        assert len(row["selected"]) == 7
        assert row["selected"] == row["baseline"]
        assert row["membership_changed"] is False
        assert row["replaced"] == 0


def test_membership_changes_measured_separately_from_order():
    vectors = {f[0]: (i / 10,) * 4 for i, f in enumerate(FIXTURES)}
    rows = compare(vectors)
    assert any(r["membership_changed"] for r in rows if r["weight"] == 1)
    for row in rows:
        assert row["membership_changed"] == (set(row["baseline"]) != set(row["selected"]))
        assert row["replaced"] == len(set(row["baseline"]) - set(row["selected"]))
        if row["weight"] == 0:
            assert row["baseline"] == row["selected"]


@pytest.fixture
def acoustic_deps():
    pytest.importorskip("librosa", reason="install backend .[acoustic] for optional extraction tests")
    pytest.importorskip("numpy")


@pytest.mark.parametrize("kind", ["tone", "pulse", "noise"])
@pytest.mark.parametrize("duration", [1 / SAMPLE_RATE, DURATION])
def test_optional_extraction(tmp_path, acoustic_deps, kind, duration):
    path = tmp_path / "fixture.wav"
    generate_fixture(path, kind, 220, .3, duration)
    vector = extract(path)
    # A one-sample tone/pulse starts at zero: correctly classified as silence.
    if duration == 1 / SAMPLE_RATE and kind != "noise":
        assert vector is None
    else:
        assert vector is not None
        assert len(vector) == 4
        assert all(math.isfinite(v) and 0 <= v <= 1 for v in vector)
        assert extract(path) == vector


def test_optional_bad_audio_is_unknown(tmp_path, acoustic_deps):
    assert extract(tmp_path / "missing.wav") is None
    corrupt = tmp_path / "corrupt.wav"
    corrupt.write_bytes(b"corrupt")
    assert extract(corrupt) is None
    silence = tmp_path / "silence.wav"
    generate_fixture(silence, "tone", 0, 0)
    assert extract(silence) is None
    unsupported = tmp_path / "stereo.wav"
    with wave.open(str(unsupported), "wb") as wav:
        wav.setparams((2, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
        wav.writeframes(b"\x01\x00" * 20)
    assert extract(unsupported) is None
    truncated = tmp_path / "truncated.wav"
    generate_fixture(truncated, "tone", 220, .3, .1)
    truncated.write_bytes(truncated.read_bytes()[:-10])
    assert extract(truncated) is None
