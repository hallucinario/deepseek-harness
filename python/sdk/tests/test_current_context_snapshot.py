"""Expose current-only runtime context and logged replacements through the Python SDK."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "apps" / "cli" / "lib" / "bin.js"
SCENARIO = ROOT / "snapshots" / "sdk" / "current-context"
EXPECTED = Path(__file__).parent / "expected" / "current-context.json"


@pytest.mark.skipif(not CLI.exists(), reason="requires the built dsh profile runtime")
def test_current_context_snapshot(tmp_path: Path) -> None:
    replay = tmp_path / "replay.patch.json"
    replay.write_text(json.dumps([
        {"id": "llm-deepseek", "disabled": True},
        {"id": "session-log-deepseek", "config": {"enabled": False}},
        {"insert": [{"id": "llm-replay", "name": str(ROOT / "packages/test-support/llm-replay/lib/index.js"),
                     "config": {"providers": [{"id": "deepseek-official", "name": "DeepSeek",
                                                "models": [{"id": "deepseek-v4-flash"}]}]}}]},
    ]))
    patches = (
        ROOT / "snapshots" / "sdk" / "bash-tool" / "cordis.yml",
        replay,
        SCENARIO / "runtime.cordis.yml",
    )
    with DeepSeekHarness(
        provider="deepseek-official",
        model="deepseek-v4-flash",
        cwd=str(tmp_path),
        dsh_bin=str(CLI),
        dsh_home=str(tmp_path / ".dsh"),
        patches=tuple(str(path) for path in patches),
        env={
            "DSH_SNAPSHOT": "replay",
            "DSH_SNAPSHOT_FILE": str(SCENARIO / "session.v4.jsonl"),
            "DSH_TELEMETRY_DISABLED": "1",
        },
        request_timeout_seconds=60,
    ) as harness:
        session = harness.start_session("python-current-context")
        first = session.run("Reply with exactly the word: ONE. No tools.")
        second = session.run("Reply with exactly the word: TWO. No tools.")
        replay_diagnostics = [line for line in harness.client._stderr_lines if "llm-replay" in line]

    events = [*first.events, *second.events]
    endings = [event["data"]["reason"] for event in events if event["type"] == "turn/end"]
    assert [reason["kind"] for reason in endings] == ["completed", "completed"], (endings, replay_diagnostics)
    contexts = []
    for event in events:
        if event["type"] != "user/message":
            continue
        source = event["data"]["source"]
        if source["kind"] != "runtime-context" or source.get("form") != "snapshot":
            continue
        sections = source["sections"]
        contexts.append({
            "operation": "append" if event.get("surfaceOp") == "append" else "replace",
            "current": [section["text"] for section in sections if section.get("retention") == "current"],
            "history": [section["name"] for section in sections if section.get("retention") != "current"],
        })
    actual = {
        "responses": [first.final_response, second.final_response],
        "markers": sum(event["type"] == "runtime-context/current-enabled" for event in events),
        "contexts": contexts,
    }
    assert actual == json.loads(EXPECTED.read_text())
