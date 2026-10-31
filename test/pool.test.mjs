// node --test test/   (no network: Printify and PayPal are mocked)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePool, printifyCost, paypalFacts, readLedger, estimateFee, POOL_START } from '../api/_lib/pool.js';
import { CATALOG } from '../api/fulfill.js';

const EMPTY = { refunds: [], payouts: [] };
const ts = (iso) => new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00:00');
let seq = 0;
function pOrder({ ppId, created = '2026-11-02T15:00:00Z', status = 'fulfilled', price = 1593, ship = 495, tax = 112, items, meta = {} }) {
  seq++;
  return {
    id: 'pf' + seq, status, created_at: ts(created), total_price: price, total_shipping: ship, total_tax: tax,
    address_to: { first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', address1: '1 Secret Ln', phone: '5551234567' },
    line_items: items || [{ product_id: '69dc4507f6f60e22c60dec14', variant_id: 12125, quantity: 1, cost: price, shipping_cost: ship, status: 'fulfilled' }],
    metadata: { order_type: 'api', shop_order_id: ppId, shop_order_label: 'DoG web ' + ppId, ...meta },
  };
}
function ppOrder(gross, fee, status = 'COMPLETED') {
  const v = (n) => ({ currency_code: 'USD', value: n.toFixed(2) });
  return { status: 'COMPLETED', payer: { email_address: 'jane@example.com', name: { given_name: 'Jane' } },
    purchase_units: [{ payments: { captures: [{ id: 'CAP1', status, amount: v(gross),
      seller_receivable_breakdown: { gross_amount: v(gross), ...(fee == null ? {} : { paypal_fee: v(fee) }), net_amount: v(gross - (fee || 0)) } }] } }] };
}
const run = (orders, pp, ledger = EMPTY, extra = {}) => computePool({ orders, paypal: async (id) => pp[id] || null, ledger, catalog: CATALOG, now: new Date('2026-11-05T12:00:00Z'), ...extra });

test('math: one tee, actual PayPal fee and actual Printify charge', async () => {
  // revenue 40.99, Printify 15.93+4.95+1.12 = 22.00, fee 1.92 -> profit 17.07 -> 25% = 4.2675 -> $4.27
  const r = await run([pOrder({ ppId: 'AAAA1111BBBB2222' })], { AAAA1111BBBB2222: ppOrder(40.99, 1.92) });
  assert.equal(r.set_aside, 4.27); assert.equal(r.orders_counted, 1); assert.equal(r.held, 4.27);
  assert.equal(r.pending_estimates, false); assert.equal(r.fee_estimates, false);
  assert.equal(r.basis, '25% of profit after print, shipping, and PayPal fees');
  assert.equal(r.start_date, POOL_START);
});

test('negative-profit order contributes $0 (not negative)', async () => {
  const loss = pOrder({ ppId: 'LOSS0000LOSS0000', price: 4000, ship: 900, tax: 300 }); // costs 52.00 > 40.99
  const good = pOrder({ ppId: 'GOOD0000GOOD0000' });
  const r = await run([loss, good], { LOSS0000LOSS0000: ppOrder(40.99, 1.92), GOOD0000GOOD0000: ppOrder(40.99, 1.92) });
  assert.equal(r.set_aside, 4.27); assert.equal(r.orders_counted, 2);
});

test('refunds: ledger reverse and PayPal REFUNDED capture both remove the order', async () => {
  const a = pOrder({ ppId: 'REFD0000LEDG0000' }), b = pOrder({ ppId: 'REFD0000PYPL0000' }), c = pOrder({ ppId: 'KEEP0000KEEP0000' });
  const pp = { REFD0000LEDG0000: ppOrder(40.99, 1.92), REFD0000PYPL0000: ppOrder(40.99, 1.92, 'REFUNDED'), KEEP0000KEEP0000: ppOrder(40.99, 1.92) };
  const ledger = { refunds: [{ orderId: 'REFD0000LEDG0000', reverse: true, note: 'returned' }], payouts: [] };
  const r = await run([a, b, c], pp, ledger);
  assert.equal(r.set_aside, 4.27); assert.equal(r.orders_counted, 1); assert.equal(r.refunds_reversed, 2);
});

test('payouts: paid_out and held = set_aside - paid_out', async () => {
  const ledger = { refunds: [], payouts: [{ date: '2026-12-01', partner: 'Example Partner', amount: 3, reference: 'PP-TXN' }] };
  const r = await run([pOrder({ ppId: 'AAAA1111BBBB2222' })], { AAAA1111BBBB2222: ppOrder(40.99, 1.92) }, ledger);
  assert.equal(r.paid_out, 3); assert.equal(r.held, 1.27);
});

test('pending (not yet billed by Printify) uses cost table and flags pending_estimates', async () => {
  const o = pOrder({ ppId: 'PEND0000PEND0000', price: 0, ship: 0, tax: 0, status: 'pending',
    items: [{ product_id: '69f6f9549eacb75844020e88', variant_id: 118238, quantity: 1, cost: 0, status: 'pending' },
            { product_id: '69dc553ba6714c1fd5037169', variant_id: 109396, quantity: 1, cost: 0, status: 'pending' }] });
  // items 18.28 + 32.18 = 50.46; shipping: hoodie first 8.79 + cap add 2.19 = 10.98; tax 7% of items = 3.53 -> 64.97
  assert.deepEqual(printifyCost(o), { cents: 6497, estimated: true });
  const r = await run([o], { PEND0000PEND0000: ppOrder(105.99, 4.19) }); // 105.99 - 64.97 - 4.19 = 36.83 -> 9.2075
  assert.equal(r.set_aside, 9.21); assert.equal(r.pending_estimates, true);
});

test('PayPal unreachable: revenue from CATALOG, fee estimated 3.49% + $0.49, flagged', async () => {
  assert.equal(estimateFee(4099), 192);
  const r = await run([pOrder({ ppId: 'NOPP0000NOPP0000' })], {});
  assert.equal(r.set_aside, 4.27); assert.equal(r.fee_estimates, true);
});

test('PayPal order without paypal_fee field: fee estimated and flagged', async () => {
  const r = await run([pOrder({ ppId: 'NOFE0000NOFE0000' })], { NOFE0000NOFE0000: ppOrder(40.99, null) });
  assert.equal(r.fee_estimates, true); assert.equal(r.set_aside, 4.27);
});

test('filters: before START, canceled, manual, reprint, non-site ids, duplicates are excluded', async () => {
  const pp = {};
  const ok = pOrder({ ppId: 'OKAY0000OKAY0000' }); pp.OKAY0000OKAY0000 = ppOrder(40.99, 1.92);
  const orders = [
    ok,
    { ...pOrder({ ppId: 'DUPE' }), metadata: { ...ok.metadata } }, // second Printify order for same PayPal id
    pOrder({ ppId: 'dog-11E09481P05346134', created: '2026-09-17T05:46:06Z' }), // old test order
    pOrder({ ppId: 'OCT31000LATE0000', created: '2026-11-01T04:59:59Z' }), // 11:59:59 PM CDT Oct 31
    pOrder({ ppId: 'CANC0000CANC0000', status: 'canceled' }),
    pOrder({ ppId: 'MANU0000MANU0000', meta: { order_type: 'manual' } }),
    pOrder({ ppId: 'RPRT0000RPRT0000', meta: { is_reprint: true } }),
    pOrder({ ppId: 'popup-store-123' }),
    pOrder({ ppId: undefined }),
  ];
  for (const o of orders.slice(2)) pp[o.metadata.shop_order_id] = ppOrder(40.99, 1.92);
  const r = await run(orders, pp);
  assert.equal(r.orders_counted, 1); assert.equal(r.set_aside, 4.27);
  const first = pOrder({ ppId: 'NOV10000NOV10000', created: '2026-11-01T05:00:00Z' }); // 12:00 AM CDT Nov 1
  assert.equal((await run([first], { NOV10000NOV10000: ppOrder(40.99, 1.92) })).orders_counted, 1);
});

test('zero orders -> honest zeros, no estimates', async () => {
  const r = await run([], {});
  assert.deepEqual({ ...r, as_of: 0 }, { set_aside: 0, paid_out: 0, held: 0, orders_counted: 0, pending_estimates: false, fee_estimates: false, refunds_reversed: 0, currency: 'USD', as_of: 0, start_date: POOL_START, basis: '25% of profit after print, shipping, and PayPal fees' });
});

test('ledger validation fails closed', () => {
  assert.throws(() => readLedger('{"refunds":[]}'));
  assert.throws(() => readLedger({ refunds: [], payouts: [{ date: 'Dec 1', partner: 'X', amount: 5 }] }));
  assert.throws(() => readLedger({ refunds: [{}], payouts: [] }));
  assert.equal(readLedger({ refunds: [{ orderId: 'dog-abc12345' }], payouts: [] }).reversed.has('ABC12345'), true);
});

test('paypalFacts ignores non-USD and incomplete orders', () => {
  assert.equal(paypalFacts({ status: 'APPROVED' }), null);
  const eur = ppOrder(40.99, 1.92); eur.purchase_units[0].payments.captures[0].amount.currency_code = 'EUR';
  assert.equal(paypalFacts(eur), null);
});

// ---------- handler (fetch mocked) ----------
function mockRes() { return { h: {}, code: 0, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } }; }
function installFetch({ pages, pp, failPrintify = false }) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    const j = (status, body) => ({ ok: status < 300, status, json: async () => body });
    const u = new URL(url);
    if (u.host === 'api.printify.com') {
      if (failPrintify) return j(500, {});
      const p = Number(u.searchParams.get('page'));
      return j(200, { current_page: p, last_page: pages.length, data: pages[p - 1] || [] });
    }
    if (u.pathname === '/v1/oauth2/token') return j(200, { access_token: 'tok', expires_in: 3600 });
    const m = u.pathname.match(/\/v2\/checkout\/orders\/(.+)$/);
    if (m) return pp[m[1]] ? j(200, pp[m[1]]) : j(404, {});
    throw new Error('unexpected fetch ' + url);
  };
  return calls;
}
process.env.PRINTIFY_TOKEN = 'test-printify';
process.env.PAYPAL_CLIENT_ID = 'id'; process.env.PAYPAL_CLIENT_SECRET = 'secret';
const { default: handler } = await import('../api/pool.js');

test('handler: GET returns aggregates only, CORS + cache headers, no PII, read-only calls', async () => {
  const o1 = pOrder({ ppId: 'HAND0000HAND0001' }), o2 = pOrder({ ppId: 'HAND0000HAND0002' });
  const old = pOrder({ ppId: 'dog-11E09481P05346134', created: '2026-09-17T05:46:06Z' });
  const calls = installFetch({ pages: [[o1, o2], [old]], pp: { HAND0000HAND0001: ppOrder(40.99, 1.92), HAND0000HAND0002: ppOrder(40.99, 1.92) } });
  const res = mockRes();
  await handler({ method: 'GET', headers: { origin: 'https://dadsofgod.com' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.set_aside, 8.54); assert.equal(res.body.orders_counted, 2);
  assert.equal(res.h['access-control-allow-origin'], 'https://dadsofgod.com');
  assert.equal(res.h['vary'], 'Origin');
  assert.match(res.h['cache-control'], /s-maxage=600, stale-while-revalidate/);
  const s = JSON.stringify(res.body);
  for (const bad of ['Jane', 'Doe', 'jane@', 'Secret', '555', 'HAND0000', '11E09481', 'pf', 'CAP1', 'address', 'email']) assert.ok(!s.includes(bad), 'leaked ' + bad);
  assert.deepEqual(Object.keys(res.body).sort(), ['as_of', 'basis', 'currency', 'fee_estimates', 'held', 'orders_counted', 'paid_out', 'pending_estimates', 'refunds_reversed', 'set_aside', 'start_date']);
  // only reads: Printify GETs, PayPal token POST (auth only) and order GETs
  for (const c of calls) assert.ok(c.method === 'GET' || c.url.endsWith('/v1/oauth2/token'), c.method + ' ' + c.url);
  assert.ok(!calls.some((c) => c.url.includes('send_to_production') || c.url.includes('/capture')));
});

test('handler: unknown origin gets the primary origin; non-GET is 405; OPTIONS 204', async () => {
  installFetch({ pages: [[]], pp: {} });
  let res = mockRes(); await handler({ method: 'GET', headers: { origin: 'https://evil.example' } }, res);
  assert.equal(res.h['access-control-allow-origin'], 'https://www.dadsofgod.com');
  res = mockRes(); await handler({ method: 'POST', headers: {} }, res); assert.equal(res.code, 405); assert.equal(res.h['cache-control'], 'no-store');
  res = mockRes(); await handler({ method: 'OPTIONS', headers: {} }, res); assert.equal(res.code, 204);
});

test('handler: Printify failure -> 503, not cached, no numbers', async () => {
  installFetch({ pages: [], pp: {}, failPrintify: true });
  const res = mockRes(); await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.code, 503); assert.equal(res.h['cache-control'], 'no-store'); assert.equal(res.body.set_aside, undefined);
});
