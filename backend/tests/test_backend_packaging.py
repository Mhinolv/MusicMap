"""Exercise the setuptools discovery step used by CI's editable install."""
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


def test_editable_build_discovers_only_application(tmp_path):
    pytest.importorskip("setuptools", reason="requires the setuptools build backend")
    backend = Path(__file__).resolve().parents[1]
    shutil.copyfile(backend / "pyproject.toml", tmp_path / "pyproject.toml")
    for name in ("app", "experiments"):
        shutil.copytree(backend / name, tmp_path / name,
                        ignore=shutil.ignore_patterns("__pycache__"))
    result = subprocess.run(
        [sys.executable, "-c",
         "from setuptools.build_meta import get_requires_for_build_editable; "
         "get_requires_for_build_editable()"],
        cwd=tmp_path, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    packages = next(tmp_path.glob("*.egg-info/top_level.txt")).read_text().splitlines()
    assert packages == ["app"]
