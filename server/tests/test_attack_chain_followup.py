"""Pure tests for attack chain follow-up phase reindexing (no motor import)."""


def _reindex_phases(phases: list, offset: int) -> list:
    out = []
    for ph in phases:
        if not isinstance(ph, dict):
            continue
        raw_indices = ph.get("step_indices")
        if not isinstance(raw_indices, list):
            continue
        new_indices = [int(i) + offset for i in raw_indices if isinstance(i, int)]
        if not new_indices:
            continue
        out.append(
            {
                "phase": str(ph.get("phase") or "FOLLOWUP"),
                "label": str(ph.get("label") or "Follow-up"),
                "step_indices": new_indices,
            }
        )
    return out


def test_reindex_phases_offsets_step_indices():
    phases = [
        {"phase": "VULN", "label": "Follow-up: Vuln", "step_indices": [0, 1]},
    ]
    out = _reindex_phases(phases, offset=5)
    assert out[0]["step_indices"] == [5, 6]
