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
        // Expected if DOM initialization encounters null elements
    }
    return sandbox;
}

test('hybridConfluenceSignal: activates Straddle OCO when high impact news < 2m', () => {
    const box = createSandbox();
    const now = Date.parse('2026-11-13T12:00:00Z');
    const event = {
        Event: 'US CPI m/m',
        Importance: 3,
        Date: '2026-11-13T12:01:30Z' // 90 seconds away
    };
    const bars = [];
    for (let i = 0; i < 30; i++) {
        bars.push({ o: 3900 + i * 0.1, h: 3902 + i * 0.1, l: 3899 + i * 0.1, c: 3901 + i * 0.1 });
    }
    const res = box.hybridConfluenceSignal({
        kind: 'gold',
        asset: 'XAU/USD',
        event,
        now,
        price: 3903.0,
        bars
    });
    assert.equal(res.mode, 'STRADDLE');
    assert.equal(res.dir, 'straddle');
    assert.ok(res.buyStop > 3903.0);
    assert.ok(res.sellStop < 3903.0);
    assert.ok(res.slBuy < res.buyStop);
    assert.ok(res.slSell > res.sellStop);
});

test('hybridConfluenceSignal: blocks BUY in extreme overbought (RSI > 68)', () => {
    const box = createSandbox();
    const now = Date.parse('2026-11-13T12:00:00Z');
    // Rapid vertical price spike causing extreme RSI
    const bars = [];
    for (let i = 0; i < 35; i++) {
        const p = 3800 + i * 4;
        bars.push({ o: p - 1, h: p + 3, l: p - 2, c: p + 2 });
    }
    const res = box.hybridConfluenceSignal({
        kind: 'gold',
        asset: 'XAU/USD',
        now,
        price: 3940.0,
        bars
    });
    assert.equal(res.dir, 'wait');
    assert.match(res.reason, /WAIT/);
});

test('hybridConfluenceSignal: recognizes Bullish Trend and SMC Confluence', () => {
    const box = createSandbox();
    const now = Date.parse('2026-11-13T12:00:00Z');
    const bars = [];
    // Upward trend with a sweep-low pullback
    for (let i = 0; i < 35; i++) {
        const p = 1.0800 + i * 0.0004;
        bars.push({ o: p, h: p + 0.0006, l: p - 0.0003, c: p + 0.0003 });
    }
    // Recent sweep low candle and retest
    const lastP = 1.0800 + 35 * 0.0004;
    bars.push({ o: lastP, h: lastP + 0.0005, l: lastP - 0.0012, c: lastP + 0.0002 }); // wick sweep low
    bars.push({ o: lastP + 0.0002, h: lastP + 0.0008, l: lastP + 0.0001, c: lastP + 0.0007 }); // bounce

    const res = box.hybridConfluenceSignal({
        kind: 'forex',
        asset: 'EUR/USD',
        now,
        price: lastP + 0.0007,
        bars
    });
    assert.ok(res.score > 0);
    assert.ok(Array.isArray(res.factors));
});
