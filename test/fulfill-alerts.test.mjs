// node --test test/   (no network: PayPal, Printify and Resend are mocked; fake env values only)
// Covers: alert sender/recipient defaults, and alerts on every PayPal verification failure after
// checkout, with the customer response (status + body) unchanged.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import handler, { _resetAlertThrottle } from '../api/fulfill.js';
import webhook from '../api/paypal-webhook.js';

const ORDER = 'TESTORDER12345678';
const body = (id = ORDER) => ({
  paypalOrderId: id,
  items: [{ sku: 'DOG-CAP', size: 'One size' }],
  address: { name: 'Test Buyer', address: '123 Test St', city: 'Austin', state: 'TX', zip: '78701', country: 'US', email: 'form@example.com', phone: '(512) 555-0123' },
});
let calls, logs, pp;
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const completed = (captureStatus = 'COMPLETED', orderStatus = 'COMPLETED') => ({
  status: orderStatus, payer: { email_address: 'payer@example.com' },
  purchase_units: [{ payments: { captures: [{ status: captureStatus, amount: { currency_code: 'USD', value: '40.99' }, create_time: new Date().toISOString() }] },
    items: [{ sku: 'DOG-CAP:One size', quantity: '1' }],
    shipping: { address: { country_code: 'US', postal_code: '78701', address_line_1: '123 Test St', admin_area_2: 'Austin', admin_area_1: 'TX' } } }],
});
globalThis.fetch = async (url, o = {}) => {
  url = String(url); calls.push({ url, o });
  if (url.endsWith('/v1/oauth2/token')) return json(200, { access_token: 'FAKE', expires_in: 3600 });
  if (url.includes('/v1/notifications/verify-webhook-signature')) {
    return json(pp.verifyHttp || 200, pp.verifyBody !== undefined ? pp.verifyBody : { verification_status: 'SUCCESS' });
  }
  if (url.includes('/v2/checkout/orders/')) {
    if (pp.throw) throw new TypeError('fetch failed');
    return json(pp.status || 200, pp.body || {});
  }
  if (url.includes('/orders.json?')) {
    const listed = typeof pp.list === 'function' ? pp.list(url) : { data: pp.existing || [], last_page: 1 };
    return json(200, listed);
  }
  if (url.endsWith('/orders.json') && o.method === 'POST') {
    const id = pp.allocId ? pp.allocId() : 'pfy123';
    if (pp.holdCreates) await pp.holdCreates();
    return json(200, { id });
  }
  if (url.includes('/cancel.json')) return json(200, {});
  if (/\/orders\/[^/]+\.json$/.test(url)) {
    const q = pp.pf || ['on-hold'];
    const st = q.length > 1 ? q.shift() : q[0];
    return json(200, { id: 'pfy123', status: st });
  }
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
  for (const k of ['FULFILL_DRY_RUN', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO', 'ORDER_EMAIL_REPLY_TO', 'PAYPAL_ENV', 'ALERT_WEBHOOK_URL', 'PRINTIFY_READY_WAIT_MS', 'PRINTIFY_READY_POLL_MS', 'PAYPAL_WEBHOOK_ID']) delete process.env[k];
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

test('alerts throttled: one per order id per stage, and at most 20 per hour per instance', async () => {
  pp = { status: 404, body: {} };
  const r1 = await run(); const r2 = await run();
  assert.equal(r1.s, 400); assert.equal(r2.s, 400);
  assert.equal(alerts().length, 1);
  for (let i = 0; i < 24; i++) {
    const r = await run(body('A' + String(i).padStart(16, '0')));
    assert.equal(r.s, 400);
  }
  assert.equal(alerts().length, 20);
});

test('paid alerts are throttled to one per order id per stage', async () => {
  const b = completed();
  b.purchase_units[0].payments.captures[0].amount.value = '1.00';
  pp = { body: b };
  const r = await run(); await run(); await run();
  assert.equal(r.s, 400); assert.equal(r.j.error, 'Payment mismatch');
  assert.equal(alerts().length, 1);
  assert.equal(printifyCreates().length, 0);
});

test('PayPal 429 or 5xx on an unknown id: 503, no alert, no Printify order', async () => {
  for (const status of [429, 500, 503]) {
    calls = [];
    pp = { status, body: {} };
    const r = await run();
    assert.equal(r.s, 503, 'status ' + status);
    assert.deepEqual(r.j, { ok: false, error: 'Order service unavailable' });
    assert.equal(alerts().length, 0, 'no alert for ' + status);
    assert.equal(printifyCreates().length, 0);
  }
});

test('bad order id format: 400, no PayPal call, no alert (unchanged)', async () => {
  const r = await run(body('bad id!'));
  assert.equal(r.s, 400); assert.deepEqual(r.j, { ok: false, error: 'Invalid order' });
  assert.equal(alerts().length, 0);
  assert.ok(!calls.some((c) => c.url.includes('paypal.com')));
});

test('paypal order id must be 17 alphanumeric characters before any PayPal call', async () => {
  const r = await run(body('ABC1234567890123')); // 16 chars
  assert.equal(r.s, 400); assert.deepEqual(r.j, { ok: false, error: 'Invalid order' });
  assert.equal(alerts().length, 0);
  assert.ok(!calls.some((c) => c.url.includes('paypal.com')));
  const ok = await run(body('ABC12345678901234')); // 17 chars, reaches PayPal
  assert.equal(ok.s, 200);
  assert.ok(calls.some((c) => c.url.includes('/v2/checkout/orders/ABC12345678901234')));
});

test('happy path: 200, no alert, confirmation from orders@', async () => {
  const r = await run();
  assert.equal(r.s, 200); assert.deepEqual(r.j, { ok: true, printifyId: 'pfy123', sentToProduction: true });
  assert.equal(alerts().length, 0);
  const conf = mails().filter((m) => m.subject.startsWith('Your Dads of God order'));
  assert.equal(conf.length, 1); assert.equal(conf[0].from, 'Dads of God <orders@dadsofgod.com>');
  const confCall = calls.find((c) => c.url === 'https://api.resend.com/emails' && JSON.parse(c.o.body).subject.startsWith('Your Dads of God order'));
  assert.equal(confCall.o.headers['Idempotency-Key'], 'dog-order-confirm-' + ORDER);
  assert.match(conf[0].html, /sent your order to be printed/);
  assert.match(conf[0].text, /sent your order to be printed/);
  assert.ok(!/being prepared for printing/.test(conf[0].html));
});

test('cost-calculation then on-hold is sent to production', async () => {
  process.env.PRINTIFY_READY_POLL_MS = '5';
  process.env.PRINTIFY_READY_WAIT_MS = '500';
  pp.pf = ['cost-calculation', 'on-hold'];
  const r = await run();
  assert.equal(r.s, 200); assert.equal(r.j.sentToProduction, true);
  assert.ok(calls.filter((c) => /\/orders\/pfy123\.json$/.test(c.url)).length >= 2);
  assert.ok(calls.some((c) => c.url.includes('send_to_production')));
  assert.ok(logs.some((l) => l.msg === 'printify order status' && l.status === 'cost-calculation'));
  const conf = mails().find((m) => m.subject.startsWith('Your Dads of God order'));
  assert.match(conf.html, /sent your order to be printed/);
});

test('unknown status keeps polling, then confirms without saying it was sent to print', async () => {
  process.env.PRINTIFY_READY_POLL_MS = '5';
  process.env.PRINTIFY_READY_WAIT_MS = '40';
  pp.pf = ['mystery-status'];
  const r = await run();
  assert.equal(r.s, 200); assert.equal(r.j.sentToProduction, false);
  assert.ok(calls.filter((c) => /\/orders\/pfy123\.json$/.test(c.url)).length >= 2);
  assert.ok(!calls.some((c) => c.url.includes('send_to_production')));
  assert.ok(alerts().some((m) => /Send to production/.test(m.text)));
  const conf = mails().find((m) => m.subject.startsWith('Your Dads of God order'));
  assert.match(conf.html, /being prepared for printing/);
  assert.match(conf.text, /being prepared for printing/);
  assert.ok(!/sent your order to be printed/.test(conf.html));
});

for (const st of ['canceled', 'has-issues', 'unfulfillable', 'payment-not-received']) {
  test('terminal status ' + st + ' stops immediately and alerts', async () => {
    process.env.PRINTIFY_READY_POLL_MS = '5';
    process.env.PRINTIFY_READY_WAIT_MS = '5000';
    pp.pf = [st];
    const r = await run();
    assert.equal(r.s, 200); assert.equal(r.j.sentToProduction, false);
    assert.equal(calls.filter((c) => /\/orders\/pfy123\.json$/.test(c.url)).length, 1);
    assert.ok(!calls.some((c) => c.url.includes('send_to_production')));
    assert.ok(alerts().some((m) => m.text.includes('terminal status ' + st)));
  });
}

test('duplicate cost-calculation order is polled and sent', async () => {
  process.env.PRINTIFY_READY_POLL_MS = '5';
  process.env.PRINTIFY_READY_WAIT_MS = '500';
  pp.existing = [{ id: 'pfy123', status: 'cost-calculation', metadata: { shop_order_id: ORDER } }];
  pp.pf = ['cost-calculation', 'on-hold'];
  const r = await run();
  assert.equal(r.s, 200); assert.equal(r.j.duplicate, true);
  assert.ok(calls.some((c) => c.url.includes('send_to_production')));
  assert.ok(!calls.some((c) => c.url.endsWith('/orders.json') && c.o.method === 'POST'));
});

// ---- Phone required (Printify needs address_to.phone) ----
const withPhone = (phone) => { const b = body(); if (phone === undefined) delete b.address.phone; else b.address.phone = phone; return b; };
const printifyCreates = () => calls.filter((c) => c.url.endsWith('/orders.json') && c.o.method === 'POST');
const paypalGets = () => calls.filter((c) => c.url.includes('/v2/checkout/orders/'));

for (const [name, phone] of [['missing', undefined], ['empty', ''], ['whitespace', '   '], ['9 digits', '512-555-012'], ['letters only', 'call me'], ['16 digits', '1234567890123456']]) {
  test('phone ' + name + ': 400 "Please enter a valid phone number", no Printify call', async () => {
    const r = await run(withPhone(phone));
    assert.equal(r.s, 400);
    assert.deepEqual(r.j, { ok: false, error: 'Please enter a valid phone number' });
    assert.equal(printifyCreates().length, 0, 'no Printify order created');
    assert.ok(!calls.some((c) => c.url.includes('printify.com')), 'no Printify call at all');
    // Rejected in buildAddress, before verifyPaypal: the only PayPal GET is the "did they already pay?" check.
    assert.equal(paypalGets().length, 1);
  });
}

test('phone missing on an already-paid order: alerts a human (buyer was charged in the browser)', async () => {
  await run(withPhone(undefined));
  const a = alerts(); assert.equal(a.length, 1);
  assert.match(a[0].text, /phone missing\/bad/);
});

test('phone missing on an unpaid order: 400, no alert', async () => {
  pp = { body: completed('COMPLETED', 'APPROVED') };
  const r = await run(withPhone(undefined));
  assert.equal(r.s, 400); assert.equal(alerts().length, 0);
});

for (const [phone, digits] of [['(512) 555-0123', '5125550123'], ['512.555.0123', '5125550123'], ['+1 512 555 0123', '15125550123'], ['5125550123', '5125550123']]) {
  test('valid phone ' + JSON.stringify(phone) + ' is passed to Printify address_to.phone as ' + digits, async () => {
    const r = await run(withPhone(phone));
    assert.equal(r.s, 200); assert.deepEqual(r.j, { ok: true, printifyId: 'pfy123', sentToProduction: true });
    const c = printifyCreates(); assert.equal(c.length, 1);
    assert.equal(JSON.parse(c[0].o.body).address_to.phone, digits);
  });
}

test('dry run payload includes the phone', async () => {
  process.env.VERCEL_ENV = 'preview'; process.env.FULFILL_DRY_RUN = '1';
  const r = await run(withPhone('512-555-0123'));
  assert.equal(r.s, 200); assert.equal(r.j.wouldCreate.address_to.phone, '5125550123');
  assert.equal(printifyCreates().length, 0);
});

test('stale capture (older than 24h): 200 {ok:true}, one alert, no Printify order', async () => {
  const b = completed();
  b.purchase_units[0].payments.captures[0].create_time = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  pp = { body: b };
  const r = await run();
  assert.equal(r.s, 200); assert.deepEqual(r.j, { ok: true });
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].text, /older than 24h/);
  assert.ok(!calls.some((c) => c.url.includes('printify.com')));
  const again = await run();
  assert.equal(again.s, 200); assert.deepEqual(again.j, { ok: true });
  assert.equal(alerts().length, 1, 'same order and stage is one alert per hour');
});

test('capture just under 24h is still fulfilled', async () => {
  const b = completed();
  b.purchase_units[0].payments.captures[0].create_time = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
  pp = { body: b };
  const r = await run();
  assert.equal(r.s, 200); assert.equal(r.j.printifyId, 'pfy123'); assert.equal(r.j.sentToProduction, true);
});

test('existing order matched by external_id past the newest 30', async () => {
  pp.list = (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 4) {
      return { data: [{ id: 'old-order', status: 'on-hold', created_at: '2026-11-01T00:00:00Z', external_id: ORDER }], last_page: 4 };
    }
    return {
      data: Array.from({ length: 10 }, (_, i) => ({ id: 'x' + page + '-' + i, status: 'on-hold', metadata: { shop_order_label: ORDER, shop_order_id: 'OTHER' + page + 'X' + i } })),
      last_page: 4,
    };
  };
  const r = await run();
  assert.equal(r.s, 200); assert.deepEqual(r.j, { ok: true, duplicate: true, printifyId: 'old-order' });
  assert.equal(printifyCreates().length, 0);
  assert.ok(calls.some((c) => c.url.includes('/orders/old-order/send_to_production.json')));
  assert.equal(mails().filter((m) => m.subject.startsWith('Your Dads of God order')).length, 0);
});

test('duplicate scan stops at 20 pages', async () => {
  let maxPage = 0;
  pp.list = (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page > maxPage) maxPage = page;
    return { data: Array.from({ length: 10 }, (_, i) => ({ id: 'p' + page + 'i' + i, metadata: { shop_order_id: 'NO' + page + 'X' + i } })), last_page: 50 };
  };
  const r = await run();
  assert.equal(maxPage, 20);
  assert.equal(r.j.printifyId, 'pfy123');
});

test('label-only match is not a duplicate', async () => {
  pp.existing = [{ id: 'label-only', status: 'on-hold', metadata: { shop_order_label: ORDER, shop_order_id: 'SOMEOTHERORDER123' } }];
  const r = await run();
  assert.equal(r.s, 200); assert.equal(r.j.printifyId, 'pfy123'); assert.equal(r.j.duplicate, undefined);
  assert.equal(printifyCreates().length, 1);
});

test('concurrent duplicate creates: only the oldest is sent, the other is canceled, one email', async () => {
  const made = [];
  const waiters = [];
  pp.allocId = () => {
    const n = made.length + 1;
    const row = { id: 'pfy' + n, status: 'pending', created_at: '2026-11-05T00:00:0' + n + 'Z', external_id: ORDER, metadata: { shop_order_id: ORDER } };
    made.push(row);
    return row.id;
  };
  pp.holdCreates = () => new Promise((resolve) => {
    waiters.push(resolve);
    if (waiters.length >= 2) waiters.splice(0).forEach((fn) => fn());
  });
  pp.list = () => (made.length < 2 ? { data: [], last_page: 1 } : { data: made.map((o) => ({ ...o })), last_page: 1 });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(printifyCreates().length, 2);
  const sends = calls.filter((c) => c.url.includes('/send_to_production.json'));
  assert.equal(sends.length, 1);
  assert.ok(sends[0].url.includes('/orders/pfy1/send_to_production.json'));
  const cancels = calls.filter((c) => c.url.includes('/cancel.json'));
  assert.ok(cancels.some((c) => c.url.includes('/orders/pfy2/cancel.json')));
  assert.ok(!cancels.some((c) => c.url.includes('/orders/pfy1/cancel.json')));
  const conf = mails().filter((m) => m.subject.startsWith('Your Dads of God order'));
  assert.equal(conf.length, 1);
  assert.equal(alerts().filter((m) => /duplicate Printify orders/.test(m.text)).length, 1);
  const bodies = [a.j, b.j].sort((x, y) => (x.duplicate === y.duplicate ? 0 : x.duplicate ? 1 : -1));
  assert.deepEqual(bodies[0], { ok: true, printifyId: 'pfy1', sentToProduction: true });
  assert.deepEqual(bodies[1], { ok: true, duplicate: true, printifyId: 'pfy1' });
});

test('same created_at: lowest id is kept, the other pending order is canceled', async () => {
  pp.list = (url) => {
    const creates = calls.filter((c) => c.url.endsWith('/orders.json') && c.o.method === 'POST').length;
    if (creates === 0) return { data: [], last_page: 1 };
    return {
      data: [
        { id: 'pfyB', status: 'pending', created_at: '2026-11-05T00:00:00Z', external_id: ORDER, metadata: { shop_order_id: ORDER } },
        { id: 'pfy123', status: 'pending', created_at: '2026-11-05T00:00:00Z', external_id: ORDER, metadata: { shop_order_id: ORDER } },
      ],
      last_page: 1,
    };
  };
  pp.allocId = () => 'pfyB';
  const r = await run();
  assert.equal(r.s, 200); assert.deepEqual(r.j, { ok: true, duplicate: true, printifyId: 'pfy123' });
  assert.ok(calls.some((c) => c.url.includes('/orders/pfyB/cancel.json')));
  assert.ok(!calls.some((c) => c.url.includes('/orders/pfy123/cancel.json')));
  assert.ok(!calls.some((c) => c.url.includes('/send_to_production.json')));
  assert.equal(mails().filter((m) => m.subject.startsWith('Your Dads of God order')).length, 0);
});

const sigHeaders = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': 'sig-value',
  'paypal-transmission-time': '2026-11-05T00:00:00Z',
};
const webhookEvent = (orderId = ORDER) => ({
  id: 'EVT-1',
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: { id: 'CAP-1', supplementary_data: { related_ids: { order_id: orderId } } },
});
const postWebhook = async (event = webhookEvent(), headers = sigHeaders, method = 'POST') => {
  const res = { h: {}, setHeader() {}, status(s) { this.s = s; return this; }, json(j) { this.j = j; return this; }, end() { return this; } };
  await webhook({ method, headers, body: event }, res);
  return res;
};
const confirmations = () => mails().filter((m) => m.subject.startsWith('Your Dads of God order'));

test('GET /api/paypal-webhook is 405', async () => {
  const r = await postWebhook(webhookEvent(), sigHeaders, 'GET');
  assert.equal(r.s, 405);
  assert.equal(calls.length, 0);
});

test('webhook with PAYPAL_WEBHOOK_ID unset returns 200 and does nothing', async () => {
  const r = await postWebhook();
  assert.equal(r.s, 200); assert.deepEqual(r.j, { ok: true });
  assert.equal(calls.length, 0);
  assert.ok(logs.some((l) => /PAYPAL_WEBHOOK_ID unset/.test(l.msg || '')));
});

test('webhook with a missing signature is rejected and does not fulfill', async () => {
  process.env.PAYPAL_WEBHOOK_ID = 'WH-1';
  const r = await postWebhook(webhookEvent(), {});
  assert.equal(r.s, 400); assert.equal(r.j.ok, false);
  assert.ok(!calls.some((c) => c.url.includes('verify-webhook-signature')));
  assert.equal(printifyCreates().length, 0);
});

test('webhook with a bad signature is rejected and does not fulfill', async () => {
  process.env.PAYPAL_WEBHOOK_ID = 'WH-1';
  pp.verifyBody = { verification_status: 'FAILURE' };
  const r = await postWebhook();
  assert.equal(r.s, 400); assert.equal(r.j.error, 'Invalid webhook signature');
  assert.equal(printifyCreates().length, 0);
  assert.ok(!calls.some((c) => c.url.includes('/v2/checkout/orders/')));
  const verify = calls.find((c) => c.url.includes('verify-webhook-signature'));
  const sent = JSON.parse(verify.o.body);
  assert.equal(sent.webhook_id, 'WH-1');
  assert.equal(sent.webhook_event.event_type, 'PAYMENT.CAPTURE.COMPLETED');
  assert.equal(sent.transmission_id, 'tx-1');
});

test('webhook skips a donation order', async () => {
  process.env.PAYPAL_WEBHOOK_ID = 'WH-1';
  pp.body = {
    status: 'COMPLETED',
    payer: { email_address: 'donor@example.com' },
    purchase_units: [{
      custom_id: 'donation-pool', reference_id: 'donation-pool',
      items: [{ name: 'Donation', category: 'DONATION', quantity: '1' }],
      payments: { captures: [{ status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' }, create_time: new Date().toISOString() }] },
    }],
  };
  const r = await postWebhook();
  assert.equal(r.s, 200); assert.deepEqual(r.j, { ok: true });
  assert.equal(printifyCreates().length, 0);
  assert.equal(mails().length, 0);
  assert.ok(logs.some((l) => l.msg === 'paypal webhook donation skipped'));
});

test('valid webhook after the browser path already fulfilled does not send a second email', async () => {
  process.env.PAYPAL_WEBHOOK_ID = 'WH-1';
  const first = await run();
  assert.equal(first.s, 200); assert.equal(first.j.printifyId, 'pfy123');
  assert.equal(confirmations().length, 1);
  const confCall = calls.find((c) => c.url === 'https://api.resend.com/emails' && JSON.parse(c.o.body).subject.startsWith('Your Dads of God order'));
  assert.equal(confCall.o.headers['Idempotency-Key'], 'dog-order-confirm-' + ORDER);
  pp.existing = [{ id: 'pfy123', status: 'in-production', created_at: '2026-11-05T00:00:00Z', metadata: { shop_order_id: ORDER } }];
  const creates = printifyCreates().length;
  const r = await postWebhook();
  assert.equal(r.s, 200); assert.deepEqual(r.j, { ok: true, duplicate: true, printifyId: 'pfy123' });
  assert.equal(confirmations().length, 1);
  assert.equal(printifyCreates().length, creates);
  assert.equal(alerts().length, 0);
});

test('webhook with no phone and no existing order alerts instead of inventing a phone', async () => {
  process.env.PAYPAL_WEBHOOK_ID = 'WH-1';
  const b = completed();
  b.purchase_units[0].shipping.name = { full_name: 'Test Buyer' };
  pp = { body: b };
  const r = await postWebhook();
  assert.equal(r.s, 400); assert.equal(r.j.error, 'Please enter a valid phone number');
  assert.equal(alerts().length, 1);
  assert.equal(printifyCreates().length, 0);
});
