"""Mortal V4 inference and mjai-to-web action conversion."""
from __future__ import annotations

import importlib
import json
import logging
import math
import os
import sys
import threading
from pathlib import Path
from typing import Any

from ai_player import BaseAIPlayer


REPO_DIR = Path(__file__).resolve().parents[1]
_RUNTIME_ROOT = Path(os.environ.get("MORTAL_HOME", REPO_DIR / ".runtime" / "Mortal"))
_LOAD_LOCK = threading.Lock()
_INFERENCE_LOCK = threading.RLock()
_ENGINES: dict[str, Any] = {}


class MortalNoActionError(RuntimeError):
    """The Mortal process completed a turn replay without choosing an action."""


def _load_engine(model_path: str):
    key = str(Path(model_path).resolve())
    with _LOAD_LOCK:
        if key in _ENGINES:
            return _ENGINES[key]

        mortal_dir = _RUNTIME_ROOT / "mortal"
        if not (mortal_dir / "model.py").is_file() or not (mortal_dir / "libriichi.pyd").is_file():
            raise RuntimeError(
                "Mortal runtime is unavailable. Set MORTAL_HOME to a Mortal checkout "
                "containing the Windows libriichi.pyd runtime."
            )
        if not Path(key).is_file():
            raise FileNotFoundError(f"Mortal checkpoint not found: {key}")

        runtime_path = str(mortal_dir)
        if runtime_path not in sys.path:
            sys.path.insert(0, runtime_path)
        torch = importlib.import_module("torch")
        mortal_model = importlib.import_module("model")
        mortal_engine = importlib.import_module("engine")

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        checkpoint = torch.load(key, map_location="cpu", weights_only=False)
        config = checkpoint["config"]
        version = int(config["control"].get("version", 1))
        brain = mortal_model.Brain(
            version=version,
            num_blocks=int(config["resnet"]["num_blocks"]),
            conv_channels=int(config["resnet"]["conv_channels"]),
        ).to(device).eval()
        dqn = mortal_model.DQN(version=version).to(device).eval()
        brain.load_state_dict(checkpoint["mortal"])
        dqn.load_state_dict(checkpoint["current_dqn"])
        engine = mortal_engine.MortalEngine(
            brain,
            dqn,
            version=version,
            is_oracle=False,
            device=device,
            enable_amp=False,
            enable_quick_eval=False,
            enable_rule_based_agari_guard=True,
            name=Path(key).stem,
        )
        _ENGINES[key] = engine
        return engine


def _tile_info(pai: str) -> tuple[int, bool]:
    if pai in {"E", "S", "W", "N", "P", "F", "C"}:
        return 27 + ("E", "S", "W", "N", "P", "F", "C").index(pai), False
    if pai in ("5mr", "5pr", "5sr", "0m", "0p", "0s"):
        suit = pai[-2] if pai.endswith("r") else pai[-1]
        return {"m": 4, "p": 13, "s": 22}[suit], True
    if len(pai) != 2 or pai[0] not in "123456789" or pai[1] not in "mpsz":
        raise ValueError(f"Unsupported mjai tile: {pai}")
    rank = int(pai[0]) - 1
    return rank + {"m": 0, "p": 9, "s": 18, "z": 27}[pai[1]], False


def _tile_action(pai: str) -> int:
    base, red = _tile_info(pai)
    if red:
        return {4: 34, 13: 35, 22: 36}[base]
    return base


def _map_mjai_action(action: dict, valid_mask) -> int:
    kind = action.get("type")
    if kind == "dahai":
        index = _tile_action(action["pai"])
    elif kind == "chi":
        called, _ = _tile_info(action["pai"])
        tiles = sorted([called, *(_tile_info(pai)[0] for pai in action["consumed"])])
        if len(tiles) != 3 or len(set(tiles)) != 3:
            raise ValueError("Mortal returned an invalid chi shape")
        if tiles != list(range(tiles[0], tiles[0] + 3)) or tiles[0] // 9 != tiles[-1] // 9:
            raise ValueError("Mortal returned a non-sequential chi")
        kind_index = 37 if called == tiles[0] else 38 if called == tiles[1] else 39
        uses_red = any(_tile_info(pai)[1] for pai in action["consumed"])
        index = kind_index + (3 if uses_red else 0)
    elif kind == "pon":
        index = 44 if any(_tile_info(pai)[1] for pai in action["consumed"]) else 43
    elif kind == "daiminkan":
        index = 46
    elif kind == "ankan":
        index = 45
    elif kind == "kakan":
        index = 47
    elif kind == "hora":
        index = 50 if action.get("actor") == action.get("target") else 49
    elif kind == "ryukyoku":
        index = 51
    elif kind == "none":
        index = 53
    else:
        raise ValueError(f"Unsupported Mortal action: {kind}")

    if index >= len(valid_mask) or not bool(valid_mask[index]):
        raise ValueError(f"Mortal chose action {kind} that is illegal in the web engine")
    return index


def _choice_tile_for_mjai_action(action: dict) -> int | None:
    """Return the concrete tile type for collapsed kan actions."""
    kind = action.get("type")
    if kind == "ankan":
        consumed = action.get("consumed") or []
        if not consumed:
            raise ValueError("Mortal returned an ankan without consumed tiles")
        base, _ = _tile_info(consumed[0])
        if any(_tile_info(pai)[0] != base for pai in consumed):
            raise ValueError("Mortal returned an ankan with mismatched tile types")
        return base
    if kind == "kakan":
        return _tile_info(action["pai"])[0]
    return None


def _run_bot(adapter, player_id: int, model_path: str) -> tuple[dict, dict]:
    engine = _load_engine(model_path)
    from libriichi.mjai import Bot

    bot = Bot(engine, int(player_id))
    events = adapter.mjai_events_for_player(player_id)
    if not events:
        raise RuntimeError("No mjai events are available for the current hand")

    response = None
    with _INFERENCE_LOCK:
        for index, event in enumerate(events):
            response = bot.react(
                json.dumps(event, separators=(",", ":")),
                can_act=index == len(events) - 1,
            )
    if response is None:
        raise MortalNoActionError("Mortal did not return an action for this turn")
    action = json.loads(response)

    if action.get("type") == "reach":
        response = bot.react(json.dumps(action, separators=(",", ":")))
        if response is None:
            raise MortalNoActionError("Mortal declared riichi but did not select a discard")
        action = json.loads(response)
        action["riichi"] = True
    return action, action.get("meta") or {}


def _action_label(action_idx: int, riichi: bool = False) -> str:
    if action_idx <= 36:
        if action_idx < 34:
            tile = f"{action_idx + 1}m" if action_idx < 9 else (
                f"{action_idx - 8}p" if action_idx < 18 else
                f"{action_idx - 17}s" if action_idx < 27 else
                ("E", "S", "W", "N", "P", "F", "C")[action_idx - 27]
            )
        else:
            tile = ("5m", "5p", "5s")[action_idx - 34]
        return f"{'立直后，' if riichi else ''}打出 {tile}"
    labels = {
        37: "吃左边",
        38: "吃中间",
        39: "吃右边",
        40: "吃左边（用赤牌）",
        41: "吃中间（用赤牌）",
        42: "吃右边（用赤牌）",
        43: "碰",
        44: "碰（用赤牌）",
        45: "暗杠",
        46: "大明杠",
        47: "加杠",
        48: "确认立直",
        49: "荣和",
        50: "自摸",
        51: "九种九牌",
        52: "取消立直",
        53: "跳过",
    }
    return labels.get(action_idx, "当前没有建议")


def _response_action_label(adapter, action_idx: int) -> str:
    try:
        called_tile = adapter.t.get_selected_action_tile()
        if called_tile is None:
            return _action_label(action_idx)
        base = int(called_tile.tile)
    except (AttributeError, RuntimeError, TypeError, ValueError):
        return _action_label(action_idx)

    def tile_label(tile: int, red: bool = False) -> str:
        if tile < 9:
            label = f"{tile + 1}m"
        elif tile < 18:
            label = f"{tile - 8}p"
        elif tile < 27:
            label = f"{tile - 17}s"
        else:
            label = ("E", "S", "W", "N", "P", "F", "C")[tile - 27]
        if red:
            return f"赤{label}"
        return label

    if 37 <= action_idx <= 42:
        kind = (action_idx - 37) % 3
        if kind == 0:
            consumed = (base + 1, base + 2)
        elif kind == 1:
            consumed = (base - 1, base + 1)
        else:
            consumed = (base - 2, base - 1)
        uses_red = action_idx >= 40
        labels = [
            tile_label(tile, uses_red and tile in (4, 13, 22))
            for tile in consumed
        ]
        return f"吃 {labels[0]} + {labels[1]}"
    if action_idx in (43, 44):
        red = action_idx == 44
        tile = tile_label(base)
        if red and base in (4, 13, 22):
            tile = tile_label(base, True)
        return f"碰 {tile}（{'用赤牌' if red else '普通牌'}）"
    return _action_label(action_idx)


def _action_tile_id(adapter, player_id: int, action_idx: int, action: dict):
    if action_idx > 36:
        return None
    base, red = _tile_info(action["pai"])
    return next((
        int(tile.id) for tile in adapter.t.players[player_id].hand
        if int(tile.tile) == base and bool(tile.red_dora) == red
    ), None)


def _mortal_action_to_web_index(action_idx: int, valid_mask, chosen_action_idx: int):
    def is_valid(web_idx: int) -> bool:
        return web_idx < len(valid_mask) and bool(valid_mask[web_idx])

    if 0 <= action_idx <= 36:
        return action_idx if is_valid(action_idx) else None
    if action_idx == 37:
        return 48 if is_valid(48) else None
    if 38 <= action_idx <= 40:
        web_idx = action_idx - 1
        red_idx = web_idx + 3
        if is_valid(red_idx):
            return red_idx
        return web_idx if is_valid(web_idx) else None
    if action_idx == 41:
        return 44 if is_valid(44) else 43 if is_valid(43) else None
    if action_idx == 42:
        return chosen_action_idx if chosen_action_idx in (45, 46, 47) and is_valid(chosen_action_idx) else None
    if action_idx == 43:
        if is_valid(50):
            return 50
        return 49 if is_valid(49) else None
    if action_idx == 44:
        return 51 if is_valid(51) else None
    if action_idx == 45:
        return 53 if is_valid(53) else None
    return None


def _action_tile_id_for_index(adapter, player_id: int, action_idx: int):
    if action_idx <= 33:
        base, red = action_idx, False
    elif action_idx <= 36:
        base, red = (4, 13, 22)[action_idx - 34], True
    else:
        return None
    return next((
        int(tile.id) for tile in adapter.t.players[player_id].hand
        if int(tile.tile) == base and bool(tile.red_dora) == red
    ), None)


def _top_action_candidates(adapter, player_id: int, meta: dict, chosen_action_idx: int,
                           riichi: bool) -> list[dict]:
    q_values = meta.get("q_values")
    mask_bits = meta.get("mask_bits")
    if not isinstance(q_values, list) or mask_bits is None:
        return []
    try:
        mask_bits = int(mask_bits)
        action_indices = [idx for idx in range(46) if mask_bits & (1 << idx)]
        if len(action_indices) != len(q_values):
            return []
        candidates = [
            (idx, float(q_value))
            for idx, q_value in zip(action_indices, q_values)
            if math.isfinite(float(q_value))
        ]
    except (TypeError, ValueError, OverflowError):
        return []
    if not candidates:
        return []

    valid_mask = adapter.get_valid_actions_mask(player_id)
    # The rule-based agari guard can replace a highest-Q win with the best
    # alternative while retaining the original Q values in response metadata.
    highest_idx = max(candidates, key=lambda item: (item[1], -item[0]))[0]
    if highest_idx == 43 and chosen_action_idx not in (49, 50):
        candidates = [(idx, score) for idx, score in candidates if idx != 43]
        if not candidates:
            return []

    max_score = max(score for _, score in candidates)
    weights = [math.exp(score - max_score) for _, score in candidates]
    total_weight = sum(weights)
    if not math.isfinite(total_weight) or total_weight <= 0:
        return []

    ranked = sorted(candidates, key=lambda item: (item[1], -item[0]), reverse=True)
    probabilities = {idx: weight / total_weight for (idx, _), weight in zip(candidates, weights)}
    top_actions = []
    for mortal_idx, _ in ranked:
        if len(top_actions) == 3:
            break
        web_idx = _mortal_action_to_web_index(mortal_idx, valid_mask, chosen_action_idx)
        if web_idx is None and mortal_idx == 42 and any(valid_mask[idx] for idx in (45, 46, 47)):
            label = "杠"
        elif web_idx is None:
            continue
        elif mortal_idx == 37:
            label = "立直"
        elif 37 <= web_idx <= 44:
            label = _response_action_label(adapter, web_idx)
        else:
            label = _action_label(web_idx, riichi and web_idx <= 36)
        top_actions.append({
            "action_idx": web_idx,
            "label": label,
            "tile_id": _action_tile_id_for_index(adapter, player_id, web_idx)
            if web_idx is not None else None,
            "probability": probabilities[mortal_idx],
        })
    return top_actions


def mortal_advice(adapter, player_id: int, model_path: str) -> dict:
    if adapter._riichi_stage2:
        label = _action_label(48)
        return {
            "action_idx": 48,
            "riichi": True,
            "label": label,
            "model": Path(model_path).stem,
            "tile_id": None,
            "top_actions": [{
                "action_idx": 48,
                "label": label,
                "tile_id": None,
                "probability": None,
            }],
        }
    action, meta = _run_bot(adapter, player_id, model_path)
    action_idx = _map_mjai_action(action, adapter.get_valid_actions_mask(player_id))
    riichi = bool(action.get("riichi"))
    label = (
        _response_action_label(adapter, action_idx)
        if 37 <= action_idx <= 44
        else _action_label(action_idx, riichi)
    )
    tile_id = _action_tile_id(adapter, player_id, action_idx, action)
    top_actions = _top_action_candidates(adapter, player_id, meta, action_idx, riichi)
    if not top_actions:
        top_actions = [{
            "action_idx": action_idx,
            "label": label,
            "tile_id": tile_id,
            "probability": None,
        }]
    return {
        "action_idx": action_idx,
        "riichi": riichi,
        "label": label,
        "tile_id": tile_id,
        "model": Path(model_path).stem,
        "shanten": meta.get("shanten"),
        "eval_time_ms": round(meta.get("eval_time_ns", 0) / 1_000_000, 1),
        "top_actions": top_actions,
    }


class MortalAIPlayer(BaseAIPlayer):
    """Mortal checkpoint played through Mortal's own libriichi mjai runtime."""

    def __init__(self, model_path: str):
        self.model_path = str(Path(model_path).resolve())
        self._pending_riichi = False
        self._last_fallback_reason = None
        self._last_choice_tile = None

    def on_hand_start(self, env_wrapper) -> None:
        self._pending_riichi = False
        self._last_fallback_reason = None

    def select_action(self, env_wrapper, player_id: int) -> int:
        self._last_fallback_reason = None
        self._last_choice_tile = None
        if env_wrapper._riichi_stage2:
            if self._pending_riichi:
                self._pending_riichi = False
                return 48
            return 52

        try:
            action, _ = _run_bot(env_wrapper, player_id, self.model_path)
        except MortalNoActionError as exc:
            valid_actions = env_wrapper.get_valid_actions(player_id)
            if not valid_actions:
                raise
            if 53 in valid_actions:
                fallback = 53
            else:
                discards = [idx for idx in valid_actions if 0 <= idx <= 36]
                fallback = min(discards) if discards else min(valid_actions)
            self._pending_riichi = False
            self._last_fallback_reason = str(exc)
            logging.getLogger("mahjong_server").warning(
                "Mortal returned no action for player %s; using legal fallback %s",
                player_id,
                fallback,
            )
            return fallback
        riichi = bool(action.get("riichi"))
        action_idx = _map_mjai_action(action, env_wrapper.get_valid_actions_mask(player_id))
        self._last_choice_tile = _choice_tile_for_mjai_action(action)
        self._pending_riichi = riichi
        return action_idx
