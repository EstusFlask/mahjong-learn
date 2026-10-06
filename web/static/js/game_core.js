/**
 * Mahjong Game Core — API client, state management, and event handling.
 */

class MahjongGame {
    constructor(canvasId, opts = {}) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.opts = opts;

        this.sessionId = null;
        this.state = null;
        this.mode = 'human_ai';  // 'human_ai' or '4ai'
        this.isMyTurn = false;
        this.selectedTileIdx = null;
        this.pendingRiichi = false;
        this.actionSelection = null;
        this._actionSelectionKey = null;
        this.eventSource = null;
        this.aiSpeed = 1000;  // ms between AI actions
        this._animFrame = null;
        this._actionInFlight = false;
        this._autoSubmittedKey = null;
        this._autoSubmitFailedKey = null;
        this.adviceEnabled = false;
        this.advice = null;
        this._advicePendingKey = null;
        this._adviceError = null;

        if (window.MahjongRenderer?.setInvalidateHandler) {
            window.MahjongRenderer.setInvalidateHandler(() => this._render());
        }
    }

    // ─── Canvas Sizing ────────────────────────────────────────────────────

    resize() {
        if (window.MahjongRenderer?.resizeCanvasToContainer) {
            window.MahjongRenderer.resizeCanvasToContainer(this.canvas, { maxWidth: 2400, maxHeightRatio: 1.10 });
        }
    }

    // ─── API Calls ─────────────────────────────────────────────────────────

    async _fetch(url, options = {}) {
        const resp = await fetch(url, {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options,
            body: options.body ? JSON.stringify(options.body) : undefined,
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        if (resp.headers.get('content-type')?.includes('application/json')) {
            return resp.json();
        }
        return resp.text();
    }

    async newGame(mode = 'human_ai', aiModel = null, seed = null, maxRound = 1, aiModels = null) {
        this.mode = mode;
        this.advice = null;
        this.actionSelection = null;
        this._actionSelectionKey = null;
        this._advicePendingKey = null;
        this._adviceError = null;
        this._autoSubmittedKey = null;
        this._autoSubmitFailedKey = null;
        const body = { mode, ai_model: aiModel, seed, max_round: maxRound };
        if (aiModels) body.ai_models = aiModels;
        const resp = await this._fetch('/api/game/new', {
            method: 'POST',
            body
        });
        this.sessionId = resp.session_id;
        this.state = resp.state;
        this.logUrl = resp.log_url || null;
        if (this.logUrl) {
            console.info('[mahjong] verbose log →', this.logUrl, '(server path:', resp.log_path, ')');
            this._renderLogLink();
        }
        this._startSSE();
        this._render();

        // Auto AI turn if not human's turn
        this._scheduleAI();

        return resp;
    }

    setAdviceEnabled(enabled) {
        this.adviceEnabled = !!enabled;
        this.advice = null;
        this._advicePendingKey = null;
        this._adviceError = null;
        this._render();
    }

    _adviceStateKey() {
        const s = this.state;
        if (!s) return null;
        return JSON.stringify([
            s.game_wind, s.oya, s.honba, s.kyoutaku, s.tiles_left,
            s.phase, s.turn, s.riichi_stage2, s.valid_actions_mask,
            (s.players?.[0]?.hand || []).map(tile => tile?.id ?? tile?.str ?? tile),
            (s.players || []).map(player => (player.river || []).map(item => [
                item.number, item.tile?.id, item.remain,
            ])),
        ]);
    }

    _currentAdvice() {
        return this.adviceEnabled && this.advice?.key === this._adviceStateKey()
            ? this.advice
            : null;
    }

    _refreshAdvice() {
        if (!this.adviceEnabled || !this.sessionId || !this.state || this.state.is_over || this.state.turn !== 0) {
            return;
        }
        const key = this._adviceStateKey();
        if (this.advice?.key === key || this._advicePendingKey === key) return;

        this.advice = null;
        this._adviceError = null;
        this._advicePendingKey = key;
        this._updateAdviceDisplay();
        this._fetch(`/api/game/${this.sessionId}/advice`).then(advice => {
            if (!this.adviceEnabled || this._adviceStateKey() !== key) return;
            this._advicePendingKey = null;
            this.advice = { ...advice, key };
            this._render();
        }).catch(error => {
            if (!this.adviceEnabled || this._adviceStateKey() !== key) return;
            this._advicePendingKey = null;
            this._adviceError = { key, message: error.message };
            this._updateAdviceDisplay();
        });
    }

    _applyAdviceHighlight() {
        const hand = this.state?.players?.[0]?.hand || [];
        for (const tile of hand) {
            if (tile && typeof tile === 'object') tile.highlighted = false;
        }
        const advice = this._currentAdvice();
        if (advice?.tile_id == null) return;
        for (const tile of hand) {
            if (tile && typeof tile === 'object' && tile.id === advice.tile_id) {
                tile.highlighted = true;
            }
        }
    }

    _updateAdviceDisplay() {
        const dashboard = document.getElementById('adviceDashboard');
        const primaryTile = document.getElementById('advicePrimaryTile');
        const primaryLabel = document.getElementById('advicePrimaryLabel');
        const primaryMeta = document.getElementById('advicePrimaryMeta');
        const topActions = document.getElementById('adviceTopActions');
        if (!dashboard || !primaryLabel || !primaryMeta || !topActions) return;

        dashboard.hidden = !this.adviceEnabled;
        if (!this.adviceEnabled) return;

        const setPrimaryTile = (tileId) => {
            if (!primaryTile) return;
            primaryTile.replaceChildren();
            const tile = this.state?.players?.[0]?.hand?.find(item =>
                item && typeof item === 'object' && item.id === tileId
            );
            const assetPath = tile && window.MahjongRenderer?.getTileAssetPath?.(
                tile.str, !!tile.red_dora
            );
            if (!assetPath) return;
            const image = document.createElement('img');
            image.src = assetPath;
            image.alt = tile.str;
            primaryTile.appendChild(image);
        };

        const renderTopActions = (actions) => {
            topActions.replaceChildren();
            actions.forEach((action, index) => {
                const row = document.createElement('li');
                row.className = 'advice-action-row';

                const rank = document.createElement('span');
                rank.className = 'advice-rank';
                rank.textContent = String(index + 1);
                row.appendChild(rank);

                const tileSlot = document.createElement('span');
                tileSlot.className = 'advice-tile-slot';
                const tile = this.state?.players?.[0]?.hand?.find(item =>
                    item && typeof item === 'object' && item.id === action.tile_id
                );
                const assetPath = tile && window.MahjongRenderer?.getTileAssetPath?.(
                    tile.str, !!tile.red_dora
                );
                if (assetPath) {
                    const image = document.createElement('img');
                    image.src = assetPath;
                    image.alt = tile.str;
                    tileSlot.appendChild(image);
                }
                row.appendChild(tileSlot);

                const actionInfo = document.createElement('span');
                actionInfo.className = 'advice-action-info';
                const label = document.createElement('span');
                label.className = 'advice-action-label';
                label.textContent = action.label;
                const track = document.createElement('span');
                track.className = 'advice-probability-track';
                const fill = document.createElement('span');
                fill.className = 'advice-probability-fill';
                const hasProbability = action.probability != null && Number.isFinite(Number(action.probability));
                const probability = hasProbability
                    ? Math.max(0, Math.min(1, Number(action.probability)))
                    : 0;
                fill.style.width = `${probability * 100}%`;
                track.appendChild(fill);
                actionInfo.append(label, track);
                row.appendChild(actionInfo);

                const percent = document.createElement('span');
                percent.className = 'advice-probability';
                percent.textContent = hasProbability ? `${(probability * 100).toFixed(2)}%` : '—';
                row.appendChild(percent);
                topActions.appendChild(row);
            });
        };

        const s = this.state;
        primaryMeta.textContent = '';
        setPrimaryTile(null);
        if (!s) {
            primaryLabel.textContent = '等待牌局';
            renderTopActions([]);
            return;
        }
        if (s.is_over) {
            primaryLabel.textContent = '牌局结束';
            renderTopActions([]);
            return;
        }
        if (s.turn !== 0) {
            primaryLabel.textContent = '等待你的回合';
            renderTopActions([]);
            return;
        }

        const key = this._adviceStateKey();
        const advice = this._currentAdvice();
        if (advice) {
            const details = [advice.shanten != null ? `向听 ${advice.shanten}` : null,
                advice.eval_time_ms != null ? `${advice.eval_time_ms} ms` : null].filter(Boolean);
            primaryLabel.textContent = advice.label;
            primaryMeta.textContent = details.join(' · ');
            setPrimaryTile(advice.tile_id);
            renderTopActions(advice.top_actions || [{
                label: advice.label,
                tile_id: advice.tile_id,
                probability: null,
            }]);
        } else if (this._advicePendingKey === key) {
            primaryLabel.textContent = '计算中…';
            renderTopActions([]);
        } else if (this._adviceError?.key === key) {
            primaryLabel.textContent = this._adviceError.message;
            renderTopActions([]);
        } else {
            primaryLabel.textContent = '';
            renderTopActions([]);
        }
    }

    _renderLogLink() {
        if (!this.logUrl) return;
        let el = document.getElementById('verboseLogLink');
        if (!el) {
            el = document.createElement('a');
            el.id = 'verboseLogLink';
            el.textContent = '⬇ 下载本局日志';
            el.style.cssText = 'position:fixed;right:14px;bottom:12px;z-index:30;background:#1a2638;color:#cfd8e7;padding:6px 12px;border-radius:6px;font-size:12px;text-decoration:none;border:1px solid #3a4a66;';
            (document.querySelector('.play-layout .game-log') || document.body).appendChild(el);
        }
        el.href = this.logUrl;
        el.download = '';
    }

    async getState() {
        if (!this.sessionId) return null;
        try {
            const state = await this._fetch(`/api/game/${this.sessionId}/state?for_player=0`);
            this.state = state;
            this._render();
            return state;
        } catch (e) {
            console.error('getState failed:', e);
            return null;
        }
    }

    async submitAction(actionIdx, choiceTile = null) {
        if (!this.sessionId) return;
        if (this._actionInFlight) return;
        const actionStateKey = this._adviceStateKey();
        this._actionInFlight = true;
        this._updateActionPanel();
        try {
            const resp = await this._fetch(`/api/game/${this.sessionId}/action`, {
                method: 'POST',
                body: {
                    player_id: 0,
                    action_idx: actionIdx,
                    ...(choiceTile == null ? {} : { choice_tile: choiceTile }),
                }
            });
            if (actionIdx === 53) this._autoSubmitFailedKey = null;
            this.state = resp.state;
            this.selectedTileIdx = null;
            this.pendingRiichi = false;
            this._render();
            this._scheduleAI();
            return resp;
        } catch (e) {
            if (actionIdx === 53 && this._autoSubmittedKey === actionStateKey) {
                this._autoSubmitFailedKey = actionStateKey;
            }
            console.error('submitAction failed:', e);
        } finally {
            this._actionInFlight = false;
            this._updateActionPanel();
        }
    }

    // ─── SSE ───────────────────────────────────────────────────────────────

    _startSSE() {
        if (this.eventSource) {
            this.eventSource.close();
        }
        this.eventSource = new EventSource(`/api/game/${this.sessionId}/events`);

        this.eventSource.addEventListener('message', (e) => {
            try {
                const data = JSON.parse(e.data);
                switch (data.type) {
                    case 'snapshot':
                    case 'ai_action':
                    case 'kyoku_start':
                        // Remove kyoku result modal if present
                        {
                            const krm = document.getElementById('kyokuResultModal');
                            if (krm) krm.remove();
                        }
                        this.state = data.state;
                        this._render();
                        if (data.warning) {
                            this._updateStatus(data.warning);
                        } else if (data.type === 'ai_action' && this.state.turn !== 0) {
                            this._showAIMove(data.player, data.action);
                        }
                        break;
                    case 'kyoku_end':
                        this.state = data.state;
                        this._render();
                        this._showKyokuEndToast(data);
                        break;
                    case 'hansou_end':
                        this.state = data.state;
                        this._render();
                        this._onGameOver(data.state, data);
                        break;
                    case 'error':
                        console.error('server error event:', data);
                        this._updateStatus(`AI 已停止：${data.message || '未知错误'}`);
                        break;
                }
            } catch (err) {
                console.error('SSE parse error:', err);
            }
        });

        this.eventSource.onerror = () => {
            console.warn('SSE connection lost, will retry...');
        };
    }

    _stopSSE() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }

    // ─── AI Scheduling ─────────────────────────────────────────────────────

    _scheduleAI() {
        if (this.mode === '4ai') return;  // Server handles AI in 4ai mode
        if (!this.state || this.state.is_over) return;
        const curr = this.state.turn;
        const isHuman = (curr === 0);
        if (!isHuman) {
            // AI turn — wait a bit then the SSE will deliver the result
        }
    }

    // ─── Tile Click Handling ───────────────────────────────────────────────

    _onCanvasClick(e) {
        if (!this.state || this.state.is_over) return;
        if (this.state.turn !== 0) return;  // Not our turn

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const mx = (e.clientX - rect.left) * scaleX;
        const my = (e.clientY - rect.top) * scaleY;

        const hitBoxes = window.MahjongRenderer.getHandHitBoxes(this.canvas.width, this.canvas.height, this.state);
        for (const hit of hitBoxes) {
            if (mx >= hit.x && mx <= hit.x + hit.w && my >= hit.y && my <= hit.y + hit.h) {
                this._selectTile(hit.index, hit.tile);
                return;
            }
        }
    }

    _selectTile(idx, tileData) {
        if (this.pendingRiichi) {
            // Second click — confirm riichi (submit RIICHI action = index 48)
            this.pendingRiichi = false;
            this.submitAction(48);
            return;
        }

        // Normal discard or riichi step 1
        const actionIdx = this._findDiscardAction(tileData);
        if (actionIdx === null) return;

        const validMask = this.state.valid_actions_mask;
        const isValidDiscard = validMask && validMask[actionIdx] === true;

        if (isValidDiscard) {
            this.submitAction(actionIdx);
        }
    }

    async _submitRiichiStep1(discardIdx, tileData, tileDisplayIdx) {
        // Riichi is a two-step process:
        // Step 1: Player clicks a riichi-eligible tile → submit discard (same as normal)
        //   The server's MahjongEnvWrapper detects riichi_stage2=True
        // Step 2: Auto-confirm riichi → submit action 48 (RIICHI)
        //   Since the player already chose the riichi tile by clicking it,
        //   we skip the manual confirm step and auto-discard.
        this.pendingRiichi = true;
        this._riichiDiscardIdx = discardIdx;
        this._riichiDisplayIdx = tileDisplayIdx;
        this._autoConfirmRiichi = true;

        // Visual: highlight selected tile
        this.state.players[0].hand.forEach((t, i) => {
            if (typeof t === 'object') t.selected = (i === tileDisplayIdx);
        });
        this._render();

        // Submit discard (server will detect riichi and enter stage 2)
        await this.submitAction(discardIdx);

        // If server entered riichi stage 2, auto-confirm immediately.
        if (this._autoConfirmRiichi && this.state && this.state.riichi_stage2) {
            this._autoConfirmRiichi = false;
            await this.submitAction(48);
        } else {
            this._autoConfirmRiichi = false;
        }
    }

    _showRiichiConfirm() {
        // Use the same legality and visibility checks as every other action.
        this._updateActionPanel();
    }

    _findDiscardAction(tileData) {
        // Map clicked tile to action index
        // Tiles 0-36 map to basetiles (handling red 5)
        const tileStr = typeof tileData === 'string' ? tileData : (tileData.str || '');
        const isRed = tileData.red_dora || false;

        if (isRed) {
            if (tileStr.startsWith('5m') || tileStr === '5m') return 34;  // red 5m
            if (tileStr.startsWith('5p') || tileStr === '5p') return 35;  // red 5p
            if (tileStr.startsWith('5s') || tileStr === '5s') return 36;  // red 5s
        }

        const basetile = this._strToBasetile(tileStr);
        if (basetile === null) return null;
        return basetile;  // 0-36 for basetiles 0-33
    }

    _strToBasetile(s) {
        s = String(s);
        const ch = s.charAt(s.length - 1);
        const num = parseInt(s);
        if (ch === 'm') return num - 1;
        if (ch === 'p') return num - 1 + 9;
        if (ch === 's') return num - 1 + 18;
        if (ch === 'z') return num - 1 + 27;
        return null;
    }

    _basetileToStr(bt) {
        if (bt == null || bt < 0 || bt >= 34) return '?';
        if (bt < 9) return `${bt + 1}m`;
        if (bt < 18) return `${bt - 9 + 1}p`;
        if (bt < 27) return `${bt - 18 + 1}s`;
        return `${bt - 27 + 1}z`;
    }

    _chiActionLabel(actionIdx, discardBt) {
        // 37=ChiLeft, 38=ChiMid, 39=ChiRight, 40-42 = same with red dora used
        const useRed = actionIdx >= 40;
        const kind = (actionIdx - 37) % 3;
        if (discardBt == null) return useRed ? '吃(赤)' : '吃';
        let a, b;
        if (kind === 0) { a = discardBt + 1; b = discardBt + 2; }
        else if (kind === 1) { a = discardBt - 1; b = discardBt + 1; }
        else { a = discardBt - 2; b = discardBt - 1; }
        const fmt = (bt) => {
            const s = this._basetileToStr(bt);
            // Mark red 5 (bt 4=5m, 13=5p, 22=5s) when red dora variant chosen
            if (useRed && (bt === 4 || bt === 13 || bt === 22)) return `${s[0]}*${s[1]}`;
            return s;
        };
        const dStr = this._basetileToStr(discardBt);
        return `吃 ${fmt(a)}${fmt(b)}+(${dStr})`;
    }

    _chiActionTiles(actionIdx, discardBt) {
        const kind = (actionIdx - 37) % 3;
        const useRed = actionIdx >= 40;
        let a, b;
        if (kind === 0) { a = discardBt + 1; b = discardBt + 2; }
        else if (kind === 1) { a = discardBt - 1; b = discardBt + 1; }
        else { a = discardBt - 2; b = discardBt - 1; }
        const fmt = (bt) => {
            const s = this._basetileToStr(bt);
            return useRed && (bt === 4 || bt === 13 || bt === 22) ? `${s}赤` : s;
        };
        return [fmt(a), fmt(b)];
    }

    // ─── Response Actions ───────────────────────────────────────────────────

    _showResponseActions(row) {
        if (!row || !this.state) return { ponActions: [], chiActions: [] };
        const validMask = this.state.valid_actions_mask || [];
        const canRon = validMask[49] === true;
        const ponActions = [43, 44].filter(i => validMask[i] === true);
        const canKan = validMask[46] === true;  // Minkan
        const chiActions = [37, 38, 39, 40, 41, 42].filter(i => validMask[i] === true);

        // If only pass is available, auto-skip without showing a button.
        if (!canRon && ponActions.length === 0 && !canKan && chiActions.length === 0) {
            if (validMask[53] === true) {
                const key = this._adviceStateKey();
                if (this._autoSubmitFailedKey === key) {
                    row.appendChild(this._makeBtn('跳过', 'btn-pass', () => this.submitAction(53), 53));
                } else {
                    this._autoSubmitFailedKey = null;
                    if (!this._actionInFlight && this._autoSubmittedKey !== key) {
                        this._autoSubmittedKey = key;
                        this.submitAction(53);
                    }
                }
            }
            return { ponActions, chiActions };
        }

        if (canRon) {
            row.appendChild(this._makeBtn('荣和', 'btn-ron', () => this.submitAction(49), 49));
        }
        if (ponActions.length) {
            row.appendChild(this._makeGroupBtn('碰', 'btn-pon', 'pon', ponActions));
        }
        if (canKan) {
            row.appendChild(this._makeBtn('杠', 'btn-minkan', () => this.submitAction(46), 46, '大明杠'));
        }
        if (chiActions.length) {
            row.appendChild(this._makeGroupBtn('吃', 'btn-chi', 'chi', chiActions));
        }
        if (validMask[53] === true) {
            row.appendChild(this._makeBtn('跳过', 'btn-pass', () => this.submitAction(53), 53));
        }
        this._updateStatus(`有人打出了 ${this._getLastDiscardStr() || '?'}`);
        return { ponActions, chiActions };
    }

    _actionMenuKey() {
        return this._adviceStateKey();
    }

    _openActionSelection(selection) {
        this.actionSelection = selection;
        this._actionSelectionKey = this._actionMenuKey();
        this._updateActionPanel();
    }

    _makeGroupBtn(label, cls, selection, candidates) {
        const btn = this._makeBtn(label, cls, () => this._openActionSelection(selection));
        btn.dataset.actionGroup = selection;
        const actionIdx = selection === 'ankan' ? 45 : selection === 'kakan' ? 47 : null;
        if (candidates.includes(this._currentAdvice()?.action_idx)
                || actionIdx === this._currentAdvice()?.action_idx) {
            btn.classList.add('is-recommended');
        }
        return btn;
    }

    _appendActionChoices(panel, selection, validMask) {
        const choices = document.createElement('div');
        choices.className = 'action-choice-layer';
        choices.setAttribute('role', 'group');
        choices.setAttribute('aria-label', '选择具体动作');

        const addChoice = (label, cls, actionIdx, detail, onChoose) => {
            const btn = this._makeBtn(label, cls, onChoose, actionIdx);
            if (detail) {
                btn.title = detail;
                btn.setAttribute('aria-label', detail);
            }
            choices.appendChild(btn);
        };

        if (selection === 'chi') {
            const discardBt = this._strToBasetile(this._getLastDiscardStr());
            [37, 38, 39, 40, 41, 42].filter(idx => validMask[idx] === true).forEach(idx => {
                const label = this._chiActionTiles(idx, discardBt).join(' + ');
                addChoice(label, 'btn-chi-choice', idx, this._chiActionLabel(idx, discardBt), () => {
                    this.actionSelection = null;
                    this.submitAction(idx);
                });
            });
        } else if (selection === 'pon') {
            [43, 44].filter(idx => validMask[idx] === true).forEach(idx => {
                const usesRed = idx === 44;
                addChoice(
                    usesRed ? '使用赤牌' : '普通牌',
                    'btn-pon-choice',
                    idx,
                    usesRed ? '碰 · 消耗一张赤牌' : '碰 · 不消耗赤牌',
                    () => {
                        this.actionSelection = null;
                        this.submitAction(idx);
                    },
                );
            });
        } else if (selection === 'ankan' || selection === 'kakan') {
            const actionIdx = selection === 'ankan' ? 45 : 47;
            const choicesForKan = this.state[`${selection}_choices`] || [];
            choicesForKan.forEach(tile => {
                addChoice(
                    `${selection === 'ankan' ? '暗杠' : '加杠'} ${this._basetileToStr(tile)}`,
                    selection === 'ankan' ? 'btn-ankan-choice' : 'btn-kakan-choice',
                    actionIdx,
                    '选择要杠的牌',
                    () => {
                        this.actionSelection = null;
                        this.submitAction(actionIdx, tile);
                    },
                );
            });
        } else if (selection === 'riichi') {
            const riichiDiscards = [...new Set(this.state.riichi_discards || [])]
                .filter(idx => Number.isInteger(idx) && idx >= 0 && idx <= 36 && validMask[idx] === true);
            riichiDiscards.forEach(idx => {
                const red = idx >= 34;
                const tile = red ? `5${'mps'[idx - 34]}` : this._basetileToStr(idx);
                const hand = this.state.players?.[0]?.hand || [];
                const handIndex = hand.findIndex(item => this._findDiscardAction(item) === idx);
                if (handIndex < 0) return;
                addChoice(
                    `打 ${tile}${red ? ' 赤' : ''}`,
                    'btn-riichi-choice',
                    idx,
                    '立直舍牌',
                    () => {
                        this.actionSelection = null;
                        this._submitRiichiStep1(idx, hand[handIndex], handIndex);
                    },
                );
            });
        }

        choices.appendChild(this._makeBtn('返回', 'btn-back', () => {
            this.actionSelection = null;
            this._actionSelectionKey = null;
            this._updateActionPanel();
        }));
        choices.dataset.choiceCount = String(choices.childElementCount - 1);
        panel.appendChild(choices);
    }

    _getLastDiscardStr() {
        // Find the most recently discarded (still-visible) tile across all rivers.
        // Cannot rely on (turn+3)%4 because in response phase `turn` is the
        // responder, who may be 2 or 3 seats from the discarder.
        const players = this.state?.players || [];
        let best = null;
        let bestNum = -1;
        for (const p of players) {
            const river = p?.river || [];
            for (let i = river.length - 1; i >= 0; i--) {
                const t = river[i];
                if (!t || t.remain === false) continue;
                const n = typeof t.number === 'number' ? t.number : i;
                if (n > bestNum) { bestNum = n; best = t; }
                break;
            }
        }
        if (!best) return null;
        return best.tile?.str || best.str || '?';
    }

    // ─── Render Loop ───────────────────────────────────────────────────────

    _render() {
        if (!this.state) return;
        this._refreshAdvice();
        this._applyAdviceHighlight();
        const { renderGame } = window.MahjongRenderer;
        renderGame(this.ctx, this.canvas.width, this.canvas.height, this.state, this.opts);
        this._updateUI();
    }

    _updateUI() {
        this._updateTopBar();
        this._updateActionPanel();
        this._updateAdviceDisplay();

        const statusEl = document.getElementById('statusMsg');
        if (statusEl) {
            if (this.state.is_over) {
                statusEl.textContent = '对局结束';
            } else if (this.state.turn === 0) {
                statusEl.textContent = '你的回合 — 请打出或回应';
            } else {
                statusEl.textContent = `P${this.state.turn} 思考中...`;
            }
        }

        if (this.state.is_over) {
            // Kyoku/hansou end is handled by SSE event handlers (toast + modal).
        }
    }

    _updateTopBar() {
        if (!this.state) return;
        const s = this.state;

        // Round info
        const windNames = ['东', '南', '西', '北'];
        const windKey = (w) => w === 'East' ? 0 : w === 'South' ? 1 : w === 'West' ? 2 : 3;
        document.querySelectorAll('.round-info').forEach(el => {
            el.textContent = `${windNames[windKey(s.game_wind)]}${(s.oya ?? 0) + 1}局`;
        });
        document.querySelectorAll('.honba').forEach(el => {
            el.textContent = `本场 ${s.honba || 0}`;
        });
        document.querySelectorAll('.riichibo').forEach(el => {
            el.textContent = `供托 ${s.kyoutaku || 0}`;
        });
        document.querySelectorAll('.tiles-left').forEach(el => {
            el.textContent = `牌山 ${s.tiles_left ?? '?'}`;
        });

        // Side-panel scoreboard
        const board = document.getElementById('scoreboard');
        if (board) {
            board.innerHTML = s.players.map((p, i) => {
                const cls = ['score-cell'];
                if (p.is_oya) cls.push('oya');
                if (i === s.turn) cls.push('active');
                if (p.riichi) cls.push('riichi');
                if (i === 0) cls.push('human');
                const w = windNames[windKey(p.wind)];
                return `<div class="${cls.join(' ')}">
                    <span class="label">${i === 0 ? '你' : 'P' + i} · ${w}${p.is_oya ? '(亲)' : ''}</span>
                    <span class="pts">${p.score}</span>
                </div>`;
            }).join('');
        }

        // Hansou stepper
        const stepper = document.getElementById('hansouStepper');
        if (stepper && s.hansou) {
            const total = (s.hansou.max_kyoku_index ?? 7) + 1;
            const curr = s.hansou.kyoku_index ?? 0;
            stepper.innerHTML = Array.from({ length: total }, (_, i) => {
                let cls = 'step';
                if (i < curr) cls += ' done';
                else if (i === curr) cls += ' current';
                const wind = windNames[Math.floor(i / 4)];
                const ki = (i % 4) + 1;
                return `<div class="${cls}">${wind}${ki}</div>`;
            }).join('');
        }

        // Legacy score chips (if any present)
        const chips = document.querySelectorAll('.score-chip');
        s.players.forEach((p, i) => {
            if (chips[i]) {
                chips[i].querySelector('.pid').textContent = `${i === 0 ? '你' : 'P' + i} · ${windNames[windKey(p.wind)]}`;
                chips[i].querySelector('.pts').textContent = p.score;
                chips[i].classList.toggle('oya', !!p.is_oya);
                chips[i].classList.toggle('human', i === 0);
                chips[i].classList.toggle('active', i === s.turn);
                chips[i].classList.toggle('riichi', !!p.riichi);
            }
        });

        // Dora
        const doraBar = document.querySelector('.dora-tiles');
        if (doraBar) {
            doraBar.innerHTML = (s.dora || []).map(d =>
                `<span class="mini-dora">${d}</span>`
            ).join('');
        }
    }

    _updateActionPanel() {
        const panel = document.getElementById('actionPanel');
        if (!panel) return;
        if (this.actionSelection && this._actionSelectionKey !== this._actionMenuKey()) {
            this.actionSelection = null;
            this._actionSelectionKey = null;
        }
        const gameOverAction = this.state?.is_over
            ? panel.querySelector('[data-game-over-action]')
            : null;
        panel.replaceChildren();
        panel.hidden = true;
        if (gameOverAction) {
            panel.appendChild(gameOverAction);
            panel.hidden = false;
            return;
        }
        if (!this.state || this.state.is_over || this.state.turn !== 0 ||
            this.mode === '4ai' || this._actionInFlight) return;

        const validMask = this.state.valid_actions_mask || [];
        const row = document.createElement('div');
        row.className = 'action-main-row';
        panel.appendChild(row);

        // Riichi stage 2 — waiting for confirm
        if (this.state.riichi_stage2) {
            if (validMask[48] === true) {
                row.appendChild(this._makeBtn('立直', 'btn-riichi', () => {
                    this.pendingRiichi = false;
                    this.submitAction(48);
                }, 48, '确认立直'));
            }
            if (validMask[52] === true) {
                row.appendChild(this._makeBtn('取消', 'btn-pass', () => {
                    this.pendingRiichi = false;
                    this.submitAction(52);
                }, 52, '取消立直'));
            }
            panel.hidden = row.childElementCount === 0;
            this._updateStatus('请确认是否立直');
            return;
        }

        // Response phase (Chi/Pon/Kan/Ron/Pass)
        const phase = this.state.phase || 0;
        if (phase >= 4 && phase < 16) {
            this._showResponseActions(row);
        } else {
            // Self-action phase
            if (validMask[45] === true) {
                const choices = this.state.ankan_choices || [];
                row.appendChild(choices.length > 1
                    ? this._makeGroupBtn('暗杠', 'btn-ankan', 'ankan', choices)
                    : this._makeBtn('暗杠', 'btn-ankan', () => this.submitAction(45, choices[0] ?? null), 45));
            }
            if (validMask[46] === true) {
                row.appendChild(this._makeBtn('大明杠', 'btn-minkan', () => this.submitAction(46), 46));
            }
            if (validMask[47] === true) {
                const choices = this.state.kakan_choices || [];
                row.appendChild(choices.length > 1
                    ? this._makeGroupBtn('加杠', 'btn-kakan', 'kakan', choices)
                    : this._makeBtn('加杠', 'btn-kakan', () => this.submitAction(47, choices[0] ?? null), 47));
            }
            if (validMask[48] === true && (this.state.riichi_discards || []).length > 0) {
                row.appendChild(this._makeGroupBtn('立直', 'btn-riichi', 'riichi', this.state.riichi_discards));
            }
            if (validMask[50] === true) {
                row.appendChild(this._makeBtn('自摸', 'btn-tsumo', () => this.submitAction(50), 50));
            }
            if (validMask[51] === true) {
                row.appendChild(this._makeBtn('九种九牌', 'btn-kyushu', () => this.submitAction(51), 51));
            }
        }

        if (this.actionSelection && row.childElementCount > 0) {
            this._appendActionChoices(panel, this.actionSelection, validMask);
        }
        panel.hidden = row.childElementCount === 0;
        // Discard tiles are handled by canvas click
    }

    _makeBtn(label, cls, onClick, actionIdx = null, detail = null) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `action-btn ${cls}`;
        if (actionIdx != null) btn.dataset.actionIdx = String(actionIdx);
        if (actionIdx != null && this._currentAdvice()?.action_idx === actionIdx) {
            btn.classList.add('is-recommended');
        }
        const text = document.createElement('span');
        text.className = 'action-btn-label';
        text.textContent = label;
        btn.appendChild(text);
        if (detail) {
            const description = document.createElement('span');
            description.className = 'action-btn-detail';
            description.textContent = detail;
            btn.appendChild(description);
        }
        btn.title = detail ? `${label} · ${detail}` : label;
        btn.setAttribute('aria-label', btn.title);
        btn.onclick = onClick;
        return btn;
    }

    _updateStatus(msg) {
        const el = document.getElementById('statusMsg');
        if (el) el.textContent = msg;
    }

    _showAIMove(player, actionIdx) {
        const actionNames = [
            '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌',
            '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌',
            '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌',
            '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌', '摸牌',
            '吃(左)', '吃(中)', '吃(右)',
            '吃+赤(左)', '吃+赤(中)', '吃+赤(右)',
            '碰', '碰+赤', '暗杠', '大明杠', '加杠', '立直', '荣和', '自摸', '通过', '确认立直', '跳过'
        ];
        const name = actionNames[actionIdx] || `动作${actionIdx}`;
        const el = document.getElementById('statusMsg');
        if (el) el.textContent = `P${player} 执行: ${name}`;
    }

    _showResultModal() {
        if (document.getElementById('resultModal')) return;
        const r = this.state.result;
        if (!r) return;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'resultModal';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        const modal = document.createElement('div');
        modal.className = 'modal';
        const typeNames = {
            'RonAgari': '荣和',
            'TsumoAgari': '自摸',
            'Ryukyouku_9Hai': '九种九牌',
            'Ryukyouku_4Wind': '四风连打',
            'Ryukyouku_4Riichi': '四立直',
            'Ryukyouku_4Kan': '四杠子',
            'Ryukyouku_Notile': '流局',
        };
        const losers = Array.isArray(r.loser) ? r.loser : (r.loser != null ? [r.loser] : []);
        const isTsumo = r.type === 'TsumoAgari';
        const showLoserBadge = !isTsumo;
        modal.innerHTML = `
            <h2>${typeNames[r.type] || r.type || '对局结束'}</h2>
            <div class="result-scores">
                ${(r.scores || []).map((s, i) => `
                    <div class="result-row ${(r.winner || []).includes(i) ? 'winner' : ''}">
                        <span>P${i}${showLoserBadge && losers.includes(i) ? ' (放铳)' : ''}</span>
                        <span>${s}点</span>
                    </div>
                `).join('')}
            </div>
            ${r.winner?.length ? `<p>胜利: P${r.winner.join(', P')}</p>` : ''}
            <button class="action-btn btn-confirm mt-16" onclick="document.getElementById('resultModal').remove()">确定</button>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    _showKyokuEndToast(data) {
        const rec = data.record || {};
        const typeNames = {
            'RonAgari': '荣和', 'TsumoAgari': '自摸',
            'Ryukyouku_Notile': '流局', 'Ryukyouku_9Hai': '九种九牌',
            'Ryukyouku_4Wind': '四风连打', 'Ryukyouku_4Riichi': '四立直',
            'Ryukyouku_4Kan': '四杠子',
        };
        const t = typeNames[rec.result_type] || rec.result_type || '局结束';
        const isTsumo = rec.result_type === 'TsumoAgari';
        const showLoser = !isTsumo && !t.includes('流局');
        const winners = (rec.winner || []).map(i => i === 0 ? '你' : `P${i}`).join(',');
        const losers = rec.loser != null ? (rec.loser === 0 ? '你' : `P${rec.loser}`) : '';
        let msg = `${data.round_label || ''} ${t}`;
        if (winners) msg += ` 胜者:${winners}`;
        if (losers && showLoser) msg += ` 放铳:${losers}`;
        if (rec.renchan) msg += ' (连庄)';

        // Show result modal for a few seconds
        if (document.getElementById('kyokuResultModal')) {
            document.getElementById('kyokuResultModal').remove();
        }
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'kyokuResultModal';
        const modal = document.createElement('div');
        modal.className = 'modal';
        const scoreDelta = (rec.scores_out || []).map((s, i) => {
            const diff = s - (rec.scores_in || [])[i];
            const sign = diff > 0 ? '+' : '';
            return `<div class="result-row ${diff > 0 ? 'winner' : diff < 0 ? 'loser' : ''}">
                <span>${i === 0 ? '你' : 'P' + i}</span>
                <span>${s}点 (${sign}${diff})</span>
            </div>`;
        }).join('');
        modal.innerHTML = `
            <h2>${data.round_label || '局结束'} ${t}</h2>
            ${winners ? `<p>胜者: ${winners}</p>` : ''}
            ${losers && showLoser ? `<p>放铳: ${losers}</p>` : ''}
            ${rec.renchan ? '<p>连庄</p>' : ''}
            <div class="result-scores">${scoreDelta}</div>
            <p style="margin-top:12px;color:#888;font-size:13px">下一局即将开始...</p>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Auto-dismiss after 2.5 seconds (backend has 2s delay)
        setTimeout(() => {
            const el = document.getElementById('kyokuResultModal');
            if (el) el.remove();
        }, 2500);
    }

    _onGameOver(state, data) {
        if (document.getElementById('resultModal')) return;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'resultModal';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        const modal = document.createElement('div');
        modal.className = 'modal';
        const finalScores = (data && data.final_scores) || (state.players || []).map(p => p.score);
        const ranked = finalScores.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s);
        modal.innerHTML = `
            <h2>半庄结束</h2>
            <div class="result-scores">
                ${ranked.map((r, rank) => `
                    <div class="result-row ${rank === 0 ? 'winner' : ''}">
                        <span>${rank + 1}位 · P${r.i}${r.i === 0 ? '(你)' : ''}</span>
                        <span>${r.s}点</span>
                    </div>
                `).join('')}
            </div>
            <button class="action-btn btn-confirm mt-16" onclick="document.getElementById('resultModal').remove(); if(typeof showLanding==='function') showLanding();">返回主页</button>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────

    destroy() {
        this._stopSSE();
        if (this._animFrame) cancelAnimationFrame(this._animFrame);
    }
}

// ─── Export ─────────────────────────────────────────────────────────────────

window.MahjongGame = MahjongGame;
