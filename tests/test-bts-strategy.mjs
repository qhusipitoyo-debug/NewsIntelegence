import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('index.html', 'utf-8');
const scriptMatches = [...html.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/gi)];
const code = scriptMatches.map(m => m[1]).join('\n;\n');

function createSandbox() {
    const sandbox = {
        console,
        Date,
        Math,
        Number,
        String,
        Array,
        Object,
        JSON,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        localStorage: {
            _store: {},
            getItem(k) { return this._store[k] || null; },
            setItem(k, v) { this._store[k] = String(v); },
            removeItem(k) { delete this._store[k]; }
        },
        document: {
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            createElement() {
                return {
                    classList: { add() {}, remove() {}, toggle() {} },
                    setAttribute() {},
                    appendChild() {},
                    style: {}
                };
            }
        },
        window: {}
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    try {
        vm.runInContext(code, sandbox);
    } catch (e) {
        // Expected DOM initialization null catch
    }
    return sandbox;
}

test('calcCCI: calculates accurate Donald Lambert CCI using Median Price (HL/2)', () => {
    const box = createSandbox();
    assert.equal(typeof box.calcCCI, 'function');

    // Create 50 bars of constant price
    const flatBars = Array.from({ length: 50 }, () => ({ h: 100, l: 100, c: 100 }));
    const flatCCI = box.calcCCI(flatBars, 45);
    assert.equal(flatCCI.length, 50);
    // When price is completely flat (MD=0), CCI must be 0
    assert.equal(flatCCI[49], 0);

    // Create 45 bars with known values
    const bars = [];
    for (let i = 0; i < 45; i++) {
        bars.push({ h: 100 + i, l: 90 + i, c: 95 + i });
    }
    const cci = box.calcCCI(bars, 45);
    assert.equal(cci.length, 45);
    // Last bar should have a positive CCI because it is the highest
    assert.ok(cci[44] > 50, `Expected cci[44] > 50, got ${cci[44]}`);
});

test('calcEMA: calculates accurate exponential moving average', () => {
    const box = createSandbox();
    assert.equal(typeof box.calcEMA, 'function');

    const values = [10, 10, 10, 20, 20, 20];
    const ema = box.calcEMA(values, 3);
    assert.equal(ema.length, 6);
    assert.equal(ema[0], 10);
    assert.equal(ema[1], 10);
    assert.equal(ema[2], 10);
    // k = 2 / (3 + 1) = 0.5
    // ema[3] = 20 * 0.5 + 10 * 0.5 = 15
    assert.equal(ema[3], 15);
    // ema[4] = 20 * 0.5 + 15 * 0.5 = 17.5
    assert.equal(ema[4], 17.5);
});

test('btsStrategySignal: triggers BUY when CCI rebounds from <= -190', () => {
    const box = createSandbox();
    assert.equal(typeof box.btsStrategySignal, 'function');

    // Generate 60 bars baseline around 3900
    const bars = [];
    for (let i = 0; i < 50; i++) {
        bars.push({ o: 3900, h: 3902, l: 3898, c: 3900 });
    }
    // Deep dip causing CCI <= -190
    for (let i = 0; i < 5; i++) {
        const p = 3880 - i * 3;
        bars.push({ o: p + 1, h: p + 2, l: p - 2, c: p });
    }
    // Rebound bar crossing back up
    bars.push({ o: 3875, h: 3890, l: 3874, c: 3889 });

    const res = box.btsStrategySignal({
        kind: 'gold',
        asset: 'XAU/USD',
        price: 3889.0,
        bars
    });

    assert.equal(res.dir, 'long');
    assert.equal(res.mode, 'BTS_ACTIVE');
    assert.ok(res.score >= 80, `Expected score >= 80, got ${res.score}`);
    assert.ok(res.levels !== null);
    assert.equal(res.levels.entry, 3889.0);
    // Gold SL must be strictly <= $8.50
    assert.ok(res.levels.slDist <= 8.50, `Expected SL dist <= 8.50, got ${res.levels.slDist}`);
    assert.ok(res.levels.sl < res.levels.entry);
    assert.ok(res.levels.tp > res.levels.entry);
});

test('btsStrategySignal: triggers SELL when CCI rejects from >= +100', () => {
    const box = createSandbox();
    assert.equal(typeof box.btsStrategySignal, 'function');

    // Generate 60 bars baseline around 3900
    const bars = [];
    for (let i = 0; i < 50; i++) {
        bars.push({ o: 3900, h: 3902, l: 3898, c: 3900 });
    }
    // Strong upward rally reaching overbought >= 100
    for (let i = 0; i < 5; i++) {
        const p = 3915 + i * 4;
        bars.push({ o: p - 1, h: p + 3, l: p - 2, c: p + 2 });
    }
    // Rejection bar crossing back below 100
    bars.push({ o: 3915, h: 3916, l: 3900, c: 3901 });

    const res = box.btsStrategySignal({
        kind: 'gold',
        asset: 'XAU/USD',
        price: 3901.0,
        bars
    });

    assert.equal(res.dir, 'short');
    assert.equal(res.mode, 'BTS_ACTIVE');
    assert.ok(res.score >= 80, `Expected score >= 80, got ${res.score}`);
    assert.ok(res.levels !== null);
    assert.equal(res.levels.entry, 3901.0);
    // Gold SL must be strictly <= $8.50
    assert.ok(res.levels.slDist <= 8.50, `Expected SL dist <= 8.50, got ${res.levels.slDist}`);
    assert.ok(res.levels.sl > res.levels.entry);
    assert.ok(res.levels.tp < res.levels.entry);
});

test('hybridConfluenceSignal integrates BTS Strategy factor', () => {
    const box = createSandbox();
    const bars = [];
    for (let i = 0; i < 50; i++) {
        bars.push({ o: 3900, h: 3902, l: 3898, c: 3900 });
    }
    // Deep dip
    for (let i = 0; i < 5; i++) {
        const p = 3880 - i * 3;
        bars.push({ o: p + 1, h: p + 2, l: p - 2, c: p });
    }
    // Rebound
    bars.push({ o: 3875, h: 3890, l: 3874, c: 3889 });

    const res = box.hybridConfluenceSignal({
        kind: 'gold',
        asset: 'XAU/USD',
        price: 3889.0,
        bars
    });

    assert.ok(res.bts !== null, 'Expected res.bts to be populated');
    assert.equal(res.bts.dir, 'long');
    assert.ok(res.bts.factors.some(f => f.includes('CCI(45) Rebound')), 'Expected BTS rebound factor');
});
