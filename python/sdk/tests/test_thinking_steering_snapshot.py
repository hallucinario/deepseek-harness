"""Project reasoning interruption and same-turn continuation through the real Python SDK."""
from __future__ import annotations

import runpy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "apps" / "cli" / "lib" / "bin.js"
SMOKE = runpy.run_path(ROOT / "scripts" / "smoke-python-runtime.py")


@pytest.mark.skipif(not CLI.exists(), reason="requires the built dsh profile runtime")
def test_thinking_steering_snapshot() -> None:
    SMOKE["smoke_sdk_steer_thinking"](CLI, False)
