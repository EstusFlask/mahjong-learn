"""Regression tests for frontend state JSON serialization."""
import json
import os
import sys
import threading
from types import SimpleNamespace

import numpy as np
import pytest

_WEB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _WEB_DIR not in sys.path:
    sys.path.insert(0, _WEB_DIR)

import MahjongPyWrapper as pm  # noqa: E402
from game_manager import GameMode, MahjongEnvAdapter, build_state  # noqa: E402
import verbose_log  # noqa: E402


def _wall_for_first_turn_daiminkan():
    wall = np.random.default_rng(1).permutation(136).tolist()
    for slot, tile_id in zip([135, 131, 130, 129], [108, 109, 110, 111]):
        source = wall.index(tile_id)
        wall[slot], wall[source] = wall[source], wall[slot]
    return wall


def test_state_with_open_meld_is_json_serializable():
    adapter = MahjongEnvAdapter(GameMode.FOUR_AI, seed=0)
    adapter.t = pm.Table()
    adapter.t.game_init_with_config(
        _wall_for_first_turn_daiminkan(), [25000] * 4, 0, 0, 0, 0,
    )
    adapter._start_mjai_hand()

    adapter.step(0, 27)
    assert 46 in adapter.get_valid_actions(1)
    adapter.step(1, 46)

    state = build_state(adapter, SimpleNamespace(snapshot=lambda: {}))

    assert isinstance(state["players"][1]["calls"][0]["type"], str)
    json.dumps(state)


def test_state_includes_exact_riichi_discard_choices(monkeypatch):
    adapter = MahjongEnvAdapter(GameMode.HUMAN_AI, seed=0)
    adapter.reset_kyoku(
        oya=0,
        game_wind="east",
        scores=[25000] * 4,
        kyoutaku=0,
        honba=0,
    )
    tile = adapter.t.players[0].hand[0]
    discard = adapter._discard_index(tile)
    mask = np.zeros(54, dtype=bool)
    mask[discard] = True
    mask[48] = True
    monkeypatch.setattr(adapter, "get_valid_actions_mask", lambda _: mask)
    monkeypatch.setattr(adapter, "_riichi_discard_indices", lambda: [discard])

    state = build_state(adapter, SimpleNamespace(snapshot=lambda: {}))

    assert state["riichi_discards"] == [discard]
    json.dumps(state)


def test_riichi_choices_keep_red_and_normal_fives_distinct():
    adapter = MahjongEnvAdapter(GameMode.HUMAN_AI, seed=0)
    normal_five = SimpleNamespace(tile=pm.BaseTile._5m, red_dora=False)
    red_five = SimpleNamespace(tile=pm.BaseTile._5m, red_dora=True)
    actions = [
        SimpleNamespace(action=pm.BaseAction.Riichi, correspond_tiles=[normal_five]),
        SimpleNamespace(action=pm.BaseAction.Riichi, correspond_tiles=[red_five]),
    ]
    adapter.t = SimpleNamespace(get_self_actions=lambda: actions)

    assert adapter._riichi_discard_indices() == [4, 34]


def test_kan_choice_resolves_the_selected_candidate():
    adapter = MahjongEnvAdapter(GameMode.HUMAN_AI, seed=0)
    actions = [
        SimpleNamespace(action=pm.BaseAction.AnKan,
                         correspond_tiles=[SimpleNamespace(tile=pm.BaseTile._5m)]),
        SimpleNamespace(action=pm.BaseAction.AnKan,
                         correspond_tiles=[SimpleNamespace(tile=pm.BaseTile._7p)]),
    ]
    adapter.t = SimpleNamespace(
        get_self_actions=lambda: actions,
        get_selected_action_tile=lambda: None,
    )

    assert adapter._resolve_action(0, 45, choice_tile=15) == (
        pm.BaseAction.AnKan, [15] * 4, False,
    )
    with pytest.raises(ValueError, match="No matching AnKan candidate"):
        adapter._resolve_action(0, 45, choice_tile=7)


def test_session_logger_close_does_not_deadlock(tmp_path, monkeypatch):
    monkeypatch.setattr(verbose_log, "LOG_DIR", tmp_path)
    logger = verbose_log.SessionLogger("close-test", "human_ai", 0, 0)
    close_thread = threading.Thread(target=logger.close, daemon=True)

    close_thread.start()
    close_thread.join(timeout=2)

    assert not close_thread.is_alive()
    records = [json.loads(line) for line in (tmp_path / "close-test.ndjson").read_text().splitlines()]
    assert records[-1]["kind"] == "session_close"
