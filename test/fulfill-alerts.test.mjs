// node --test test/   (no network: PayPal, Printify and Resend are mocked; fake env values only)
// Covers: alert sender/recipient defaults, and alerts on every PayPal verification failure after
// checkout, with the customer response (status + body) unchanged.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import handler, { _resetAlertThrottle } from '../api/fulfill.js';

const ORDER = 'TESTORDER12345678';
const body = (id = ORDER) => ({
  paypalOrderId: id,
  items: [{ sku: 'DOG-CAP', size: 'One size' }],
  address: { name: 'Test Buyer', address: '123 Test St', city: 'Austin', state: 'TX', zip: '78701', country: 'US', email: 'form@example.com' },
});
let calls, logs, pp;
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const completed = (captureStatus = 'COMPLETED', orderStatus = 'COMPLETED') => ({
  status: orderStatus, payer: { email_address: 'payer@example.com' },
  purchase_units: [{ payments: { captures: [{ status: captureStatus, amount: { currency_code: 'USD', value: '40.99' } }] },
    items: [{ sku: 'DOG-CAP:One size', quantity: '1' }],
    shipping: { address: { country_code: 'US', postal_code: '78701', address_line_1: '123 Test St', admin_area_2: 'Austin', admin_area_1: 'TX' } } }],
});
globalThis.fetch = async (url, o = {}) => {
  url = String(url); calls.push({ url, o });
  if (url.endsWith('/v1/oauth2/token')) return json(200, { access_token: 'FAKE', expires_in: 3600 });
  if (url.includes('/v2/checkout/orders/')) {
    if (pp.throw) throw new TypeError('fetch failed');
    return json(pp.status || 200, pp.body || {});
  }
  if (url.includes('/orders.json?')) return json(200, { data: [], last_page: 1 });
  if (url.endsWith('/orders.json')) return json(200, { id: 'pfy123' });
  if (url.includes('/send_to_production.json')) return json(200, {});
  if (url === 'https://api.resend.com/emails') return json(200, { id: 'resend-mock' });
  if (url === 'https://hooks.example.com/alert') return json(200, {});
  throw new Error('UNMOCKED ' + url);
};
for (const l of ['info', 'warn', 'error', 'log']) console[l] = (m) => { try { logs.push(JSON.parse(m)); } catch (_) { logs.push(m); } };
const run = async (b = body()) => {
  const res = { h: {}, setHeader(k, v) { this.h[k] = v; }, status(s) { this.s = s; return this; }, json(j) { this.j = j; return this; }, end() { return this; } };
  await handler({ method: 'POST', headers: { origin: 'https://www.dadsofgod.com' }, body: b }, res);
  return res;
};
const mails = () => calls.filter((c) => c.url === 'https://api.resend.com/emails').map((c) => JSON.parse(c.o.body));
const alerts = () => mails().filter((m) => m.subject.startsWith('[DoG] Order needs attention'));

beforeEach(() => {
  calls = []; logs = []; pp = { body: completed() };
  _resetAlertThrottle();
  Object.assign(process.env, { VERCEL_ENV: 'production', PRINTIFY_TOKEN: 'FAKE', PAYPAL_CLIENT_ID: 'FAKE', PAYPAL_CLIENT_SECRET: 'FAKE',
    RESEND_API_KEY: 'FAKE_KEY', ORDER_EMAIL_FROM: 'Dads of God <orders@dadsofgod.com>' });
  for (const k of ['FULFILL_DRY_RUN', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO', 'ORDER_EMAIL_REPLY_TO', 'PAYPAL_ENV', 'ALERT_WEBHOOK_URL']) delete process.env[k];
});

test('alert defaults: from alerts@dadsofgod.com to contact@dadsofgod.com when env is unset', async () => {
  pp = { status: 404, body: {} };
  await run();
  const a = alerts(); assert.equal(a.length, 1);
  assert.equal(a[0].from, 'DoG Alerts <alerts@dadsofgod.com>');
  assert.deepEqual(a[0].to, ['contact@dadsofgod.com']);
  assert.ok(!JSON.stringify(a[0]).includes('resend.dev'));
});

test('alert env overrides: ALERT_EMAIL_FROM and ALERT_EMAIL_TO are honored', async () => {
  process.env.ALERT_EMAIL_FROM = 'DoG Alerts <alerts@dadsofgod.com>';
  process.env.ALERT_EMAIL_TO = 'a@example.com, b@example.com';
  pp = { status: 404, body: {} };
  await run();
  const a = alerts(); assert.equal(a.length, 1);
  assert.equal(a[0].from, 'DoG Alerts <alerts@dadsofgod.com>');
  assert.deepEqual(a[0].to, ['a@example.com', 'b@example.com']);
});

const cases = [
  ['order not found (404)', { status: 404, body: {} }, 400, 'Payment not found', /PayPal order not found/],
  ['order status APPROVED (not captured)', { body: completed('COMPLETED', 'APPROVED') }, 402, 'Payment not completed', /PayPal status APPROVED/],
  ['capture DECLINED', { body: completed('DECLINED') }, 402, 'Payment not completed', /no COMPLETED capture \(capture status DECLINED\)/],
  ['capture PENDING', { body: completed('PENDING') }, 402, 'Payment not completed', /capture status PENDING/],
  ['PayPal 500', { status: 500, body: {} }, 502, 'Order service unavailable', /PayPal GET order failed 500/],
  ['network error', { throw: true }, 500, 'Order service unavailable', /fetch failed/],
];
for (const [name, mock, status, publicMsg, detail] of cases) {
  test('verify failure alerts with order id + error, response unchanged: ' + name, async () => {
    pp = mock;
    const r = await run();
    assert.equal(r.s, status);
    assert.deepEqual(r.j, { ok: false, error: publicMsg });
    const a = alerts(); assert.equal(a.length, 1, 'exactly one alert email');
    assert.ok(a[0].subject.includes(ORDER));
    assert.match(a[0].text, new RegExp('paypalOrderId: ' + ORDER));
    assert.match(a[0].text, detail);
    assert.match(a[0].text, /error: /);
    assert.ok(!calls.some((c) => c.url.endsWith('/orders.json') && c.o.method === 'POST'), 'no Printify order created');
  });
}

test('webhook channel also fires for a verify failure', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/alert';
  pp = { status: 404, body: {} };
  await run();
  const w = calls.filter((c) => c.url === 'https://hooks.example.com/alert');
  assert.equal(w.length, 1);
  const j = JSON.parse(w[0].o.body);
  assert.equal(j.paypalOrderId, ORDER); assert.equal(j.stage, 'paypal-verify'); assert.match(j.text, /verification failed/);
});

test('verify alerts are throttled: same id once, and at most 10 per window; responses unchanged', async () => {
  pp = { status: 404, body: {} };
  const r1 = await run(); const r2 = await run();
  assert.equal(r1.s, 400); assert.equal(r2.s, 400);
  assert.equal(alerts().length, 1);
  for (let i = 0; i < 15; i++) { const r = await run(body('FAKEID' + String(i).padStart(10, '0'))); assert.equal(r.s, 400); }
  assert.equal(alerts().length, 10);
});

test('paid failures are never throttled', async () => {
  pp = { status: 500, body: {} };
  await run(); await run(); await run();
  assert.equal(alerts().length, 3);
});

test('bad order id format: 400, no PayPal call, no alert (unchanged)', async () => {
  const r = await run(body('bad id!'));
  assert.equal(r.s, 400); assert.deepEqual(r.j, { ok: false, error: 'Invalid order' });
  assert.equal(alerts().length, 0);
  assert.ok(!calls.some((c) => c.url.includes('paypal.com')));
});

test('happy path: 200, no alert, confirmation from orders@', async () => {
  const r = await run();
  assert.equal(r.s, 200); assert.deepEqual(r.j, { ok: true, printifyId: 'pfy123' });
  assert.equal(alerts().length, 0);
  const conf = mails().filter((m) => m.subject.startsWith('Your Dads of God order'));
  assert.equal(conf.length, 1); assert.equal(conf[0].from, 'Dads of God <orders@dadsofgod.com>');
});
