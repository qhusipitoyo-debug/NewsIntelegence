import assert from 'node:assert/strict';
import { updatePreNewsStore } from '../scripts/fetch-calendar.mjs';

const now = Date.parse('2026-10-28T00:00:00Z');
const min = 60 * 1000;
const soon = new Date(now + 10 * min).toISOString();
const within = new Date(now + 90 * min).toISOString();
const tooFar = new Date(now + 3 * 60 * min).toISOString();
const passed = new Date(now - min).toISOString();

const events = [
  { Date: soon, Event: 'CPI', Importance: 3 },
  { Date: within, Event: 'Retail Sales', Importance: 2 },
  { Date: soon, Event: 'Low impact', Importance: 1 },
  { Date: tooFar, Event: 'Too far', Importance: 3 },
  { Date: passed, Event: 'Already out', Importance: 3 },
];

const market = {
  price: 4000,
  forex: { EUR: 0.92, GBP: 0.79, JPY: 150, CHF: 0.88, AUD: 0.65, CAD: 1.36 },
  crypto: { 'BTC/USD': 65000, 'ETH/USD': 3200 },
  indices: { US500: 5800 },
};

const store = updatePreNewsStore({}, events, market, now);
assert.equal(store[`${soon}|CPI`].gold, 4000);
assert.equal(store[`${soon}|CPI`].forex.EUR, 0.92);
assert.equal(store[`${soon}|CPI`].crypto['BTC/USD'], 65000);
assert.equal(store[`${soon}|CPI`].indices.US500, 5800);
assert.equal(store[`${soon}|CPI`].capturedAt, new Date(now).toISOString());
assert.equal(store[`${soon}|CPI`].price, undefined);
assert.equal(store[`${within}|Retail Sales`].gold, 4000);
assert.equal(store[`${soon}|Low impact`], undefined);
assert.equal(store[`${tooFar}|Too far`], undefined);
assert.equal(store[`${passed}|Already out`], undefined);

const refreshed = updatePreNewsStore({
  [`${soon}|CPI`]: { gold: 3980, forex: { EUR: 0.94, GBP: 0.80 }, crypto: { 'BTC/USD': 62000 }, capturedAt: new Date(now - 5 * min).toISOString() },
}, events, market, now);
assert.equal(refreshed[`${soon}|CPI`].gold, 4000);
assert.equal(refreshed[`${soon}|CPI`].forex.EUR, 0.92);
assert.equal(refreshed[`${soon}|CPI`].forex.GBP, 0.79);
assert.equal(refreshed[`${soon}|CPI`].crypto['BTC/USD'], 65000);
assert.equal(refreshed[`${soon}|CPI`].indices.US500, 5800);

const oldEvent = new Date(now - 8 * 24 * 60 * min).toISOString();
const keptEvent = new Date(now - 2 * 24 * 60 * min).toISOString();
const oldKey = `${oldEvent}|Old`;
const keptKey = `${keptEvent}|Keep`;
const pruned = updatePreNewsStore({
  [oldKey]: { gold: 3900, capturedAt: oldEvent },
  [keptKey]: { gold: 3910, capturedAt: keptEvent },
}, [], null, now);
assert.deepEqual(Object.keys(pruned), [keptKey]);

const kept = updatePreNewsStore({ [keptKey]: { gold: 3910, capturedAt: keptEvent } }, events, null, now);
assert.equal(kept[keptKey].gold, 3910);

// Legacy {price} entries are normalized to gold and merged with fresh forex data.
const legacyKey = `${soon}|CPI`;
const legacy = updatePreNewsStore({
  [legacyKey]: { price: 3910, forex: { GBP: 0.80 }, capturedAt: new Date(now - 5 * min).toISOString() },
}, events, { forex: { EUR: 0.93 } }, now);
assert.equal(legacy[legacyKey].gold, 3910);
assert.equal(legacy[legacyKey].price, undefined);
assert.equal(legacy[legacyKey].forex.EUR, 0.93);
assert.equal(legacy[legacyKey].forex.GBP, 0.80);

console.log('Passed pre-news per-pair snapshot tests (2h window, merge, prune, fallback)');
