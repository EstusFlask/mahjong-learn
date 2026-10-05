"""Regression tests for Mortal's seat-private mjai event bridge."""
import os
import sys
from pathlib import Path

import numpy as np
import pytest

_WEB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _WEB_DIR not in sys.path:
    sys.path.insert(0, _WEB_DIR)

from game_manager import GameMode, MahjongEnvAdapter  # noqa: E402
import MahjongPyWrapper as pm  # noqa: E402

_REPO = Path(__file__).resolve().parents[2]
_MODEL = _REPO / "models" / "mortal_582500.pth"


def _new_adapter(seed, oya=0, yama=None):
    adapter = MahjongEnvAdapter(GameMode.FOUR_AI, seed=seed)
    if yama is None:
        adapter.reset_kyoku(
            oya=oya,
            game_wind="east",
            scores=[25000] * 4,
            kyoutaku=0,
            honba=0,
        )
    else:
        adapter.t = pm.Table()
        adapter.t.game_init_with_config(yama, [25000] * 4, 0, 0, 0, oya)
        adapter._start_mjai_hand()
    return adapter


def _ankan_wall(kokushi_responder=False):
    wall = np.random.default_rng(0).permutation(136).tolist()

    def assign(slots, tile_ids):
        for slot, tile_id in zip(slots, tile_ids):
            source = wall.index(tile_id)
            wall[slot], wall[source] = wall[source], wall[slot]

    assign(range(135, 131, -1), [108, 109, 110, 111])
    if kokushi_responder:
        responder_slots = [*range(131, 127, -1), *range(115, 111, -1),
                           *range(99, 95, -1), 86]
        kokushi_tiles = [0, 32, 36, 68, 72, 104, 112, 116, 120, 124, 128, 132, 69]
        assign(responder_slots, kokushi_tiles)
    return wall


def _daiminkan_wall():
    wall = np.random.default_rng(1).permutation(136).tolist()

    def assign(slots, tile_ids):
        for slot, tile_id in zip(slots, tile_ids):
            source = wall.index(tile_id)
            wall[slot], wall[source] = wall[source], wall[slot]

    assign([135], [108])
    assign([131, 130, 129], [109, 110, 111])
    return wall


def test_mjai_view_hides_opponent_hands_and_draws():
    adapter = _new_adapter(123)
    adapter.mjai_events.append({"type": "tsumo", "actor": 2, "pai": "9p"})

    view = adapter.mjai_events_for_player(1)
    start = next(event for event in view if event["type"] == "start_kyoku")
    assert len(start["tehais"][1]) == 13
    assert all(tile == "?" for pid, hand in enumerate(start["tehais"]) if pid != 1 for tile in hand)
    assert next(event for event in view if event.get("actor") == 0 and event["type"] == "tsumo")["pai"] == "?"
    assert view[-1]["pai"] == "?"
    assert adapter.mjai_events[-1]["pai"] == "9p"


def test_daiminkan_uses_called_tile_identity():
    adapter = _new_adapter(0, yama=_daiminkan_wall())
    event_start = len(adapter.mjai_events)
    adapter.step(0, 27)
    assert adapter.get_curr_player() == 1
    assert 46 in adapter.get_valid_actions(1)
    adapter.step(1, 46)

    emitted = adapter.mjai_events[event_start:]
    daiminkan = next(event for event in emitted if event["type"] == "daiminkan")
    assert daiminkan["actor"] == 1
    assert daiminkan["target"] == 0


def test_forced_self_pass_after_discard_does_not_block_next_turn():
    adapter = _new_adapter(123)
    action = next(index for index in adapter.get_valid_actions(0) if index <= 36)
    adapter.step(0, action)
    if adapter._riichi_stage2:
        adapter.step(0, 52)

    assert adapter.get_curr_player() != 0


def test_kakan_is_announced_before_robbery_and_not_duplicated():
    rng = np.random.default_rng(2)
    found = False
    for seed in range(3):
        adapter = _new_adapter(seed, oya=seed % 4)
        for _ in range(350):
            if adapter.is_over():
                break
            player = adapter.get_curr_player()
            valid = adapter.get_valid_actions(player)
            kans = [action for action in valid if action in (45, 46, 47)]
            action = int(rng.choice(kans if kans else valid))
            event_start = len(adapter.mjai_events)
            adapter.step(player, action)
            if action == 47:
                announced = adapter.mjai_events[event_start:]
                assert sum(event["type"] == "kakan" for event in announced) == 1
                for _ in range(4):
                    if adapter.is_over() or adapter.get_phase() < 8:
                        break
                    responder = adapter.get_curr_player()
                    response_actions = adapter.get_valid_actions(responder)
                    adapter.step(responder, 53 if 53 in response_actions else response_actions[0])
                resolved = adapter.mjai_events[event_start:]
                assert sum(event["type"] == "kakan" for event in resolved) == 1
                found = True
                break
            if adapter._riichi_stage2:
                adapter.step(
                    adapter.get_curr_player(),
                    int(rng.choice(adapter.get_valid_actions(adapter.get_curr_player()))),
                )
        if found:
            break
    assert found, "deterministic setup did not reach a kakan"


def test_ankan_dora_waits_until_robbery_window_resolves():
    adapter = _new_adapter(0, yama=_ankan_wall())
    assert 45 in adapter.get_valid_actions(0)
    event_start = len(adapter.mjai_events)
    adapter.step(0, 45)

    events = adapter.mjai_events[event_start:]
    ankan_index = next(i for i, event in enumerate(events) if event["type"] == "ankan")
    dora_index = next(i for i, event in enumerate(events)
                      if i > ankan_index and event["type"] == "dora")
    tsumo_index = next(i for i, event in enumerate(events)
                       if i > ankan_index and event["type"] == "tsumo")
    assert dora_index < tsumo_index


def test_ankan_robbed_by_kokushi_does_not_reveal_dora():
    adapter = _new_adapter(0, yama=_ankan_wall(kokushi_responder=True))
    assert 45 in adapter.get_valid_actions(0)
    event_start = len(adapter.mjai_events)
    adapter.step(0, 45)
    declared = adapter.mjai_events[event_start:]
    ankan_index = next(i for i, event in enumerate(declared) if event["type"] == "ankan")
    assert declared[-1]["type"] == "ankan"
    assert not any(event["type"] == "dora" for event in declared[ankan_index + 1:])
    assert 49 in adapter.get_valid_actions(1)
    adapter.step(1, 49)
    for _ in range(2):
        if adapter.is_over():
            break
        adapter.step(adapter.get_curr_player(), 53)

    events = adapter.mjai_events[event_start:]
    ankan_index = next(i for i, event in enumerate(events) if event["type"] == "ankan")
    assert any(event["type"] == "hora" for event in events[ankan_index + 1:])
    assert not any(event["type"] == "dora" for event in events[ankan_index + 1:])


def test_previous_kan_dora_precedes_next_kan_declaration():
    adapter = _new_adapter(0)
    before = {
        "hands": [[], [], [], []],
        "rivers": [[], [], [], []],
        "melds": [[], [], [], []],
        "riichi": [False] * 4,
        "dora": ["1m"],
        "turn": 0,
    }
    after = {**before, "dora": ["1m", "2m"]}
    adapter._capture_mjai_state = lambda: after
    adapter.is_over = lambda: False
    kakan = ({"type": "kakan", "actor": 0, "pai": "5m", "consumed": ["5m"] * 3},
             ("kakan", 0, frozenset({1, 2, 3}), 4))
    event_start = len(adapter.mjai_events)

    adapter._record_mjai_transition(before, announced_kan=kakan)

    assert [event["type"] for event in adapter.mjai_events[event_start:]] == ["dora", "kakan"]


@pytest.mark.parametrize(
    ("pai", "basetile", "action_idx", "chi_call"),
    [
        ("5mr", 4, 34, "4m"),
        ("5pr", 13, 35, "4p"),
        ("5sr", 22, 36, "4s"),
    ],
)
def test_red_tile_names_map_to_web_actions(pai, basetile, action_idx, chi_call):
    from mortal_ai import _map_mjai_action, _tile_action, _tile_info

    assert _tile_info(pai) == (basetile, True)
    assert _tile_action(pai) == action_idx

    valid = np.zeros(54, dtype=bool)
    valid[action_idx] = True
    assert _map_mjai_action({"type": "dahai", "pai": pai}, valid) == action_idx

    valid[:] = False
    valid[40] = True
    assert _map_mjai_action(
        {"type": "chi", "pai": chi_call, "consumed": [pai, f"6{pai[-2]}"]},
        valid,
    ) == 40

    valid[:] = False
    valid[44] = True
    assert _map_mjai_action({"type": "pon", "consumed": [pai, pai]}, valid) == 44


def test_mortal_q_values_rank_legal_actions_and_normalize_probabilities():
    from mortal_ai import _top_action_candidates

    adapter = _new_adapter(123)
    valid_mask = adapter.get_valid_actions_mask(0)
    action_indices = [idx for idx in range(37) if valid_mask[idx]][:3]
    assert len(action_indices) == 3
    mask_bits = sum(1 << idx for idx in action_indices)
    top = _top_action_candidates(
        adapter,
        0,
        {"mask_bits": mask_bits, "q_values": [1.0, 3.0, 2.0]},
        chosen_action_idx=action_indices[1],
        riichi=False,
    )

    assert [item["action_idx"] for item in top] == action_indices[1:2] + action_indices[2:3] + action_indices[:1]
    assert sum(item["probability"] for item in top) == pytest.approx(1.0)
    assert top[0]["probability"] > top[1]["probability"] > top[2]["probability"]


def test_top_actions_omit_candidates_illegal_in_web_engine():
    from mortal_ai import _top_action_candidates

    adapter = _new_adapter(123)
    valid_mask = adapter.get_valid_actions_mask(0)
    valid_actions = [idx for idx in range(37) if valid_mask[idx]][:2]
    invalid_action = next(idx for idx in range(37) if not valid_mask[idx])
    scores = {invalid_action: 4.0, valid_actions[0]: 3.0, valid_actions[1]: 2.0}
    action_indices = sorted(scores)
    top = _top_action_candidates(
        adapter,
        0,
        {
            "mask_bits": sum(1 << idx for idx in action_indices),
            "q_values": [scores[idx] for idx in action_indices],
        },
        chosen_action_idx=valid_actions[0],
        riichi=False,
    )

    assert [item["action_idx"] for item in top] == valid_actions
    assert sum(item["probability"] for item in top) < 1.0


def test_forced_riichi_confirmation_has_no_q_probability():
    from mortal_ai import mortal_advice

    adapter = _new_adapter(123)
    adapter._riichi_stage2 = True
    advice = mortal_advice(adapter, 0, "mortal_582500.pth")

    assert advice["top_actions"][0]["action_idx"] == 48
    assert advice["top_actions"][0]["probability"] is None


def test_mortal_call_action_indices_map_to_web_variants():
    from mortal_ai import _mortal_action_to_web_index

    valid = np.zeros(54, dtype=bool)
    for mortal_idx, web_idx in ((38, 40), (39, 41), (40, 42)):
        valid[:] = False
        valid[web_idx] = True
        assert _mortal_action_to_web_index(mortal_idx, valid, chosen_action_idx=web_idx) == web_idx

    valid[:] = False
    valid[44] = True
    assert _mortal_action_to_web_index(41, valid, chosen_action_idx=44) == 44


@pytest.mark.skipif(not _MODEL.exists(), reason="no local Mortal checkpoint")
def test_mortal_advice_returns_a_legal_action():
    from mortal_ai import mortal_advice

    adapter = _new_adapter(123)
    advice = mortal_advice(adapter, 0, str(_MODEL))
    assert adapter.get_valid_actions_mask(0)[advice["action_idx"]]
    assert 1 <= len(advice["top_actions"]) <= 3
    assert advice["top_actions"][0]["label"] == advice["label"]
    assert all(item["probability"] is None or 0 <= item["probability"] <= 1
               for item in advice["top_actions"])
    if advice["tile_id"] is not None:
        assert any(int(tile.id) == advice["tile_id"] for tile in adapter.t.players[0].hand)
