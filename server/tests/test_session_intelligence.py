import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.session_intelligence import derive_session_intelligence, merge_execution_windows


def dt(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def test_parallel_tool_windows_count_once():
    seconds = merge_execution_windows(
        [
            (dt("2026-05-19T00:00:00+00:00"), dt("2026-05-19T00:03:00+00:00")),
            (dt("2026-05-19T00:00:30+00:00"), dt("2026-05-19T00:03:00+00:00")),
            (dt("2026-05-19T00:05:00+00:00"), dt("2026-05-19T00:07:00+00:00")),
        ],
    )
    assert seconds == 300


def test_successful_tool_creates_intelligence_and_counts_info_once():
    session = {"_id": "abc123", "title": "run httpx", "created_at": dt("2026-05-19T00:00:00+00:00")}
    rows = [
        {
            "_id": "m1",
            "role": "assistant",
            "created_at": dt("2026-05-19T00:00:01+00:00"),
            "tool_call": {
                "state": "confirmed",
                "tool_name": "httpx",
                "arguments": {"target": "jio.com"},
                "run_status": "done",
                "run_started_at": "2026-05-19T00:00:01+00:00",
                "run_finished_at": "2026-05-19T00:00:04+00:00",
                "result_text": '{"_llm_summary":{"stdout_nonempty_lines":1},"raw":"https://jio.com [301]"}',
                "execution_log_tail": "STDOUT: https://jio.com [301]",
            },
        },
    ]

    intel = derive_session_intelligence(session, rows)

    assert intel is not None
    assert intel["status"] == "COMPLETED"
    assert intel["findings_count"]["info"] == 1
    assert intel["findings_count"]["total"] == 1
    assert intel["average_time_to_breach"] == "0m 03s"
    assert intel["targets"] == ["jio.com"]


def test_partial_failure_does_not_fail_successful_session():
    session = {"_id": "abc123", "title": "batch", "created_at": dt("2026-05-19T00:00:00+00:00")}
    rows = [
        {
            "_id": "m1",
            "role": "assistant",
            "created_at": dt("2026-05-19T00:00:01+00:00"),
            "tool_calls": [
                {
                    "slot_index": 0,
                    "tool_name": "nmap",
                    "arguments": {"target": "https://jio.com"},
                    "run_status": "done",
                    "execution_outcome": "completed",
                    "run_started_at": "2026-05-19T00:00:01+00:00",
                    "run_finished_at": "2026-05-19T00:00:11+00:00",
                    "result_text": '{"raw":"open ports discovered"}',
                    "execution_log_tail": "STDOUT: open ports discovered",
                },
                {
                    "slot_index": 1,
                    "tool_name": "amass",
                    "arguments": {"domain": "jio.com"},
                    "run_status": "error",
                    "execution_outcome": "error",
                    "run_started_at": "2026-05-19T00:00:01+00:00",
                    "run_finished_at": "2026-05-19T00:00:05+00:00",
                    "result_text": '{"error":"timeout"}',
                    "execution_log_tail": "ERROR: timeout",
                },
            ],
        },
    ]

    intel = derive_session_intelligence(session, rows)

    assert intel is not None
    assert intel["status"] == "COMPLETED"
    assert intel["tools_used"] == ["nmap", "amass"]
    assert intel["findings_count"]["total"] == 1


def test_ai_findings_require_evidence_and_are_deduped():
    session = {"_id": "abc123", "title": "nuclei", "created_at": dt("2026-05-19T00:00:00+00:00")}
    rows = [
        {
            "_id": "m1",
            "role": "assistant",
            "created_at": dt("2026-05-19T00:00:01+00:00"),
            "tool_call": {
                "state": "confirmed",
                "tool_name": "nuclei",
                "arguments": {"target": "https://example.test"},
                "run_status": "done",
                "run_started_at": "2026-05-19T00:00:01+00:00",
                "run_finished_at": "2026-05-19T00:00:03+00:00",
                "result_text": '{"raw":"SQL injection template matched /api/search"}',
                "execution_log_tail": "STDOUT: SQL injection template matched /api/search",
            },
        },
    ]
    ai = {
        "title": "SQL injection validation",
        "summary": "Validated one SQL injection finding.",
        "findings": [
            {
                "name": "SQL Injection in search endpoint",
                "severity": "CRITICAL",
                "details": "Template matched the search endpoint.",
                "source_tool": "nuclei",
                "affected_target": "/api/search",
                "evidence": "SQL injection template matched /api/search",
                "first_seen": "2026-05-19T00:00:03+00:00",
            },
            {
                "name": "Invented SSRF",
                "severity": "HIGH",
                "details": "No evidence.",
                "source_tool": "nuclei",
                "affected_target": "/metadata",
                "evidence": "metadata service exposed",
                "first_seen": "2026-05-19T00:00:03+00:00",
            },
        ],
    }

    intel = derive_session_intelligence(session, rows, ai_payload=ai)

    assert intel is not None
    names = {f["name"] for f in intel["findings"]}
    assert "SQL Injection in search endpoint" in names
    assert "Invented SSRF" not in names
    assert intel["findings_count"]["critical"] == 1
