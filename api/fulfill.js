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

const SHOP = process.env.PRINTIFY_SHOP_ID || '27166805';
const SHIPPING_CENTS = 599; // flat US shipping per order
const ALLOWED_ORIGINS = ['https://www.dadsofgod.com', 'https://dadsofgod.com'];

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
    name: 'Signature Ballcap', priceCents: 2900, product: '69f6f9549eacb75844020e88',
    sizes: { 'One size': 118238 },
  },
};
// ============================================================================

const US_STATES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']);
const MAX_QTY_PER_LINE = 10;
const MAX_LINES = 20;
const TIMEOUT_MS = 8000;

class FulfillError extends Error {
  constructor(status, publicMsg, detail, { paid = false, input = false } = {}) {
    super(detail || publicMsg);
    this.status = status;
    this.publicMsg = publicMsg;
    this.paid = paid; // true => money was (or may have been) taken; alert a human
    this.input = input; // true => bad cart/address; check PayPal in case the buyer already paid
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

// Validate the US shipping address. Name is required; phone is optional.
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
  const phone = str(a.phone, 30);
  if (phone) out.phone = phone;
  if (!['US', 'USA', 'UNITED STATES'].includes(country)) throw new FulfillError(400, 'We currently ship to US addresses only', 'non-US country ' + country, { input: true });
  if (parts.length < 2) throw new FulfillError(400, 'Please enter your first and last name', 'name missing/single word', { input: true });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new FulfillError(400, 'Please enter a valid email', 'bad email', { input: true });
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
  if (r.status === 404) throw new FulfillError(400, 'Payment not found', 'PayPal order not found ' + orderId);
  if (!r.ok || !r.body) throw new FulfillError(502, 'Order service unavailable', 'PayPal GET order failed ' + r.status, { paid: true });
  const o = r.body;
  if (o.status !== 'COMPLETED') throw new FulfillError(402, 'Payment not completed', 'PayPal status ' + o.status);
  const pu = (o.purchase_units || [])[0] || {};
  const captures = ((pu.payments || {}).captures || []).filter((c) => c.status === 'COMPLETED');
  if (!captures.length) throw new FulfillError(402, 'Payment not completed', 'no COMPLETED capture');
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
  return { paidCents, shipping: pu.shipping || null, payerEmail: (o.payer || {}).email_address || '' };
}

function printifyHeaders(token, json) {
  const h = { Authorization: 'Bearer ' + token, 'User-Agent': 'DoG-fulfill' };
  if (json) h['Content-Type'] = 'application/json;charset=utf-8';
  return h;
}

// Idempotency pre-check: look through recent Printify orders for this PayPal order ID.
// Printify has no external_id filter and caps pages at 10 orders, so we scan the newest pages.
const PRECHECK_PAGES = 3;
async function findExistingOrder(token, orderId) {
  const ids = new Set([orderId, 'dog-' + orderId]); // 'dog-' prefix = legacy format
  for (let page = 1; page <= PRECHECK_PAGES; page++) {
    const r = await fetchJson('https://api.printify.com/v1/shops/' + SHOP + '/orders.json?limit=10&page=' + page, { headers: printifyHeaders(token) });
    if (!r.ok || !r.body) throw new FulfillError(502, 'Order service unavailable', 'Printify list orders failed ' + r.status, { paid: true });
    const data = r.body.data || [];
    const hit = data.find((o) => ids.has(String(o.external_id || '')) || ids.has(String((o.metadata || {}).shop_order_label || '')));
    if (hit) return hit;
    if (!r.body.next_page_url || data.length < 10) break;
  }
  return null;
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

async function alertHuman(text, extra) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...extra }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    log('error', 'alert webhook failed', { err: String(e && e.message) });
  }
}

export default async function handler(req, res) {
  const origin = req.headers && req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = process.env.PRINTIFY_TOKEN;
  if (req.method !== 'POST') {
    // Health check — same shape as the version deployed before this change.
    return res.status(200).json({ ok: true, service: 'dog-fulfill', shop: SHOP, hasToken: !!token });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  body = body || {};
  const paypalOrderId = str(body.paypalOrderId, 64);
  const ctx = { paypalOrderId, email: str(body.address && body.address.email, 200) };

  try {
    if (!/^[A-Z0-9]{8,64}$/i.test(paypalOrderId)) throw new FulfillError(400, 'Invalid order', 'missing/bad paypalOrderId');
    if (!token) throw new FulfillError(503, 'Order service unavailable', 'PRINTIFY_TOKEN missing', { paid: true });

    const cart = buildCart(body.items);
    const address_to = buildAddress(body.address);
    const pp = await verifyPaypal(paypalOrderId, cart); // throws unless paid in full

    // PayPal's shipping address (set from the same form via SET_PROVIDED_ADDRESS) is authoritative.
    const ship = pp.shipping && pp.shipping.address;
    if (ship) {
      if (ship.country_code && ship.country_code !== 'US') throw new FulfillError(400, 'We currently ship to US addresses only', 'PayPal ship country ' + ship.country_code, { paid: true });
      const differs = (ship.postal_code && ship.postal_code !== address_to.zip) ||
        (ship.address_line_1 && ship.address_line_1.trim().toLowerCase() !== address_to.address1.toLowerCase());
      if (differs) {
        log('warn', 'PayPal address differs from form; using PayPal address', ctx);
        address_to.address1 = str(ship.address_line_1, 200) || address_to.address1;
        address_to.address2 = str(ship.address_line_2, 200);
        address_to.city = str(ship.admin_area_2, 100) || address_to.city;
        const st = str(ship.admin_area_1, 2).toUpperCase();
        if (!US_STATES.has(st)) throw new FulfillError(400, 'Please choose a US state', 'PayPal ship state ' + st, { paid: true });
        address_to.region = st;
        address_to.zip = str(ship.postal_code, 10) || address_to.zip;
      }
    }

    const existing = await findExistingOrder(token, paypalOrderId);
    if (existing) {
      log('info', 'duplicate request; order already exists', { ...ctx, printifyId: existing.id });
      return res.status(200).json({ ok: true, duplicate: true, printifyId: existing.id });
    }

    const order = {
      external_id: paypalOrderId,
      label: 'DoG web ' + paypalOrderId,
      line_items: cart.lines.map(({ product_id, variant_id, quantity }) => ({ product_id, variant_id, quantity })),
      shipping_method: 1,
      send_shipping_notification: true,
      address_to,
    };
    const created = await fetchJson('https://api.printify.com/v1/shops/' + SHOP + '/orders.json', {
      method: 'POST', headers: printifyHeaders(token, true), body: JSON.stringify(order),
    });
    if (!created.ok || !created.body || !created.body.id) {
      throw new FulfillError(502, 'Order service unavailable', 'Printify create failed ' + created.status + ' ' + JSON.stringify(created.body).slice(0, 500), { paid: true });
    }
    const printifyId = created.body.id;
    const sent = await fetchJson('https://api.printify.com/v1/shops/' + SHOP + '/orders/' + printifyId + '/send_to_production.json', {
      method: 'POST', headers: printifyHeaders(token, true),
    });
    if (!sent.ok) {
      // Order exists in Printify but is not in production; a human must push it.
      throw new FulfillError(502, 'Order service unavailable', 'send_to_production failed ' + sent.status + ' printifyId=' + printifyId + ' ' + JSON.stringify(sent.body).slice(0, 300), { paid: true });
    }
    log('info', 'order fulfilled', { ...ctx, printifyId, paidCents: pp.paidCents });
    return res.status(200).json({ ok: true, printifyId });
  } catch (e) {
    const fe = e instanceof FulfillError ? e : new FulfillError(500, 'Order service unavailable', String((e && e.message) || e), { paid: true });
    if (fe.input && /^[A-Z0-9]{8,64}$/i.test(paypalOrderId) && (await paypalOrderIsPaid(paypalOrderId))) fe.paid = true;
    log(fe.paid ? 'error' : 'warn', 'fulfill failed', { ...ctx, status: fe.status, detail: fe.message });
    if (fe.paid) {
      await alertHuman('DoG order needs attention: PayPal ' + (paypalOrderId || '(none)') + ' — ' + fe.message, { paypalOrderId, email: ctx.email });
    }
    return res.status(fe.status).json({ ok: false, error: fe.publicMsg });
  }
}
