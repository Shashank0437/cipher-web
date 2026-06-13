"""Step-index driver for sequential attack chains (no motor)."""

from app.services.agent_attack_chains import (
    attack_chain_effective_step_index,
    attack_chain_followup_log_line,
    attack_chain_next_step_index,
    attack_chain_next_tool_only,
    attack_chain_tool_at_index,
)


def _sess(steps: list[dict], *, current_step: int | None = None, sequential: bool = True) -> dict:
    ac: dict = {"sequential": sequential, "steps": steps}
    if current_step is not None:
        ac["current_step"] = current_step
    return {"attack_chain": ac}


def test_next_step_index_after_three_completed():
    steps = [{"tool": t} for t in [
        "nmap", "httpx", "ffuf", "arjun", "dalfox", "jaeles", "nuclei", "wpscan",
    ]]
    sess = _sess(steps, current_step=3)
    idx = attack_chain_next_step_index(sess, [])
    assert idx == 3
    assert attack_chain_tool_at_index(sess, idx) == "arjun"
    only = attack_chain_next_tool_only(sess, [])
    assert only == frozenset({"arjun"})


def test_effective_step_index_uses_stored_current_step():
    steps = [{"tool": "nmap"}, {"tool": "httpx"}]
    sess = _sess(steps, current_step=1)
    assert attack_chain_effective_step_index(sess, []) == 1


def test_duplicate_tool_names_do_not_skip_by_name_only():
    """Second nmap step must not jump to httpx when only one nmap completed in messages."""
    steps = [{"tool": "nmap"}, {"tool": "nmap"}, {"tool": "httpx"}]
    sess = _sess(steps, current_step=1)
    rows = [{"role": "tool", "tool_name": "nmap"}]
    idx = attack_chain_next_step_index(sess, rows)
    assert idx == 1
    assert attack_chain_tool_at_index(sess, idx) == "nmap"


def test_legacy_sessions_infer_step_from_rows():
    steps = [{"tool": "nmap"}, {"tool": "httpx"}, {"tool": "ffuf"}]
    sess = _sess(steps)
    rows = [
        {"role": "tool", "tool_name": "nmap"},
        {"role": "tool", "tool_name": "httpx"},
    ]
    assert attack_chain_effective_step_index(sess, rows) == 2
    assert attack_chain_next_step_index(sess, rows) == 2
    assert attack_chain_tool_at_index(sess, 2) == "ffuf"


def test_followup_log_line_format():
    steps = [{"tool": t} for t in ["nmap", "httpx", "ffuf", "arjun"]]
    sess = _sess(steps, current_step=3)
    line = attack_chain_followup_log_line(
        sess,
        [],
        schemas_offered=["arjun"],
        batch_only=frozenset({"arjun"}),
    )
    assert "attack_chain_followup:" in line
    assert "next=arjun" in line
    assert "schemas_offered=['arjun']" in line
    assert "batch_only=['arjun']" in line


def test_non_sequential_returns_none():
    sess = _sess([{"tool": "nmap"}], sequential=False)
    assert attack_chain_next_step_index(sess, []) is None
    assert attack_chain_next_tool_only(sess, []) is None
