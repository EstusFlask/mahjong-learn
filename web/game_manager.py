"""
Game session manager for the mahjong web server.

Wraps MahjongPyWrapper.Table directly (no MahjongEnv detour) and provides:
- A clean state serialization for the front-end (one JSON snapshot)
- Action validation + index→C++ selection resolution (incl. riichi 2-step)
- Multi-kyoku (hansou) loop via HansouSession
"""
from __future__ import annotations

import threading
import time
import uuid
import copy
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import numpy as np
import MahjongPyWrapper as pm

from hansou import HansouSession
from verbose_log import SessionLogger


class GameMode(str, Enum):
    HUMAN_AI = "human_ai"
    FOUR_AI = "4ai"


# ─── Tile / action helpers ────────────────────────────────────────────────────

_BASETILE_NAMES_Z = ("1z", "2z", "3z", "4z", "5z", "6z", "7z")


def basetile_to_str(bt: int) -> str:
    if bt < 9:
        return f"{bt + 1}m"
    if bt < 18:
        return f"{bt - 9 + 1}p"
    if bt < 27:
        return f"{bt - 18 + 1}s"
    return _BASETILE_NAMES_Z[bt - 27]


def basetile_to_zh(bt: int) -> str:
    """Display label like '5万' for logs."""
    if bt < 9:
        return f"{bt + 1}万"
    if bt < 18:
        return f"{bt - 9 + 1}饼"
    if bt < 27:
        return f"{bt - 18 + 1}索"
    names = ("东", "南", "西", "北", "白", "发", "中")
    return names[bt - 27]


# ─── Action index ↔ BaseAction mapping (matches encv1, see TrainingDataEncodingV1.cpp) ─
#   0..33  : Discard basetile i (no red)
#   34     : Discard red 5m
#   35     : Discard red 5p
#   36     : Discard red 5s
#   37     : Chi left
#   38     : Chi middle
#   39     : Chi right
#   40..42 : Chi left/middle/right (use red dora)
#   43     : Pon
#   44     : Pon (use red)
#   45     : AnKan
#   46     : Minkan (Kan response)
#   47     : KaKan
#   48     : Riichi (confirm)
#   49     : Ron / ChanKan / ChanAnKan
#   50     : Tsumo
#   51     : Kyushukyuhai
#   52     : Pass riichi (cancel)
#   53     : Pass response

DISCARD_RED_BASE = 34   # 34,35,36 = red5 of m/p/s
CHILEFT, CHIMIDDLE, CHIRIGHT = 37, 38, 39
CHILEFT_R, CHIMID_R, CHIRIGHT_R = 40, 41, 42
PON, PON_USERED = 43, 44
ANKAN, MINKAN, KAKAN = 45, 46, 47
RIICHI = 48
RON = 49
TSUMO = 50
KYUSHU = 51
PASS_RIICHI = 52
PASS_RESPONSE = 53

_CHI_SET = {CHILEFT, CHIMIDDLE, CHIRIGHT, CHILEFT_R, CHIMID_R, CHIRIGHT_R}
_MJAI_HONORS = ("E", "S", "W", "N", "P", "F", "C")
_MJAI_WINDS = ("E", "S", "W", "N")


def _tile_to_mjai(tile) -> str:
    bt = int(tile.tile)
    if bool(tile.red_dora):
        return {4: "5mr", 13: "5pr", 22: "5sr"}[bt]
    if bt < 9:
        return f"{bt + 1}m"
    if bt < 18:
        return f"{bt - 8}p"
    if bt < 27:
        return f"{bt - 17}s"
    return _MJAI_HONORS[bt - 27]


class MahjongEnvAdapter:
    """Thin wrapper over pm.Table that drives one kyoku at a time and supports reset."""

    def __init__(self, mode: GameMode, seed: Optional[int] = None):
        self.mode = mode
        self.base_seed = seed
        self.t: pm.Table = pm.Table()
        self._riichi_stage2 = False
        self._may_riichi_tile_id: Optional[int] = None
        self._mutation_version = 0
        # Lifecycle callbacks (post-reset_kyoku and post-step).
        self._on_kyoku_start_cbs: list = []
        self._on_step_cbs: list = []
        self.mjai_events: list[dict] = []
        self._pending_mjai_melds: set[tuple] = set()
        self._pending_mjai_dora: Optional[tuple[tuple, list[dict]]] = None

    # ─── Callback registration ───────────────────────────────────────────────

    def add_on_kyoku_start(self, cb) -> None:
        """Register a no-arg callback fired after each ``reset_kyoku``."""
        self._on_kyoku_start_cbs.append(cb)

    def add_on_step(self, cb) -> None:
        """Register a no-arg callback fired after each successful ``step``."""
        self._on_step_cbs.append(cb)

    def clear_callbacks(self) -> None:
        self._on_kyoku_start_cbs.clear()
        self._on_step_cbs.clear()

    def _fire_kyoku_start(self) -> None:
        for cb in self._on_kyoku_start_cbs:
            try:
                cb()
            except Exception:  # noqa: BLE001
                pass  # don't let AI bookkeeping break the engine loop

    def _fire_on_step(self) -> None:
        for cb in self._on_step_cbs:
            try:
                cb()
            except Exception:  # noqa: BLE001
                pass

    # ─── Lifecycle ───────────────────────────────────────────────────────────

    def reset_kyoku(
        self,
        *,
        oya: int,
        game_wind: str,
        scores: list,
        kyoutaku: int,
        honba: int,
        seed: Optional[int] = None,
    ) -> None:
        """Initialize the C++ Table for a fresh kyoku."""
        wind_idx = ("east", "south", "west", "north").index(game_wind)
        self.t = pm.Table()
        if seed is None and self.base_seed is not None:
            seed = self.base_seed + (oya * 4 + wind_idx) * 31  # deterministic per kyoku
        if seed is not None:
            self.t.set_seed(seed)
        self.t.game_init_with_config(
            [],          # random yama
            list(scores),
            int(kyoutaku),
            int(honba),
            wind_idx,
            int(oya),
        )
        self._riichi_stage2 = False
        self._may_riichi_tile_id = None
        self._pending_mjai_melds.clear()
        self._pending_mjai_dora = None
        self._auto_skip_pass()
        self._start_mjai_hand()
        self._fire_kyoku_start()

    def _start_mjai_hand(self) -> None:
        hands = [[_tile_to_mjai(tile) for tile in player.hand] for player in self.t.players]
        dealer = int(self.t.oya)
        dealer_draw = None
        if len(hands[dealer]) == 14:
            dealer_draw = hands[dealer].pop()
        if any(len(hand) != 13 for hand in hands):
            raise RuntimeError("Mahjong engine did not deal 13 tiles to each player")

        self.mjai_events = [
            {"type": "start_game", "names": ["P0", "P1", "P2", "P3"]},
            {
                "type": "start_kyoku",
                "bakaze": _MJAI_WINDS[int(self.t.game_wind)],
                "kyoku": dealer + 1,
                "honba": int(self.t.honba),
                "kyotaku": int(self.t.riichibo),
                "oya": dealer,
                "scores": [int(player.score) for player in self.t.players],
                "dora_marker": _tile_to_mjai(self.t.dora_indicator[0]),
                "tehais": hands,
            },
        ]
        if dealer_draw is not None:
            self.mjai_events.append({"type": "tsumo", "actor": dealer, "pai": dealer_draw})

    def mjai_events_for_player(self, player_id: int) -> list[dict]:
        """Return an mjai event tape with private tiles hidden from this seat."""
        events = copy.deepcopy(self.mjai_events)
        if len(events) > 1 and events[1].get("type") == "start_kyoku":
            events[1]["tehais"] = [
                hand if pid == player_id else ["?"] * 13
                for pid, hand in enumerate(events[1]["tehais"])
            ]
        for event in events:
            if event.get("type") == "tsumo" and event.get("actor") != player_id:
                event["pai"] = "?"
        return events

    def _announced_kan(self, player_id: int, action_idx: int):
        """Build a kan event at declaration time, before a robbery response."""
        if action_idx not in (ANKAN, KAKAN):
            return None

        expected = pm.BaseAction.AnKan if action_idx == ANKAN else pm.BaseAction.KaKan
        action = next((
            action for action in self.t.get_self_actions()
            if action.action == expected and action.correspond_tiles
        ), None)
        if action is None:
            return None

        tile = action.correspond_tiles[0]
        base = int(tile.tile)
        if action_idx == ANKAN:
            consumed = [t for t in self.t.players[player_id].hand if int(t.tile) == base]
            if len(consumed) != 4:
                return None
            signature = ("ankan", player_id, frozenset(int(t.id) for t in consumed))
            return {
                "type": "ankan", "actor": player_id,
                "consumed": [_tile_to_mjai(t) for t in consumed],
            }, signature

        previous = next((
            group for group in self.t.players[player_id].get_fuuros()
            if len(group.tiles) == 3 and all(int(t.tile) == base for t in group.tiles)
        ), None)
        if previous is None:
            return None
        consumed = list(previous.tiles)
        signature = (
            "kakan", player_id, frozenset(int(t.id) for t in consumed), int(tile.id)
        )
        return {
            "type": "kakan", "actor": player_id,
            "pai": _tile_to_mjai(tile),
            "consumed": [_tile_to_mjai(t) for t in consumed],
        }, signature

    def _capture_mjai_state(self) -> dict:
        rivers = []
        melds = []
        hands = []
        riichi = []
        for player in self.t.players:
            hands.append([int(tile.id) for tile in player.hand])
            riichi.append(bool(player.riichi))
            rivers.append([
                {
                    "id": int(item.tile.id),
                    "pai": _tile_to_mjai(item.tile),
                    "number": int(item.number),
                    "remain": bool(item.remain),
                    "fromhand": bool(item.fromhand),
                    "riichi": bool(item.riichi),
                }
                for item in player.get_river().river
            ])
            player_melds = []
            for group in player.get_fuuros():
                tiles = list(group.tiles)
                player_melds.append({
                    "ids": [int(tile.id) for tile in tiles],
                    "tiles": [_tile_to_mjai(tile) for tile in tiles],
                    "bases": [int(tile.tile) for tile in tiles],
                    "take": int(group.take),
                })
            melds.append(player_melds)
        return {
            "hands": hands,
            "rivers": rivers,
            "melds": melds,
            "riichi": riichi,
            "dora": [
                _tile_to_mjai(self.t.dora_indicator[i])
                for i in range(int(self.t.n_active_dora))
            ],
            "turn": int(self.t.turn),
        }

    def _record_mjai_transition(self, before: dict, announced_kan=None) -> None:
        after = self._capture_mjai_state()
        events: list[dict] = []
        new_dora = after["dora"][len(before["dora"]):]
        deferred_dora = []
        if announced_kan is not None and announced_kan[0]["type"] == "ankan" and new_dora:
            new_dora, deferred_dora = new_dora[:-1], new_dora[-1:]
            self._pending_mjai_dora = (
                announced_kan[1],
                [{"type": "dora", "dora_marker": marker} for marker in deferred_dora],
            )
        leading_events = [{"type": "dora", "dora_marker": marker} for marker in new_dora]

        changed_rivers = {}
        new_discards = []
        for pid, river in enumerate(after["rivers"]):
            old_by_number = {item["number"]: item for item in before["rivers"][pid]}
            for item in river:
                old = old_by_number.get(item["number"])
                if old is None:
                    new_discards.append((item["number"], pid, item))
                elif old["remain"] and not item["remain"]:
                    changed_rivers[item["id"]] = pid

        for pid, player_melds in enumerate(after["melds"]):
            old_groups = before["melds"][pid]
            old_id_sets = [frozenset(group["ids"]) for group in old_groups]
            for group in player_melds:
                group_ids = frozenset(group["ids"])
                if group_ids in old_id_sets:
                    continue

                previous = next((
                    old for old in old_groups
                    if len(old["ids"]) == 3 and len(group["ids"]) == 4
                    and len(set(old["ids"]) & set(group["ids"])) == 3
                ), None)
                if previous is not None:
                    added_id = next(tile_id for tile_id in group["ids"] if tile_id not in previous["ids"])
                    signature = (
                        "kakan", pid, frozenset(previous["ids"]), added_id
                    )
                    if signature in self._pending_mjai_melds:
                        self._pending_mjai_melds.remove(signature)
                        continue
                    added_index = group["ids"].index(added_id)
                    events.append({
                        "type": "kakan", "actor": pid,
                        "pai": group["tiles"][added_index],
                        "consumed": [pai for tile_id, pai in zip(group["ids"], group["tiles"])
                                     if tile_id != added_id],
                    })
                    continue

                called_id = next(
                    (tile_id for tile_id in group["ids"] if tile_id in changed_rivers),
                    None,
                )
                target = changed_rivers.get(called_id)
                if len(group["ids"]) == 4 and target is None:
                    signature = ("ankan", pid, frozenset(group["ids"]))
                    if signature in self._pending_mjai_melds:
                        self._pending_mjai_melds.remove(signature)
                    else:
                        events.append({"type": "ankan", "actor": pid, "consumed": group["tiles"]})
                elif target is not None:
                    called_index = group["ids"].index(called_id)
                    pai = group["tiles"][called_index]
                    consumed = [tile for i, tile in enumerate(group["tiles"]) if i != called_index]
                    if len(group["ids"]) == 4:
                        event = {"type": "daiminkan", "actor": pid, "target": target,
                                 "pai": pai, "consumed": consumed}
                    elif len(set(group["bases"])) == 1:
                        event = {"type": "pon", "actor": pid, "target": target,
                                 "pai": pai, "consumed": consumed}
                    else:
                        event = {"type": "chi", "actor": pid, "target": target,
                                 "pai": pai, "consumed": consumed}
                    events.append(event)

        for _, pid, item in sorted(new_discards):
            if item["riichi"] and not before["riichi"][pid]:
                events.append({"type": "reach", "actor": pid})
            events.append({
                "type": "dahai", "actor": pid, "pai": item["pai"],
                "tsumogiri": not item["fromhand"],
            })

        for pid, (was_riichi, is_riichi) in enumerate(zip(before["riichi"], after["riichi"])):
            if not was_riichi and is_riichi:
                events.append({"type": "reach_accepted", "actor": pid})

        if self.is_over():
            result = self.t.get_result()
            result_type = str(result.result_type).split(".")[-1] if result is not None else ""
            if result_type == "TsumoAgari":
                try:
                    winners = [int(pid) for pid in result.winner]
                except TypeError:
                    winners = [int(result.winner)]
                events.extend({"type": "hora", "actor": pid, "target": pid} for pid in winners)
            elif result_type == "RonAgari":
                try:
                    winners = [int(pid) for pid in result.winner]
                except TypeError:
                    winners = [int(result.winner)]
                try:
                    losers = [int(pid) for pid in result.loser]
                except TypeError:
                    losers = [int(result.loser)]
                target = losers[0] if losers else before["turn"]
                events.extend({"type": "hora", "actor": pid, "target": target} for pid in winners)
            elif "Ryukyouku" in result_type:
                events.append({"type": "ryukyoku"})

        if self._pending_mjai_dora is not None:
            signature, pending_events = self._pending_mjai_dora
            if self.is_over():
                self._pending_mjai_dora = None
            elif any(
                frozenset(group["ids"]) == signature[2]
                for player_melds in after["melds"]
                for group in player_melds
            ):
                self._pending_mjai_dora = None
                dora_index = next(
                    (index for index, event in enumerate(events) if event["type"] == "tsumo"),
                    len(events),
                )
                events[dora_index:dora_index] = pending_events

        old_hand_ids = [set(hand) for hand in before["hands"]]
        for pid, hand in enumerate(after["hands"]):
            for tile_id in hand:
                if tile_id not in old_hand_ids[pid]:
                    tile = next(tile for tile in self.t.players[pid].hand if int(tile.id) == tile_id)
                    events.append({"type": "tsumo", "actor": pid, "pai": _tile_to_mjai(tile)})
                    old_hand_ids[pid].add(tile_id)

        transition_events = leading_events
        if announced_kan is not None:
            transition_events = [*transition_events, announced_kan[0]]
        self.mjai_events.extend([*transition_events, *events])

    def _auto_skip_pass(self) -> None:
        """Advance only forced passes; preserve forced draw/discard transitions."""
        while not self.is_over():
            phase = self.get_phase()
            if phase < 4:
                actions = self.t.get_self_actions()
            elif phase < 16:
                actions = self.t.get_response_actions()
            else:
                break
            if not actions:
                raise RuntimeError(f"No engine actions in phase {phase}")
            if len(actions) != 1 or actions[0].action != pm.BaseAction.Pass:
                break
            self.t.make_selection(0)
            if self.get_phase() == phase:
                raise RuntimeError(f"Forced pass did not advance phase {phase}")

    # ─── Convenience accessors ───────────────────────────────────────────────

    def is_over(self) -> bool:
        return self.t.get_phase() == int(pm.PhaseEnum.GAME_OVER)

    def get_phase(self) -> int:
        return int(self.t.get_phase())

    def get_curr_player(self) -> int:
        return int(self.t.who_make_selection())

    def is_self_action(self) -> bool:
        return self.get_phase() < 4

    def get_result(self):
        return self.t.get_result() if self.is_over() else None

    # ─── Action validation ───────────────────────────────────────────────────

    def get_valid_actions_mask(self, player_id: int) -> np.ndarray:
        if self._riichi_stage2:
            mask = np.zeros(54, dtype=np.int8)
            mask[RIICHI] = 1
            mask[PASS_RIICHI] = 1
            return mask.astype(bool)
        container = np.zeros(54, dtype=np.int8)
        pm.encv1_encode_action(self.t, player_id, container)
        return container.astype(bool)

    def get_valid_actions(self, player_id: int) -> list[int]:
        mask = self.get_valid_actions_mask(player_id)
        return [int(i) for i in range(54) if mask[i]]

    def _riichi_discard_indices(self) -> list[int]:
        return sorted({
            self._discard_index(action.correspond_tiles[0])
            for action in self.t.get_self_actions()
            if action.action == pm.BaseAction.Riichi and action.correspond_tiles
        })

    # ─── Action resolution ───────────────────────────────────────────────────

    def step(self, player_id: int, action_idx: int, choice_tile: Optional[int] = None) -> None:
        """Apply one action. Raises ValueError if invalid."""
        if isinstance(action_idx, (bool, np.bool_)) or not isinstance(action_idx, (int, np.integer)):
            raise ValueError("Action index must be an integer between 0 and 53")
        if not 0 <= action_idx < 54:
            raise ValueError("Action index must be an integer between 0 and 53")
        action_idx = int(action_idx)
        if self.is_over():
            raise ValueError("The hand is already over")
        if player_id != self.get_curr_player():
            raise ValueError(
                f"Player {player_id} cannot act now (current={self.get_curr_player()})"
            )

        # Riichi stage 2 (confirm/cancel)
        if self._riichi_stage2:
            before = self._capture_mjai_state()
            if action_idx not in (RIICHI, PASS_RIICHI):
                raise ValueError("In riichi stage 2 you must choose RIICHI or PASS_RIICHI")
            self._apply_riichi_stage2(player_id, action_idx)
            self._record_mjai_transition(before)
            return

        mask = self.get_valid_actions_mask(player_id)
        if not mask[action_idx]:
            raise ValueError(f"Action {action_idx} is not valid for player {player_id}")

        # Riichi stage 1 detection: discard chosen + RIICHI is valid + tile is in riichi tile list
        if mask[RIICHI] and self._is_discard_action(action_idx):
            riichi_tiles = set(self._riichi_discard_indices())
            if action_idx in riichi_tiles:
                self._mutation_version += 1
                self._riichi_stage2 = True
                self._may_riichi_tile_id = action_idx
                return

        # The legacy action mask collapses all Riichi candidates into 48/52.
        # Resolve that collapsed choice to a concrete engine tile instead of
        # falling through to Pass (BaseAction value 0).
        if action_idx in (RIICHI, PASS_RIICHI):
            riichi_action = next((
                action for action in self.t.get_self_actions()
                if action.action == pm.BaseAction.Riichi and action.correspond_tiles
            ), None)
            if riichi_action is None:
                raise ValueError(f"Action {action_idx} has no matching riichi candidate")
            tile = riichi_action.correspond_tiles[0]
            self._riichi_stage2 = True
            self._may_riichi_tile_id = self._discard_index(tile)
            before = self._capture_mjai_state()
            self._apply_riichi_stage2(player_id, action_idx)
            self._record_mjai_transition(before)
            return

        action_type, tiles, use_red = self._resolve_action(player_id, action_idx, choice_tile)
        before = self._capture_mjai_state()
        announced_kan = self._announced_kan(player_id, action_idx)
        self._mutation_version += 1
        self._submit_to_engine(action_type, tiles, use_red)
        if announced_kan is not None:
            self._pending_mjai_melds.add(announced_kan[1])
        self._auto_skip_pass()
        self._record_mjai_transition(before, announced_kan=announced_kan)
        self._fire_on_step()

    def _is_discard_action(self, action_idx: int) -> bool:
        return 0 <= action_idx <= 36

    @staticmethod
    def _discard_index(tile) -> int:
        base = int(tile.tile)
        return DISCARD_RED_BASE + base // 9 if tile.red_dora else base

    def _apply_riichi_stage2(self, player_id: int, action_idx: int) -> None:
        riichi_idx = self._may_riichi_tile_id
        if riichi_idx is None:
            raise ValueError("No pending riichi tile")
        if action_idx == RIICHI:
            # The C++ engine has one Riichi self-action per riichi-eligible tile,
            # each carrying the specific discard tile in correspond_tiles.
            # Selecting that Riichi action automatically handles the discard.
            _, basetiles, use_red = self._resolve_discard(riichi_idx)
            target_bt = basetiles[0]
            self_actions = self.t.get_self_actions()
            for i, a in enumerate(self_actions):
                if a.action == pm.BaseAction.Riichi and a.correspond_tiles:
                    if self._discard_index(a.correspond_tiles[0]) == riichi_idx:
                        self._mutation_version += 1
                        self.t.make_selection(i)
                        break
            else:
                raise ValueError(
                    f"No Riichi action found for basetile={target_bt} red={use_red}"
                )
        else:
            # PASS_RIICHI: discard normally without declaring riichi
            d_type, d_tiles, d_red = self._resolve_discard(riichi_idx)
            self._mutation_version += 1
            self.t.make_selection_from_action_basetile(
                d_type, [pm.BaseTile(t) for t in d_tiles], d_red
            )
        self._riichi_stage2 = False
        self._may_riichi_tile_id = None
        self._auto_skip_pass()
        self._fire_on_step()

    def _resolve_discard(self, action_idx: int) -> tuple:
        if action_idx < 34:
            return (pm.BaseAction.Discard, [action_idx], False)
        if action_idx == 34:  # red 5m
            return (pm.BaseAction.Discard, [4], True)
        if action_idx == 35:  # red 5p
            return (pm.BaseAction.Discard, [13], True)
        if action_idx == 36:  # red 5s
            return (pm.BaseAction.Discard, [22], True)
        return (pm.BaseAction.Discard, [min(action_idx, 33)], False)

    def _resolve_action(
        self, player_id: int, action_idx: int, choice_tile: Optional[int] = None,
    ) -> tuple:
        if self._is_discard_action(action_idx):
            return self._resolve_discard(action_idx)

        t = self.t
        # In response phase, the action_tile is the just-discarded tile.
        sel_id = -1
        try:
            sel_tile = t.get_selected_action_tile()
            if sel_tile is not None:
                sel_id = int(sel_tile.tile)
        except Exception:
            pass

        if action_idx in _CHI_SET:
            use_red = action_idx >= CHILEFT_R
            kind = (action_idx - CHILEFT) % 3  # 0=left,1=mid,2=right
            if kind == 0:
                tiles = [sel_id + 1, sel_id + 2]
            elif kind == 1:
                tiles = [sel_id - 1, sel_id + 1]
            else:
                tiles = [sel_id - 2, sel_id - 1]
            return (pm.BaseAction.Chi, tiles, use_red)
        if action_idx in (PON, PON_USERED):
            return (pm.BaseAction.Pon, [sel_id, sel_id], action_idx == PON_USERED)
        if action_idx == MINKAN:
            return (pm.BaseAction.Kan, [sel_id, sel_id, sel_id], False)
        if action_idx == ANKAN:
            candidates = [
                a for a in t.get_self_actions()
                if a.action == pm.BaseAction.AnKan and a.correspond_tiles
            ]
            candidate = next((
                a for a in candidates
                if choice_tile is None or int(a.correspond_tiles[0].tile) == choice_tile
            ), None)
            if candidate is None:
                raise ValueError(f"No matching AnKan candidate for tile {choice_tile}")
            bt = int(candidate.correspond_tiles[0].tile)
            return (pm.BaseAction.AnKan, [bt] * 4, False)
        if action_idx == KAKAN:
            candidates = [
                a for a in t.get_self_actions()
                if a.action == pm.BaseAction.KaKan and a.correspond_tiles
            ]
            candidate = next((
                a for a in candidates
                if choice_tile is None or int(a.correspond_tiles[0].tile) == choice_tile
            ), None)
            if candidate is None:
                raise ValueError(f"No matching KaKan candidate for tile {choice_tile}")
            bt = int(candidate.correspond_tiles[0].tile)
            return (pm.BaseAction.KaKan, [bt], False)
        if action_idx == RON:
            response_action = next((
                action for action in t.get_response_actions()
                if action.action in (
                    pm.BaseAction.Ron,
                    pm.BaseAction.ChanKan,
                    pm.BaseAction.ChanAnKan,
                )
            ), None)
            return (response_action.action if response_action else pm.BaseAction.Ron, [], False)
        if action_idx == TSUMO:
            return (pm.BaseAction.Tsumo, [], False)
        if action_idx == KYUSHU:
            return (pm.BaseAction.Kyushukyuhai, [], False)
        if action_idx in (PASS_RESPONSE, PASS_RIICHI):
            return (pm.BaseAction.Pass, [], False)
        raise ValueError(f"Unsupported action index: {action_idx}")

    def _submit_to_engine(self, action_type, tiles, use_red) -> None:
        self.t.make_selection_from_action_basetile(
            action_type, [pm.BaseTile(t) for t in tiles], use_red
        )

    # ─── Random helper ───────────────────────────────────────────────────────

    def random_action(self, player_id: int) -> int:
        return int(np.random.choice(self.get_valid_actions(player_id)))


# ─── Serialization ─────────────────────────────────────────────────────────────

_WIND_NAMES = ("East", "South", "West", "North")
_PHASE_NAMES = (
    "P1_ACTION", "P2_ACTION", "P3_ACTION", "P4_ACTION",
    "P1_RESPONSE", "P2_RESPONSE", "P3_RESPONSE", "P4_RESPONSE",
    "P1_CHANKAN", "P2_CHANKAN", "P3_CHANKAN", "P4_CHANKAN",
    "P1_CHANANKAN", "P2_CHANANKAN", "P3_CHANANKAN", "P4_CHANANKAN",
    "GAME_OVER",
)


def _tile_dict(tile) -> dict:
    bt = int(tile.tile)
    return {
        "id": int(tile.id),
        "basetile": bt,
        "str": basetile_to_str(bt),
        "red_dora": bool(tile.red_dora),
    }


def _player_dict(t: pm.Table, pid: int, hide_hand: bool) -> dict:
    p = t.players[pid]
    if hide_hand:
        hand = [{"count": len(p.hand)}]
    else:
        hand = [_tile_dict(x) for x in p.hand]

    river = []
    for rt in p.get_river().river:
        river.append({
            "tile": _tile_dict(rt.tile),
            "number": int(rt.number),
            "riichi": bool(rt.riichi),
            "remain": bool(rt.remain),
            "fromhand": bool(rt.fromhand),
        })

    calls = []
    for cg in p.get_fuuros():
        try:
            type_str = pm.CallGroupToString(cg)
            if isinstance(type_str, bytes):
                type_str = type_str.decode("utf-8")
            else:
                type_str = str(type_str)
        except Exception:
            type_str = "Unknown"
        # Determine the player from whose discard this call was made.
        # Default to -1 (unknown / AnKan). The C++ engine's CallGroup may not
        # expose this directly; we encode meld type so the front-end can
        # render orientation correctly.
        from_who = -1
        try:
            from_who = int(getattr(cg, "from_who", -1))
        except Exception:
            pass
        calls.append({
            "type": type_str,
            "tiles": [_tile_dict(x) for x in cg.tiles],
            "take": int(cg.take),
            "from_who": from_who,
        })

    return {
        "player_id": pid,
        "wind": _WIND_NAMES[int(p.wind)],
        "is_oya": bool(p.oya),
        "score": int(p.score),
        "hand": hand,
        "river": river,
        "calls": calls,
        "tenpai": [basetile_to_str(int(at)) for at in p.atari_tiles],
        "riichi": bool(p.riichi),
        "double_riichi": bool(p.double_riichi),
        "menzen": bool(p.menzen),
        "furiten": bool(p.is_furiten()),
    }


def build_state(adapter: MahjongEnvAdapter, hansou: HansouSession,
                hide_hands_except: Optional[int] = None) -> dict:
    """Serialize the full table + hansou state for the frontend.

    ``hide_hands_except``:
        None → reveal all hands (4-AI/replay viewer)
        i ∈ 0..3 → hide all hands except player i (human-vs-AI)
    """
    t = adapter.t
    phase = adapter.get_phase()
    curr = adapter.get_curr_player() if not adapter.is_over() else -1

    players = []
    for i in range(4):
        hide = hide_hands_except is not None and i != hide_hands_except
        players.append(_player_dict(t, i, hide))

    valid = []
    valid_mask = [False] * 54
    riichi_discards = []
    ankan_choices = []
    kakan_choices = []
    if curr >= 0:
        valid = adapter.get_valid_actions(curr)
        valid_mask = adapter.get_valid_actions_mask(curr).tolist()
        self_actions = (
            t.get_self_actions()
            if any(valid_mask[index] for index in (ANKAN, KAKAN, RIICHI))
            else []
        )
        if valid_mask[ANKAN]:
            ankan_choices = sorted({
                int(action.correspond_tiles[0].tile)
                for action in self_actions
                if action.action == pm.BaseAction.AnKan and action.correspond_tiles
            })
        if valid_mask[KAKAN]:
            kakan_choices = sorted({
                int(action.correspond_tiles[0].tile)
                for action in self_actions
                if action.action == pm.BaseAction.KaKan and action.correspond_tiles
            })
        if valid_mask[RIICHI] and not adapter._riichi_stage2:
            riichi_discards = adapter._riichi_discard_indices()

    result = None
    if adapter.is_over():
        r = t.get_result()
        if r is not None:
            try:
                loser_list = list(r.loser) if r.loser is not None else []
            except TypeError:
                loser_list = [int(r.loser)] if r.loser is not None else []
            try:
                winner_list = [int(w) for w in list(r.winner)] if r.winner is not None else []
            except TypeError:
                winner_list = [int(r.winner)] if r.winner is not None else []
            result = {
                "type": str(r.result_type).split(".")[-1],
                "scores": list(r.score),
                "winner": winner_list,
                "loser": loser_list,
                "honba": int(r.n_honba),
                "kyoutaku": int(r.n_riichibo),
                "renchan": bool(r.renchan),
            }

    snapshot = {
        "phase": phase,
        "phase_name": _PHASE_NAMES[phase] if phase < len(_PHASE_NAMES) else "GAME_OVER",
        "turn": curr,
        "oya": int(t.oya),
        "game_wind": _WIND_NAMES[int(t.game_wind)],
        "honba": int(t.honba),
        "kyoutaku": int(t.riichibo),
        "tiles_left": int(t.get_remain_tile()),
        "dora": [basetile_to_str(int(d)) for d in t.get_dora()],
        "ura_dora": [basetile_to_str(int(d)) for d in t.get_ura_dora()],
        "players": players,
        "valid_actions": valid,
        "valid_actions_mask": valid_mask,
        "riichi_discards": riichi_discards,
        "ankan_choices": ankan_choices,
        "kakan_choices": kakan_choices,
        "riichi_stage2": adapter._riichi_stage2,
        "riichi_tile": adapter._may_riichi_tile_id,
        "is_over": adapter.is_over(),
        "result": result,
        "hansou": hansou.snapshot(),
    }
    return snapshot


# ─── Session bookkeeping ──────────────────────────────────────────────────────


@dataclass
class GameSession:
    session_id: str
    mode: GameMode
    adapter: MahjongEnvAdapter
    hansou: HansouSession
    human_player_id: int = -1
    action_log: list = field(default_factory=list)
    logger: Optional[SessionLogger] = None

    def get_state(self, for_player: Optional[int] = None) -> dict:
        hide = None
        if self.mode == GameMode.HUMAN_AI and for_player is not None:
            hide = for_player
        return build_state(self.adapter, self.hansou, hide_hands_except=hide)

    def step(
        self, player_id: int, action_idx: int, choice_tile: Optional[int] = None,
    ) -> dict:
        # Snapshot pre-step context for verbose log.
        if self.logger is not None:
            try:
                pre_phase = self.adapter.get_phase()
                pre_curr = self.adapter.get_curr_player()
                pre_valid = self.adapter.get_valid_actions(player_id)
                self.logger.log("step_in", {
                    "player": player_id,
                    "action_idx": action_idx,
                    "choice_tile": choice_tile,
                    "phase": pre_phase,
                    "curr_player": pre_curr,
                    "valid_actions": pre_valid,
                    "riichi_stage2": self.adapter._riichi_stage2,
                    "tiles_left": int(self.adapter.t.get_remain_tile()),
                })
            except Exception as e:
                self.logger.log_exception("step_in_snapshot_fail", e)
        try:
            self.adapter.step(player_id, action_idx, choice_tile=choice_tile)
        except Exception as e:
            if self.logger is not None:
                self.logger.log_exception("step_error", e,
                                          player=player_id, action_idx=action_idx,
                                          choice_tile=choice_tile)
            raise
        self.action_log.append({
            "player": player_id, "action": action_idx, "choice_tile": choice_tile,
        })
        if self.logger is not None:
            try:
                self.logger.log("step_out", {
                    "player": player_id,
                    "action_idx": action_idx,
                    "phase": self.adapter.get_phase(),
                    "curr_player": self.adapter.get_curr_player() if not self.adapter.is_over() else -1,
                    "is_over": self.adapter.is_over(),
                })
            except Exception as e:
                self.logger.log_exception("step_out_snapshot_fail", e)
        return self.get_state(for_player=self.human_player_id if self.human_player_id >= 0 else None)


class GameManager:
    """Manages active game sessions."""

    def __init__(self):
        self._sessions: dict[str, GameSession] = {}
        self._lock = threading.Lock()

    def create_session(
        self,
        mode: GameMode = GameMode.HUMAN_AI,
        seed: Optional[int] = None,
        max_round: int = 1,
    ) -> GameSession:
        adapter = MahjongEnvAdapter(mode=mode, seed=seed)
        hansou = HansouSession(env=adapter, max_round=max_round)
        hansou.start_first_kyoku(seed=seed)
        sid = str(uuid.uuid4())
        slogger = SessionLogger(sid, mode.value, seed, max_round)
        slogger.log("kyoku_init", {
            "kyoku": hansou.snapshot(),
            "phase": adapter.get_phase(),
            "curr_player": adapter.get_curr_player(),
        })
        session = GameSession(
            session_id=sid,
            mode=mode,
            adapter=adapter,
            hansou=hansou,
            human_player_id=0 if mode == GameMode.HUMAN_AI else -1,
            logger=slogger,
        )
        with self._lock:
            self._sessions[sid] = session
        return session

    def get_session(self, session_id: str) -> Optional[GameSession]:
        with self._lock:
            return self._sessions.get(session_id)

    def list_sessions(self) -> list[dict]:
        with self._lock:
            return [
                {"session_id": sid, "mode": s.mode.value,
                 "kyoku_count": s.hansou.kyoku_count,
                 "finished": s.hansou.finished}
                for sid, s in self._sessions.items()
            ]

    def close_session(self, session_id: str) -> bool:
        with self._lock:
            sess = self._sessions.pop(session_id, None)
        if sess is None:
            return False
        if sess.logger is not None:
            sess.logger.close()
        return True
