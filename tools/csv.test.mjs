import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv, toCsvBody, csvCell } from '../packages/catalog/dist/index.js';
import { buildShowProfiles, generateOrders, generateBurst, ORDER_COLUMNS } from './lib/generator.mjs';

process.env.TZ = 'America/New_York';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parses quoted fields containing commas, quotes and newlines', () => {
  const rows = parseCsv('a,b\n"x, y","he said ""hi"""\n"multi\nline",z\n');
  assert.deepEqual(rows, [
    { a: 'x, y', b: 'he said "hi"' },
    { a: 'multi\nline', b: 'z' },
  ]);
});

test('handles CRLF line endings and a BOM', () => {
  const rows = parseCsv('﻿a,b\r\n1,2\r\n');
  assert.deepEqual(rows, [{ a: '1', b: '2' }]);
});

test('round-trips rows through the writer', () => {
  const rows = [{ show: 'Harry Potter and the Cursed Child, Parts One and Two', gross: '10.00' }];
  assert.deepEqual(parseCsv(toCsv(rows, ['show', 'gross'])), rows);
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
});

test('toCsvBody omits the header so it can be appended', () => {
  const body = toCsvBody([{ a: '1', b: '2' }], ['a', 'b']);
  assert.equal(body, '1,2\n');
});

const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));

test('show profiles carry real Broadway shows, theatres and prices', () => {
  assert.ok(profiles.length >= 8);
  for (const p of profiles) {
    assert.ok(p.show && p.theatre, 'show and theatre are named');
    assert.ok(p.seatsInTheatre > 400 && p.seatsInTheatre < 2200, `plausible house size: ${p.seatsInTheatre}`);
    assert.ok(p.avgTicketPrice > 40 && p.avgTicketPrice < 400, `plausible price: ${p.avgTicketPrice}`);
    assert.ok(p.weekly.length >= 8, 'keeps the real week-by-week curve');
  }
});

test('generation is deterministic for a given seed', () => {
  const args = { profiles, from: '2026-06-01T00:00:00', to: '2026-06-08T00:00:00', seed: 42 };
  assert.deepEqual(generateOrders(args), generateOrders(args));
});

test('generated orders are well formed and internally consistent', () => {
  const orders = generateOrders({
    profiles,
    from: '2026-06-01T00:00:00',
    to: '2026-06-08T00:00:00',
    seed: 42,
  });
  assert.ok(orders.length > 100, `expected a week of sales, got ${orders.length}`);

  const ids = new Set();
  let previous = '';
  for (const o of orders) {
    assert.match(o.order_id, /^ORD-\d{7}$/);
    assert.ok(!ids.has(o.order_id), 'order ids are unique');
    ids.add(o.order_id);
    assert.ok(o.ordered_at >= previous, 'rows are ordered by purchase time');
    previous = o.ordered_at;
    assert.ok(o.ordered_at >= '2026-06-01' && o.ordered_at <= '2026-06-08T23', 'inside the window');
    assert.ok(o.event_date >= o.ordered_at.slice(0, 10), 'nobody buys a ticket after the curtain');
    assert.equal(Number(o.gross).toFixed(2), (Number(o.unit_price) * o.quantity).toFixed(2));
    assert.ok(Object.keys(o).length === ORDER_COLUMNS.length);
  }
});

test('average ticket price tracks the real season average within 10%', () => {
  const orders = generateOrders({ profiles, from: '2026-06-01', to: '2026-07-01', seed: 7 });
  const tickets = orders.reduce((s, o) => s + o.quantity, 0);
  const gross = orders.reduce((s, o) => s + Number(o.gross), 0);
  const real = profiles.reduce((s, p) => s + p.avgTicketPrice, 0) / profiles.length;
  const ratio = gross / tickets / real;
  assert.ok(ratio > 0.9 && ratio < 1.1, `generated/real average price ratio was ${ratio.toFixed(3)}`);
});

test('promo codes are only ever redeemed by a segment that qualifies', () => {
  const allowed = {
    STUDENT: ['Student'],
    MEMBER10: ['Member'],
    GROUP20: ['Group'],
    RUSH25: ['Local', 'Student'],
  };
  for (const o of generateOrders({ profiles, from: '2026-06-01', to: '2026-06-15', seed: 3 })) {
    if (allowed[o.promo_code]) {
      assert.ok(
        allowed[o.promo_code].includes(o.customer_segment),
        `${o.promo_code} should not be redeemable by ${o.customer_segment}`,
      );
    }
  }
});

test('a burst lands in the recent past and sells future performances', () => {
  const now = Date.now();
  const rows = generateBurst({ profiles, count: 30, spreadSeconds: 60, seed: 11 });
  assert.equal(rows.length, 30);
  for (const row of rows) {
    const ordered = new Date(row.ordered_at).getTime();
    assert.ok(now - ordered <= 61_000 && ordered <= now + 1000, 'ordered within the last minute');
    assert.ok(row.event_date >= row.ordered_at.slice(0, 10), 'the performance is still to come');
    assert.ok(Number(row.unit_price) >= 22);
  }
});
