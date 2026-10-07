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


def _wall_for_response_action(response_tiles, discard_tile):
    wall = [None] * 136
    player_one_slots = (
        list(range(131, 127, -1))
        + list(range(115, 111, -1))
        + list(range(99, 95, -1))
        + [86]
    )
    reserved_ids = set(response_tiles) | {discard_tile}
    for slot, tile_id in zip(player_one_slots, response_tiles):
        wall[slot] = tile_id
    wall[83] = discard_tile

    unused_ids = [tile_id for tile_id in range(136) if tile_id not in reserved_ids]
    for slot in player_one_slots:
        if wall[slot] is None:
            tile_index = next(
                i for i, tile_id in enumerate(unused_ids)
                if tile_id // 4 < 9 or tile_id // 4 >= 18
            )
            wall[slot] = unused_ids.pop(tile_index)
    for slot in range(136):
        if wall[slot] is None:
            wall[slot] = unused_ids.pop()
    return wall


def _response_table(response_tiles, discard_tile):
    table = pm.Table()
    table.game_init_with_config(
        _wall_for_response_action(response_tiles, discard_tile),
        [25000] * 4, 0, 0, 0, 0,
    )
    discard_base = discard_tile // 4
    discard_selection = table.get_selection_from_action_basetile(
        pm.BaseAction.Discard, [discard_base], False,
    )
    assert discard_selection >= 0
    table.make_selection(discard_selection)
    table.make_selection(0)  # P0 passes so P1's response becomes active.
    return table


def _response_mask(table):
    mask = np.zeros(54, dtype=np.int8)
    pm.encv1_encode_action(table, 1, mask)
    return mask.astype(bool)


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


@pytest.mark.parametrize(
    ("response_tiles", "discard_tile", "expected_chi", "expected_pon"),
    [
        ([40, 44], 48, {39}, set()),
        ([44, 52], 48, {41}, set()),
        ([44, 52, 53], 48, {38, 41}, set()),
        ([54, 55], 53, set(), {43}),
        ([52, 54], 53, set(), {44}),
        ([52, 54, 55], 53, set(), {43, 44}),
    ],
)
def test_response_action_mask_only_exposes_real_red_choices(
    response_tiles, discard_tile, expected_chi, expected_pon,
):
    table = _response_table(response_tiles, discard_tile)
    mask = _response_mask(table)

    assert {idx for idx in range(37, 43) if mask[idx]} == expected_chi
    assert {idx for idx in (43, 44) if mask[idx]} == expected_pon


@pytest.mark.parametrize(
    ("response_tiles", "use_red", "expected_red"),
    [
        ([44, 53], False, False),
        ([44, 52], True, True),
    ],
)
def test_chi_action_resolution_matches_the_selected_red_variant(
    response_tiles, use_red, expected_red,
):
    table = _response_table(response_tiles, 48)
    selection = table.get_selection_from_action_basetile(
        pm.BaseAction.Chi, [pm.BaseTile._3p, pm.BaseTile._5p], use_red,
    )

    assert selection >= 0
    action = table.get_response_actions()[selection]
    assert any(bool(tile.red_dora) for tile in action.correspond_tiles) is expected_red
    opposite_selection = table.get_selection_from_action_basetile(
        pm.BaseAction.Chi, [pm.BaseTile._3p, pm.BaseTile._5p], not use_red,
    )
    assert opposite_selection == -1


def test_pon_action_resolution_matches_the_selected_red_variant():
    table = _response_table([52, 54, 55], 53)
    actions = table.get_response_actions()
    normal_selection = table.get_selection_from_action_basetile(
        pm.BaseAction.Pon, [pm.BaseTile._5p, pm.BaseTile._5p], False,
    )
    red_selection = table.get_selection_from_action_basetile(
        pm.BaseAction.Pon, [pm.BaseTile._5p, pm.BaseTile._5p], True,
    )

    assert normal_selection >= 0
    assert red_selection >= 0
    assert not any(bool(tile.red_dora) for tile in actions[normal_selection].correspond_tiles)
    assert any(bool(tile.red_dora) for tile in actions[red_selection].correspond_tiles)


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
