"""Shared test setup."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _no_live_itunes(monkeypatch):
    # The iTunes provider needs no key, so it is on by default. Tests turn it on only
    # with a mocked transport; no test may call the real API.
    monkeypatch.setenv("ITUNES_PREVIEWS", "0")
