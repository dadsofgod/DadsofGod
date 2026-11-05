// DoG fulfill endpoint (Vercel serverless function).
//
// Flow: browser captures the PayPal order -> POSTs { paypalOrderId, items, address } here ->
// we fetch the order from PayPal server-side, verify it is COMPLETED and that the captured
// amount equals the cart total recomputed from the server-side catalog below (+ $5.99 flat
// US shipping) -> idempotency pre-check in Printify -> create Printify order -> send_to_production.
//
// Env vars:
//   PRINTIFY_TOKEN        (required) Printify personal access token, orders.read + orders.write
//   PRINTIFY_SHOP_ID      (optional) defaults to 27166805
//   PAYPAL_CLIENT_ID      (required) same REST app as the client-id on dadsofgod.com
//   PAYPAL_CLIENT_SECRET  (required)
//   PAYPAL_ENV            (optional) 'live' (default) or 'sandbox'
//   ALERT_WEBHOOK_URL     (optional) receives a JSON POST { text, ... } when a PAID order fails
//                          to reach Printify (Slack/Discord/Zapier-compatible "text" field)
//   ALERT_EMAIL_TO        (optional) comma list of addresses that get an alert email, default
//                          contact@dadsofgod.com. Sent via Resend's HTTP API, so it only sends
//                          when RESEND_API_KEY is also set; otherwise it is a no-op.
//   RESEND_API_KEY        (optional, secret) Resend API key used for ALERT_EMAIL_TO
//   ALERT_EMAIL_FROM      (optional) sender, default 'DoG Alerts <alerts@dadsofgod.com>'
//                          (dadsofgod.com is a Resend-verified domain)
//   FULFILL_DRY_RUN       (optional, NON-PRODUCTION ONLY) '1' = verify PayPal, price the cart,
//                          validate the address, optionally look for duplicates, then return the
//                          Printify payload WITHOUT creating or sending any Printify order.
//                          Ignored when VERCEL_ENV === 'production'.
//   ORDER_EMAIL_FROM      (optional) sender for the customer order-confirmation email, e.g.
//                          'Dads of God <orders@dadsofgod.com>' (Resend-verified domain). Falls back to
//                          ALERT_EMAIL_FROM; if neither is set the confirmation is skipped. Uses RESEND_API_KEY.
//   ORDER_EMAIL_REPLY_TO  (optional) reply-to for the confirmation, default contact@dadsofgod.com
//   EXTRA_ALLOWED_ORIGINS (optional, NON-PRODUCTION ONLY) comma list of extra CORS origins,
//                          e.g. a preview URL. Ignored when VERCEL_ENV === 'production'.
//   PAYPAL_WEBHOOK_ID     (optional) PayPal webhook id. Read only by api/paypal-webhook.js.
//                          When unset, that endpoint acknowledges and does nothing.

import { sendOrderConfirmation } from './_lib/order-email.js';

const SHOP = process.env.PRINTIFY_SHOP_ID || '27166805';
const SHIPPING_CENTS = 599; // flat US shipping per order
const BASE_ORIGINS = ['https://www.dadsofgod.com', 'https://dadsofgod.com'];
const DEFAULT_ALERT_FROM = 'DoG Alerts <alerts@dadsofgod.com>';
const DEFAULT_ALERT_TO = 'contact@dadsofgod.com';

// Read per request so tests (and env changes) take effect without a module reload.
const isProduction = () => process.env.VERCEL_ENV === 'production';
const isDryRun = () => process.env.FULFILL_DRY_RUN === '1' && !isProduction();
function allowedOrigins() {
  if (isProduction()) return BASE_ORIGINS;
  const extra = String(process.env.EXTRA_ALLOWED_ORIGINS || '')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter((o) => /^https?:\/\/[^\s/]+$/i.test(o));
  return BASE_ORIGINS.concat(extra);
}

// ============================================================================
// CATALOG + PRINTIFY VARIANT MAP — single source of truth for prices and IDs.
// Verified live by the DoG Product Lead on 2026-10-29 (read-only Printify API):
// see /workspace/dog/products/printify_mapping_verified.md (ops workspace).
// All variants are Black (the only enabled color). Cap is one size (118238 = Black / One size).
// Prices MUST match index.html. Any sku/size not listed here is rejected (no fallbacks).
// ============================================================================
const CATALOG = {
  'DOG-TEE': {
    name: 'Classic Tee', priceCents: 3500, product: '69dc4507f6f60e22c60dec14',
    sizes: { S: 12126, M: 12125, L: 12124, XL: 12127, '2XL': 12128 },
  },
  'DOG-LS': {
    name: 'Long Sleeve', priceCents: 4500, product: '69dc53923ff9b45b4504917c',
    sizes: { S: 33796, M: 33797, L: 33798, XL: 33799, '2XL': 33800 },
  },
  'DOG-HOOD': {
    name: 'Signature Hoodie', priceCents: 6500, product: '69dc553ba6714c1fd5037169',
    sizes: { S: 109373, M: 109396, L: 109419, XL: 109442, '2XL': 109465 },
  },
  'DOG-CAP': {
    name: 'Signature Ballcap', priceCents: 3500, product: '69f6f9549eacb75844020e88',
    sizes: { 'One size': 118238 },
  },
};
// ============================================================================

const US_STATES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']);
const MAX_QTY_PER_LINE = 10;
const MAX_LINES = 20;
const TIMEOUT_MS = 8000;
// PayPal v2 checkout order ids are 17 alphanumeric characters (5O190127TN364715T).
const PAYPAL_ORDER_ID_RE = /^[A-Z0-9]{17}$/i;
const MAX_CAPTURE_AGE_MS = 24 * 60 * 60 * 1000;
export function isPaypalOrderId(id) { return PAYPAL_ORDER_ID_RE.test(String(id || '')); }

class FulfillError extends Error {
  constructor(status, publicMsg, detail, { paid = false, input = false, verify = false } = {}) {
    super(detail || publicMsg);
    this.status = status;
    this.publicMsg = publicMsg;
    this.paid = paid; // true => money was (or may have been) taken; alert a human
    this.input = input; // true => bad cart/address; check PayPal in case the buyer already paid
    // true => PayPal verification failed after the buyer approved in the PayPal popup (order not found,
    // not COMPLETED, no completed capture). Alert a human too, throttled like every other alert,
    // because anyone can POST a made-up order id.
    this.verify = verify;
  }
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const log = (level, msg, extra) => console[level](JSON.stringify({ svc: 'dog-fulfill', msg, ...extra }));

function paypalBase() {
  return (process.env.PAYPAL_ENV || 'live').toLowerCase() === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { ok: r.ok, status: r.status, body };
}

let ppToken = null; // { token, exp } cached per warm instance
async function paypalAccessToken() {
  if (ppToken && ppToken.exp > Date.now() + 60000) return ppToken.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new FulfillError(503, 'Order service unavailable', 'PAYPAL_CLIENT_ID/SECRET missing', { paid: true });
  const r = await fetchJson(paypalBase() + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok || !r.body || !r.body.access_token) throw new FulfillError(502, 'Order service unavailable', 'PayPal auth failed ' + r.status, { paid: true });
  ppToken = { token: r.body.access_token, exp: Date.now() + (Number(r.body.expires_in) || 300) * 1000 };
  return ppToken.token;
}

// Validate and price the cart from the server-side catalog only.
function buildCart(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINES) throw new FulfillError(400, 'Invalid order', 'items missing or too many', { input: true });
  let merch = 0;
  const lines = [];
  for (const i of items) {
    const sku = str(i && i.sku, 40);
    const size = str(i && i.size, 20);
    const row = CATALOG[sku];
    if (!row) throw new FulfillError(400, 'Invalid order', 'unknown sku ' + sku, { input: true });
    const variant_id = Object.prototype.hasOwnProperty.call(row.sizes, size) ? row.sizes[size] : null;
    if (!variant_id) throw new FulfillError(400, 'Invalid order', 'unknown size ' + sku + '/' + size, { input: true });
    const quantity = i.quantity === undefined ? 1 : Number(i.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_LINE) throw new FulfillError(400, 'Invalid order', 'bad quantity', { input: true });
    merch += row.priceCents * quantity;
    lines.push({ sku, size, quantity, product_id: row.product, variant_id });
  }
  return { lines, totalCents: merch + SHIPPING_CENTS };
}

// Validate the US shipping address. Name and phone are required (Printify needs a phone to ship).
// NOTE: this endpoint runs AFTER the browser has captured the PayPal payment, so a rejection here
// cannot stop a charge. The real guard is shipValid() in index.html, which blocks before createOrder.
// A rejection here on a paid order is flagged paid (via paypalOrderIsPaid) and alerts a human.
const MIN_PHONE_DIGITS = 10;
const MAX_PHONE_DIGITS = 15;
function normalizePhone(v) { return str(v, 30).replace(/\D/g, ''); }
function buildAddress(a) {
  a = a || {};
  const name = str(a.name, 100).replace(/\s+/g, ' ');
  const parts = name.split(' ').filter(Boolean);
  const email = str(a.email, 200);
  const country = str(a.country, 40).toUpperCase();
  const state = str(a.state, 2).toUpperCase();
  const zip = str(a.zip, 10);
  const out = {
    first_name: parts[0] || '',
    last_name: parts.slice(1).join(' '),
    email,
    country: 'US',
    region: state,
    address1: str(a.address, 200),
    address2: str(a.address2, 200),
    city: str(a.city, 100),
    zip,
  };
  const phone = normalizePhone(a.phone);
  out.phone = phone; // always sent to Printify address_to.phone (digits only)
  if (!['US', 'USA', 'UNITED STATES'].includes(country)) throw new FulfillError(400, 'We currently ship to US addresses only', 'non-US country ' + country, { input: true });
  if (parts.length < 2) throw new FulfillError(400, 'Please enter your first and last name', 'name missing/single word', { input: true });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new FulfillError(400, 'Please enter a valid email', 'bad email', { input: true });
  if (phone.length < MIN_PHONE_DIGITS || phone.length > MAX_PHONE_DIGITS) throw new FulfillError(400, 'Please enter a valid phone number', 'phone missing/bad (' + phone.length + ' digits)', { input: true });
  if (!out.address1 || !out.city) throw new FulfillError(400, 'Please enter a full address', 'address/city missing', { input: true });
  if (!US_STATES.has(state)) throw new FulfillError(400, 'Please choose a US state', 'bad state ' + state, { input: true });
  if (!/^\d{5}(-\d{4})?$/.test(zip)) throw new FulfillError(400, 'Please enter a valid ZIP code', 'bad zip', { input: true });
  return out;
}

// Fetch the order from PayPal and verify it was actually paid the right amount.
async function verifyPaypal(orderId, cart) {
  const token = await paypalAccessToken();
  const r = await fetchJson(paypalBase() + '/v2/checkout/orders/' + encodeURIComponent(orderId), {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  if (r.status === 404) throw new FulfillError(400, 'Payment not found', 'PayPal order not found ' + orderId, { verify: true });
  // 429/5xx on an id we have never verified is not evidence the buyer paid. Do not alert.
  if (r.status === 429 || r.status >= 500) throw new FulfillError(503, 'Order service unavailable', 'PayPal GET order failed ' + r.status);
  if (!r.ok || !r.body) throw new FulfillError(502, 'Order service unavailable', 'PayPal GET order failed ' + r.status, { paid: true });
  const o = r.body;
  if (o.status !== 'COMPLETED') throw new FulfillError(402, 'Payment not completed', 'PayPal status ' + o.status, { verify: true });
  const pu = (o.purchase_units || [])[0] || {};
  const captures = ((pu.payments || {}).captures || []).filter((c) => c.status === 'COMPLETED');
  if (!captures.length) {
    const st = ((pu.payments || {}).captures || []).map((c) => c && c.status).filter(Boolean).join(',') || 'none';
    throw new FulfillError(402, 'Payment not completed', 'no COMPLETED capture (capture status ' + st + ')', { verify: true });
  }
  let paidCents = 0;
  for (const c of captures) {
    if (!c.amount || c.amount.currency_code !== 'USD') throw new FulfillError(400, 'Payment mismatch', 'non-USD capture', { paid: true });
    paidCents += Math.round(Number(c.amount.value) * 100);
  }
  if (paidCents !== cart.totalCents) {
    throw new FulfillError(400, 'Payment mismatch', 'amount mismatch paid=' + paidCents + ' expected=' + cart.totalCents, { paid: true });
  }
  // If the PayPal order carries line items (new checkout sends them), they must match the cart.
  if (Array.isArray(pu.items) && pu.items.length) {
    const key = (sku, qty) => sku + '#' + qty;
    const want = cart.lines.map((l) => key(l.sku + ':' + l.size, l.quantity)).sort().join('|');
    const got = pu.items.map((it) => key(String(it.sku || ''), Number(it.quantity || 1))).sort().join('|');
    if (want !== got) throw new FulfillError(400, 'Payment mismatch', 'PayPal items differ from cart', { paid: true });
  }
  return { paidCents, shipping: pu.shipping || null, payerEmail: (o.payer || {}).email_address || '', order: o };
}

// null when the capture has no parseable create_time (do not treat missing time as stale).
function captureAgeMs(order, now = Date.now()) {
  const pu = ((order && order.purchase_units) || [])[0] || {};
  const caps = ((pu.payments || {}).captures || []).filter((c) => c && c.status === 'COMPLETED');
  let newest = null;
  for (const c of caps) {
    const t = Date.parse(c.create_time || '');
    if (!Number.isFinite(t)) return null;
    if (newest == null || t > newest) newest = t;
  }
  return newest == null ? null : now - newest;
}

// Cart lines from a PayPal order item sku "DOG-TEE:M". Used by the webhook, which has no browser body.
export function itemsFromPaypalOrder(order) {
  const pu = ((order && order.purchase_units) || [])[0] || {};
  const items = Array.isArray(pu.items) ? pu.items : [];
  return items.map((it) => {
    const raw = String((it && it.sku) || '');
    const i = raw.indexOf(':');
    const quantity = Number(it && it.quantity != null ? it.quantity : 1);
    return {
      sku: i >= 0 ? raw.slice(0, i) : raw,
      size: i >= 0 ? raw.slice(i + 1) : '',
      quantity: Number.isFinite(quantity) ? quantity : 1,
    };
  });
}

// Shipping address + payer email from the PayPal order. Phone is included only when PayPal has one.
export function addressFromPaypalOrder(order) {
  const pu = ((order && order.purchase_units) || [])[0] || {};
  const ship = pu.shipping || {};
  const addr = ship.address || {};
  const payer = (order && order.payer) || {};
  const phoneObj = (payer.phone && payer.phone.phone_number) || ship.phone_number || null;
  const phone = phoneObj && typeof phoneObj === 'object' ? phoneObj.national_number : (typeof phoneObj === 'string' ? phoneObj : '');
  const payerName = payer.name || {};
  const name = (ship.name && ship.name.full_name) || [payerName.given_name, payerName.surname].filter(Boolean).join(' ');
  return {
    name,
    email: payer.email_address || '',
    phone: phone || '',
    address: addr.address_line_1 || '',
    address2: addr.address_line_2 || '',
    city: addr.admin_area_2 || '',
    state: addr.admin_area_1 || '',
    zip: addr.postal_code || '',
    country: addr.country_code || '',
  };
}

function printifyHeaders(token, json) {
  const h = { Authorization: 'Bearer ' + token, 'User-Agent': 'DoG-fulfill' };
  if (json) h['Content-Type'] = 'application/json;charset=utf-8';
  return h;
}

// Idempotency pre-check. Printify has no shop_order_id filter.
// GET /v1/shops/{shop_id}/orders.json accepts page and limit (limit max 10) and returns
// { current_page, data, last_page, per_page, total, next_page_url, ... }.
// The external_id we send on create is returned as metadata.shop_order_id. Some responses also
// echo a top-level external_id. metadata.shop_order_label is only a display label and must not
// be used for matching. A lookup error must not fall through to create.
// Page through the shop (Printify has no external_id filter). Cap the scan so it still fits
// beside the production-ready wait inside the 60s function limit.
const PRECHECK_PAGES = 20;
const PAGE_LIMIT = 10;
const CANCELED_STATUS = new Set(['canceled', 'cancelled']);
const CANCELABLE_STATUS = new Set(['on-hold', 'pending', 'cost-calculation']);

function orderExternalIds(o) {
  const ids = [];
  if (o && o.external_id != null && o.external_id !== '') ids.push(String(o.external_id));
  const shopOrderId = o && o.metadata ? o.metadata.shop_order_id : undefined;
  if (shopOrderId != null && shopOrderId !== '') ids.push(String(shopOrderId));
  return ids;
}
function matchesPaypalOrder(o, paypalOrderId) {
  const want = new Set([String(paypalOrderId), 'dog-' + paypalOrderId]); // 'dog-' = legacy external_id
  return orderExternalIds(o).some((id) => want.has(id));
}
function isCanceledStatus(status) { return CANCELED_STATUS.has(String(status || '')); }
function oldestFirst(a, b) {
  const ta = Date.parse((a && a.created_at) || '') || 0;
  const tb = Date.parse((b && b.created_at) || '') || 0;
  if (ta !== tb) return ta - tb;
  return String(a && a.id).localeCompare(String(b && b.id));
}
async function listMatchingOrders(token, orderId) {
  const hits = [];
  const seen = new Set();
  for (let page = 1; page <= PRECHECK_PAGES; page++) {
    const url = 'https://api.printify.com/v1/shops/' + SHOP + '/orders.json?limit=' + PAGE_LIMIT + '&page=' + page;
    let r;
    try {
      r = await fetchJson(url, { headers: printifyHeaders(token) });
    } catch (e) {
      throw new FulfillError(502, 'Order service unavailable', 'Printify list orders failed: ' + String(e && e.message || e), { paid: true });
    }
    if (!r.ok || !r.body || !Array.isArray(r.body.data)) {
      throw new FulfillError(502, 'Order service unavailable', 'Printify list orders failed ' + (r && r.status), { paid: true });
    }
    for (const o of r.body.data) {
      if (!o || o.id == null || !matchesPaypalOrder(o, orderId)) continue;
      const id = String(o.id);
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push(o);
    }
    const last = Number(r.body.last_page);
    if (Number.isFinite(last)) {
      if (page >= last) break;
    } else if (r.body.data.length < PAGE_LIMIT || !r.body.next_page_url) {
      break;
    }
  }
  return hits;
}
async function findExistingOrder(token, orderId) {
  const live = (await listMatchingOrders(token, orderId)).filter((o) => !isCanceledStatus(o.status));
  if (!live.length) return null;
  live.sort(oldestFirst);
  return live[0];
}
async function cancelPrintifyOrder(token, printifyId) {
  const url = 'https://api.printify.com/v1/shops/' + SHOP + '/orders/' + printifyId + '/cancel.json';
  try {
    return await fetchJson(url, { method: 'POST', headers: printifyHeaders(token, true) });
  } catch (e) {
    return { ok: false, status: 0, body: { error: String(e && e.message || e) } };
  }
}

// Used only when the cart/address was rejected: did the buyer already pay for this order?
async function paypalOrderIsPaid(orderId) {
  try {
    const token = await paypalAccessToken();
    const r = await fetchJson(paypalBase() + '/v2/checkout/orders/' + encodeURIComponent(orderId), { headers: { Authorization: 'Bearer ' + token } });
    return !!(r.ok && r.body && r.body.status === 'COMPLETED');
  } catch (_) {
    return false;
  }
}

// Alerts: webhook and/or email. Each channel is a no-op when not configured; failures are
// logged and never change the response to the buyer.
async function alertWebhook(text, extra) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...extra }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) log('error', 'alert webhook failed', { status: r.status });
    return r.ok;
  } catch (e) {
    log('error', 'alert webhook failed', { err: String(e && e.message) });
    return false;
  }
}

async function alertEmail(text, extra) {
  const to = String(process.env.ALERT_EMAIL_TO || DEFAULT_ALERT_TO).split(',').map((s) => s.trim()).filter(Boolean);
  const key = String(process.env.RESEND_API_KEY || '').trim(); // tolerate pasted whitespace/newline
  if (!to.length) return false;
  if (!key) {
    log('warn', 'ALERT_EMAIL_TO set but no RESEND_API_KEY; alert email not sent', {});
    return false;
  }
  const from = String(process.env.ALERT_EMAIL_FROM || '').trim() || DEFAULT_ALERT_FROM;
  const lines = [text, ''];
  for (const [k, v] of Object.entries(extra || {})) lines.push(k + ': ' + (v == null ? '' : String(v)));
  lines.push('', 'env: ' + (process.env.VERCEL_ENV || 'unknown'));
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: '[DoG] Order needs attention' + (extra && extra.paypalOrderId ? ' ' + extra.paypalOrderId : ''), text: lines.join('\n') }),
      signal: AbortSignal.timeout(5000),
    });
    let rb = null;
    try { rb = await r.json(); } catch (_) { rb = null; }
    if (!r.ok) log('error', 'alert email failed', { status: r.status, name: rb && rb.name, message: rb && String(rb.message || '').slice(0, 300) });
    else log('info', 'alert email sent', { resendId: rb && rb.id });
    return r.ok;
  } catch (e) {
    log('error', 'alert email failed', { err: String(e && e.message) });
    return false;
  }
}

async function alertHuman(text, extra) {
  const stage = (extra && extra.stage) || 'paid';
  const id = (extra && extra.paypalOrderId) || '';
  if (!shouldSendAlert(id, stage)) {
    log('warn', 'alert throttled', { paypalOrderId: id, stage });
    return;
  }
  await Promise.all([alertWebhook(text, extra), alertEmail(text, extra)]);
}

// Every alert (verify and paid): one per PayPal order id per stage per hour, and at most
// ALERT_GLOBAL_MAX per hour per warm instance. There is no free cross-instance store.
const ALERT_WINDOW_MS = 60 * 60 * 1000;
const ALERT_GLOBAL_MAX = 20;
const alertLog = []; // { key, t } within the window
function shouldSendAlert(orderId, stage, now = Date.now()) {
  const cutoff = now - ALERT_WINDOW_MS;
  for (let i = alertLog.length - 1; i >= 0; i--) if (alertLog[i].t <= cutoff) alertLog.splice(i, 1);
  const key = String(orderId || '') + '\n' + String(stage || 'paid');
  if (alertLog.some((e) => e.key === key)) return false;
  if (alertLog.length >= ALERT_GLOBAL_MAX) return false;
  alertLog.push({ key, t: now });
  return true;
}

// Printify creates API orders in 'pending' / 'cost-calculation' while it prices and checks the address.
// send_to_production is rejected (400, code 8502) until the order is 'on-hold'. Any other non-terminal
// status is "not ready yet": keep polling. Already-sent statuses are done. Terminal failures stop and alert.
// Wait is ~40s so PayPal + this poll + the confirmation email still finish inside the 60s function limit.
// Returns { sent: true } or { sent: false, status, detail } — never throws for "not ready yet".
const READY_WAIT_MS = 40000;
const READY_POLL_MS = 2000;
const ALREADY_SENT = new Set(['sending-to-production', 'in-production', 'fulfilled', 'partially-fulfilled', 'shipping', 'shipped', 'delivered']);
const TERMINAL_BAD = new Set(['canceled', 'cancelled', 'has-issues', 'unfulfillable', 'payment-not-received']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readyTiming() {
  const wait = Number(process.env.PRINTIFY_READY_WAIT_MS || READY_WAIT_MS);
  const poll = Number(process.env.PRINTIFY_READY_POLL_MS || READY_POLL_MS);
  return { wait: wait > 0 ? wait : READY_WAIT_MS, poll: poll > 0 ? poll : READY_POLL_MS };
}
async function sendWhenReady(token, printifyId) {
  const base = 'https://api.printify.com/v1/shops/' + SHOP + '/orders/' + printifyId;
  const timing = readyTiming();
  const deadline = Date.now() + timing.wait;
  let status = 'unknown';
  for (;;) {
    const g = await fetchJson(base + '.json', { headers: printifyHeaders(token) }).catch(() => null);
    status = (g && g.ok && g.body && g.body.status) || status;
    log('info', 'printify order status', { printifyId, status });
    if (ALREADY_SENT.has(status)) return { sent: true, status };
    if (TERMINAL_BAD.has(status)) return { sent: false, status, detail: 'terminal status ' + status };
    if (status === 'on-hold') break;
    // pending, cost-calculation, unknown, and any other not-ready status: keep polling.
    if (Date.now() + timing.poll > deadline) return { sent: false, status, detail: 'still ' + status + ' after ' + timing.wait + 'ms' };
    await sleep(timing.poll);
  }
  const sent = await fetchJson(base + '/send_to_production.json', { method: 'POST', headers: printifyHeaders(token, true) });
  if (sent.ok) return { sent: true, status: 'sending-to-production' };
  return { sent: false, status, detail: 'send_to_production failed ' + sent.status + ' ' + JSON.stringify(sent.body).slice(0, 300) };
}

export function _resetAlertThrottle() { alertLog.length = 0; } // tests only

// Authenticated PayPal REST call. Shared with api/paypal-webhook.js (signature verify).
export async function paypalAuthedFetch(path, { method = 'GET', body } = {}) {
  const token = await paypalAccessToken();
  const opts = { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  return fetchJson(paypalBase() + path, opts);
}

function applyPaypalShip(address_to, pp, ctx) {
  const ship = pp.shipping && pp.shipping.address;
  if (!ship) return;
  if (ship.country_code && ship.country_code !== 'US') throw new FulfillError(400, 'We currently ship to US addresses only', 'PayPal ship country ' + ship.country_code, { paid: true });
  const differs = (ship.postal_code && ship.postal_code !== address_to.zip) ||
    (ship.address_line_1 && ship.address_line_1.trim().toLowerCase() !== address_to.address1.toLowerCase());
  if (!differs) return;
  log('warn', 'PayPal address differs from form; using PayPal address', ctx);
  address_to.address1 = str(ship.address_line_1, 200) || address_to.address1;
  address_to.address2 = str(ship.address_line_2, 200);
  address_to.city = str(ship.admin_area_2, 100) || address_to.city;
  const st = str(ship.admin_area_1, 2).toUpperCase();
  if (!US_STATES.has(st)) throw new FulfillError(400, 'Please choose a US state', 'PayPal ship state ' + st, { paid: true });
  address_to.region = st;
  address_to.zip = str(ship.postal_code, 10) || address_to.zip;
}

// Shared by the browser POST and the PayPal webhook. Writes the HTTP response.
// source 'webhook' defers the address check until after the duplicate lookup, because a
// PayPal order often has no phone and an already-fulfilled order must not alert again.
export async function fulfillPaidOrder(body, res, source = 'browser') {
  const token = process.env.PRINTIFY_TOKEN;
  const dryRun = isDryRun();
  body = body || {};
  const paypalOrderId = str(body.paypalOrderId, 64);
  const ctx = { paypalOrderId, email: str(body.address && body.address.email, 200), source };
  if (dryRun) ctx.dryRun = true;

  try {
    if (!isPaypalOrderId(paypalOrderId)) throw new FulfillError(400, 'Invalid order', 'missing/bad paypalOrderId');
    // In dry-run a missing token is expected (PRINTIFY_TOKEN must never be set on Preview).
    if (!token && !dryRun) throw new FulfillError(503, 'Order service unavailable', 'PRINTIFY_TOKEN missing', { paid: true });

    const cart = buildCart(body.items);
    // Browser path rejects a bad address before PayPal so the buyer still gets the phone/address
    // message. The webhook has no form body; it looks for an existing order first.
    let address_to = source === 'webhook' ? null : buildAddress(body.address);
    const pp = await verifyPaypal(paypalOrderId, cart); // throws unless paid in full
    if (address_to) applyPaypalShip(address_to, pp, ctx);

    const age = captureAgeMs(pp.order);
    if (age != null && age > MAX_CAPTURE_AGE_MS) {
      log('warn', 'capture too old', { ...ctx, ageMs: age });
      await alertHuman('DoG paid order is older than 24h and was NOT sent to Printify: PayPal ' + paypalOrderId + '. Check PayPal before creating anything.', { paypalOrderId, email: ctx.email, error: 'capture too old', stage: 'capture-age' });
      return res.status(200).json({ ok: true });
    }

    // Duplicate lookup is read-only; in dry-run it only runs if a token happens to be present.
    const existing = token ? await findExistingOrder(token, paypalOrderId) : null;
    if (existing) {
      log('info', 'duplicate request; order already exists', { ...ctx, printifyId: existing.id, status: existing.status });
      if (!dryRun && !ALREADY_SENT.has(existing.status) && !TERMINAL_BAD.has(existing.status)) {
        const r = await sendWhenReady(token, existing.id);
        log(r.sent ? 'info' : 'warn', r.sent ? 'duplicate: sent existing order to production' : 'duplicate: existing order not sent', { ...ctx, printifyId: existing.id, ...r });
        if (!r.sent) {
          await alertHuman('DoG order created but NOT sent to production: PayPal ' + paypalOrderId + ' printifyId=' + existing.id + ' — ' + r.detail + '. Open Printify > Orders and click Send to production.', { paypalOrderId, printifyId: existing.id, email: ctx.email, error: r.detail, stage: 'send_to_production' });
        }
      } else if (!dryRun && TERMINAL_BAD.has(existing.status)) {
        await alertHuman('DoG order created but NOT sent to production: PayPal ' + paypalOrderId + ' printifyId=' + existing.id + ' — terminal status ' + existing.status + '. Open Printify > Orders and click Send to production.', { paypalOrderId, printifyId: existing.id, email: ctx.email, error: 'terminal status ' + existing.status, stage: 'send_to_production' });
      }
      // No confirmation email: the request that first created the order already sent one
      // (Resend Idempotency-Key dog-order-confirm-<order id> dedupes if it races).
      return res.status(200).json({ ok: true, duplicate: true, printifyId: existing.id });
    }

    if (!address_to) {
      address_to = buildAddress(body.address);
      applyPaypalShip(address_to, pp, ctx);
    }

    const order = {
      // Printify surfaces this as metadata.shop_order_id on GET .../orders.json.
      external_id: paypalOrderId,
      label: 'DoG web ' + paypalOrderId,
      line_items: cart.lines.map(({ product_id, variant_id, quantity }) => ({ product_id, variant_id, quantity })),
      shipping_method: 1,
      send_shipping_notification: true,
      address_to,
    };
    if (dryRun) {
      // Never reach Printify create/send in dry-run.
      log('info', 'dry run: Printify order NOT created', { ...ctx, paidCents: pp.paidCents });
      return res.status(200).json({ ok: true, dryRun: true, paidCents: pp.paidCents, wouldCreate: order });
    }
    const created = await fetchJson('https://api.printify.com/v1/shops/' + SHOP + '/orders.json', {
      method: 'POST', headers: printifyHeaders(token, true), body: JSON.stringify(order),
    });
    if (!created.ok || !created.body || !created.body.id) {
      throw new FulfillError(502, 'Order service unavailable', 'Printify create failed ' + created.status + ' ' + JSON.stringify(created.body).slice(0, 500), { paid: true });
    }
    const printifyId = created.body.id;

    // Two creates can both pass the pre-check. Re-list before send_to_production and keep only
    // the oldest non-canceled order. Cancel the others while they are still not in production.
    let siblings = [];
    try {
      siblings = await listMatchingOrders(token, paypalOrderId);
    } catch (e) {
      log('error', 'post-create duplicate scan failed', { ...ctx, printifyId, detail: String(e && e.message || e) });
      siblings = [];
    }
    const live = siblings.filter((o) => !isCanceledStatus(o.status));
    if (!live.some((o) => String(o.id) === String(printifyId))) {
      live.push({
        id: printifyId,
        status: (created.body && created.body.status) || 'pending',
        created_at: (created.body && created.body.created_at) || new Date().toISOString(),
        external_id: paypalOrderId,
        metadata: { shop_order_id: paypalOrderId },
      });
    }
    live.sort(oldestFirst);
    const winner = live[0];
    const extras = live.slice(1);
    if (extras.length) {
      const canceledIds = [];
      for (const extra of extras) {
        const st = String(extra.status || 'pending');
        if (!CANCELABLE_STATUS.has(st)) {
          log('warn', 'duplicate order not cancelable', { ...ctx, printifyId: extra.id, status: st });
          continue;
        }
        const c = await cancelPrintifyOrder(token, extra.id);
        log(c.ok ? 'info' : 'error', c.ok ? 'canceled duplicate printify order' : 'cancel duplicate failed', { ...ctx, printifyId: extra.id, status: c.status });
        if (c.ok) canceledIds.push(String(extra.id));
      }
      await alertHuman('DoG duplicate Printify orders for PayPal ' + paypalOrderId + '. Kept oldest ' + winner.id + '. Canceled ' + (canceledIds.join(', ') || '(none)') + '. Open Printify and confirm only one order is in production.', { paypalOrderId, printifyId: winner.id, email: ctx.email, error: 'duplicate printify orders', stage: 'duplicate-cancel' });
    }
    if (String(winner.id) !== String(printifyId)) {
      log('info', 'duplicate request; newer order not sent', { ...ctx, printifyId, kept: winner.id });
      return res.status(200).json({ ok: true, duplicate: true, printifyId: winner.id });
    }

    const sendRes = await sendWhenReady(token, printifyId);
    if (!sendRes.sent) {
      // Paid and the Printify order exists; only the production step is waiting. Do not fail the
      // customer — alert a human to press "Send to production" (or a later retry/duplicate call will).
      log('warn', 'order created but not yet sent to production', { ...ctx, printifyId, ...sendRes });
      await alertHuman('DoG order created but NOT sent to production: PayPal ' + paypalOrderId + ' printifyId=' + printifyId + ' — ' + sendRes.detail + '. Open Printify > Orders and click Send to production.', { paypalOrderId, printifyId, email: ctx.email, error: sendRes.detail, stage: 'send_to_production' });
    }
    log('info', 'order fulfilled', { ...ctx, printifyId, paidCents: pp.paidCents, sentToProduction: sendRes.sent });
    // Customer confirmation: after this request's order is the one going to production.
    // Resend Idempotency-Key is dog-order-confirm-<paypal order id>, so a racing webhook
    // that also sends does not deliver a second email. A duplicate return above does not send.
    if (!dryRun) {
      await sendOrderConfirmation(pp.payerEmail, {
        orderId: paypalOrderId,
        date: new Date(),
        sentToProduction: sendRes.sent,
        firstName: address_to.first_name,
        lines: cart.lines.map((l) => ({ name: CATALOG[l.sku].name, size: l.size, quantity: l.quantity, priceCents: CATALOG[l.sku].priceCents })),
        shippingCents: SHIPPING_CENTS,
        donationCents: 0, // donations are separate PayPal orders and never pass through this endpoint
        totalCents: pp.paidCents,
        address: address_to,
      }, { log });
    }
    return res.status(200).json({ ok: true, printifyId, sentToProduction: sendRes.sent });
  } catch (e) {
    const fe = e instanceof FulfillError ? e : new FulfillError(500, 'Order service unavailable', String((e && e.message) || e), { paid: true });
    if (fe.input && isPaypalOrderId(paypalOrderId) && (await paypalOrderIsPaid(paypalOrderId))) fe.paid = true;
    log(fe.paid || fe.verify ? 'error' : 'warn', 'fulfill failed', { ...ctx, status: fe.status, detail: fe.message });
    if (fe.paid) {
      await alertHuman('DoG order needs attention: PayPal ' + (paypalOrderId || '(none)') + ' — ' + fe.message, { paypalOrderId, email: ctx.email, error: fe.message, stage: 'paid' });
    } else if (fe.verify) {
      await alertHuman('DoG order needs attention: PayPal verification failed after checkout for ' + paypalOrderId + ' — ' + fe.message + '. The buyer may have been charged; check PayPal.', { paypalOrderId, email: ctx.email, error: fe.message, stage: 'paypal-verify' });
    }
    return res.status(fe.status).json({ ok: false, error: fe.publicMsg });
  }
}

export default async function handler(req, res) {
  const origin = req.headers && req.headers.origin;
  const origins = allowedOrigins();
  res.setHeader('Access-Control-Allow-Origin', origins.includes(origin) ? origin : origins[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = process.env.PRINTIFY_TOKEN;
  const dryRun = isDryRun();
  if (req.method !== 'POST') {
    // Health check — same shape as the version deployed before this change (+ dryRun outside production).
    const health = { ok: true, service: 'dog-fulfill', shop: SHOP, hasToken: !!token };
    if (dryRun) health.dryRun = true;
    return res.status(200).json(health);
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  return fulfillPaidOrder(body || {}, res, 'browser');
}

// Read-only re-export for api/pool.js (fallback revenue when PayPal cannot be read).
export { CATALOG, SHIPPING_CENTS };
