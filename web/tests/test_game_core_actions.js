const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

class Element {
    constructor(tagName) {
        this.tagName = tagName;
        this.className = '';
        this.children = [];
        this.dataset = {};
        this.attributes = {};
        this.hidden = false;
        this.textContent = '';
        this.classList = {
            add: (name) => {
                const names = new Set(this.className.split(/\s+/).filter(Boolean));
                names.add(name);
                this.className = [...names].join(' ');
            },
        };
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    replaceChildren(...children) {
        this.children = [...children];
    }

    get childElementCount() {
        return this.children.length;
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    querySelector() {
        return null;
    }
}

const panel = new Element('div');
const status = new Element('div');
const document = {
    createElement: (tagName) => new Element(tagName),
    getElementById: (id) => id === 'actionPanel' ? panel : status,
};
const context = { document, window: {}, console };
vm.runInNewContext(
    `${fs.readFileSync(path.join(root, 'static/js/game_core.js'), 'utf8')}\nglobalThis.Game = MahjongGame;`,
    context,
);
const Game = context.Game;

function makeGame(state) {
    const game = Object.create(Game.prototype);
    game.mode = 'human_ai';
    game.state = state;
    game.actionSelection = null;
    game._actionSelectionKey = null;
    game._actionInFlight = false;
    game._autoSubmitFailedKey = null;
    game._autoSubmittedKey = null;
    game._currentAdvice = () => null;
    game._adviceStateKey = () => 'fixed-test-state';
    game._updateStatus = () => {};
    return game;
}

function label(button) {
    return button.children.find(child => child.className === 'action-btn-label')?.textContent;
}

function layer(className) {
    return panel.children.find(child => child.className === className);
}

function actionMask(indices) {
    const mask = Array(54).fill(false);
    indices.forEach(index => { mask[index] = true; });
    return mask;
}

test('chi and pon show one action first, then submit the selected legal variant', () => {
    const game = makeGame({
        turn: 0,
        phase: 5,
        valid_actions_mask: actionMask([37, 38, 40, 43, 44, 53]),
        players: [
            { hand: [] },
            { river: [{ number: 1, tile: { str: '3m' } }] },
            { river: [] },
            { river: [] },
        ],
    });
    const submitted = [];
    game.submitAction = (index) => submitted.push(index);

    game._updateActionPanel();
    let main = layer('action-main-row');
    assert.deepEqual(main.children.map(label), ['碰', '吃', '跳过']);
    assert.equal(layer('action-choice-layer'), undefined);

    main.children.find(button => button.dataset.actionGroup === 'chi').onclick();
    let choices = layer('action-choice-layer');
    assert.deepEqual(choices.children.map(label), ['4m + 5m', '2m + 4m', '4m + 5m赤', '返回']);
    choices.children.find(button => button.dataset.actionIdx === '40').onclick();
    assert.deepEqual(submitted, [40]);

    game.actionSelection = null;
    game._updateActionPanel();
    layer('action-main-row').children.find(button => button.dataset.actionGroup === 'pon').onclick();
    choices = layer('action-choice-layer');
    assert.deepEqual(choices.children.map(label), ['普通牌', '使用赤牌', '返回']);
    choices.children.find(button => button.dataset.actionIdx === '44').onclick();
    assert.deepEqual(submitted, [40, 44]);
});

test('group buttons identify the exact recommended chi choice', () => {
    const game = makeGame({
        turn: 0,
        phase: 5,
        valid_actions_mask: actionMask([38, 41, 53]),
        players: [
            { hand: [] },
            { river: [{ number: 1, tile: { str: '4p' } }] },
            { river: [] },
            { river: [] },
        ],
    });
    game._currentAdvice = () => ({ action_idx: 41 });
    game.submitAction = () => {};

    game._updateActionPanel();
    const chi = layer('action-main-row').children.find(
        button => button.dataset.actionGroup === 'chi',
    );
    assert.equal(chi.children.find(child => child.className === 'action-btn-detail').textContent,
        '推荐 3p + 5p赤');
    assert.match(chi.className, /is-recommended/);

    chi.onclick();
    const choices = layer('action-choice-layer');
    const recommended = choices.children.find(button => button.dataset.actionIdx === '41');
    assert.equal(label(recommended), '3p + 5p赤');
    assert.match(recommended.className, /is-recommended/);
});

test('riichi expands to engine-provided discard choices after selection', () => {
    const game = makeGame({
        turn: 0,
        phase: 0,
        valid_actions_mask: actionMask([4, 34, 48]),
        riichi_discards: [4, 34],
        players: [{
            hand: [
                { str: '5m', red_dora: false },
                { str: '5m', red_dora: true },
            ],
        }],
    });
    const submitted = [];
    game._submitRiichiStep1 = (index, tile, handIndex) => submitted.push({ index, tile, handIndex });

    game._updateActionPanel();
    let main = layer('action-main-row');
    assert.deepEqual(main.children.map(label), ['立直']);
    assert.equal(layer('action-choice-layer'), undefined);

    main.children[0].onclick();
    const choices = layer('action-choice-layer');
    assert.deepEqual(choices.children.map(label), ['打 5m', '打 5m 赤', '返回']);
    choices.children.find(button => button.dataset.actionIdx === '34').onclick();
    assert.deepEqual(submitted, [{ index: 34, tile: { str: '5m', red_dora: true }, handIndex: 1 }]);
});

test('multiple kan candidates appear only after selecting the kan action', () => {
    const game = makeGame({
        turn: 0,
        phase: 0,
        valid_actions_mask: actionMask([45]),
        ankan_choices: [4, 15],
        players: [{ hand: [] }],
    });
    const submitted = [];
    game.submitAction = (...args) => submitted.push(args);

    game._updateActionPanel();
    const main = layer('action-main-row');
    assert.deepEqual(main.children.map(label), ['暗杠']);
    assert.equal(layer('action-choice-layer'), undefined);

    main.children[0].onclick();
    const choices = layer('action-choice-layer');
    assert.deepEqual(choices.children.map(label), ['暗杠 5m', '暗杠 7p', '返回']);
    choices.children[1].onclick();
    assert.deepEqual(submitted, [[45, 15]]);
});

test('action buttons use the requested colors and place choices above the centered hand row', () => {
    const css = fs.readFileSync(path.join(root, 'static/css/play.css'), 'utf8');
    assert.match(css, /\.action-panel\s*\{[^}]*left:\s*calc\([^;]*\.5\)/s);
    assert.match(css, /\.action-choice-layer\s*\{[^}]*bottom:\s*calc\(100%\s*\+/s);
    assert.match(css, /\.btn-chi[\s\S]*?--brush-fill:\s*linear-gradient\(135deg,\s*#54b879/);
    assert.match(css, /\.btn-pon[\s\S]*?--brush-fill:\s*linear-gradient\(135deg,\s*#e4686c/);
});
