// DoG donation thank-you endpoint (Vercel serverless function).
//
// Flow: the donate PayPal button on index.html captures the donation client-side, then fires a
// fire-and-forget POST { paypalOrderId } here. We fetch that order from PayPal server-side and only
// send a thank-you email when ALL of these hold:
//   - the order exists and status === 'COMPLETED' with at least one COMPLETED USD capture
//   - it is a donation: purchase_units[0].custom_id/reference_id === 'donation-pool' (set by the donate
//     createOrder on index.html) and every line item, if any, is category DONATION with no sku
//     (product orders from the cart always carry sku 'DOG-XXX:size' and PHYSICAL_GOODS)
//   - the capture is recent (MAX_AGE_HOURS), so old order ids cannot be replayed after Resend's 24 h
//     idempotency window
// Amount, payer email and name come from PayPal only; nothing in the request body except the order id is used.
// The response is always { ok: true } for POST (no oracle, never breaks the donation UX); details go to logs.
//
// Env vars (all already set for api/fulfill.js; nothing new):
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV (optional, 'live' default)
//   RESEND_API_KEY, ORDER_EMAIL_FROM (fallback ALERT_EMAIL_FROM), ORDER_EMAIL_REPLY_TO (optional)
//   EXTRA_ALLOWED_ORIGINS (optional, NON-PRODUCTION ONLY), same CORS policy as fulfill

import { sendDonationThanks } from './_lib/donation-email.js';

const BASE_ORIGINS = ['https://www.dadsofgod.com', 'https://dadsofgod.com'];
const DONATION_MARKER = 'donation-pool';
const TIMEOUT_MS = 5000;
const MAX_AGE_HOURS = 12;

const isProduction = () => process.env.VERCEL_ENV === 'production';
function allowedOrigins() {
  if (isProduction()) return BASE_ORIGINS;
  const extra = String(process.env.EXTRA_ALLOWED_ORIGINS || '')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter((o) => /^https?:\/\/[^\s/]+$/i.test(o));
  return BASE_ORIGINS.concat(extra);
}

const log = (level, msg, extra) => console[level](JSON.stringify({ svc: 'dog-donation-thanks', msg, ...extra }));

function paypalBase() {
  return (process.env.PAYPAL_ENV || 'live').toLowerCase() === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

// Referenced timer so the limit is real (AbortSignal.timeout is unref'd on Node 22).
async function fetchJson(url, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

let ppToken = null; // { token, exp } cached per warm instance
async function paypalAccessToken() {
  if (ppToken && ppToken.exp > Date.now() + 60000) return ppToken.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID/SECRET missing');
  const r = await fetchJson(paypalBase() + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok || !r.body || !r.body.access_token) throw new Error('PayPal auth failed ' + r.status);
  ppToken = { token: r.body.access_token, exp: Date.now() + (Number(r.body.expires_in) || 300) * 1000 };
  return ppToken.token;
}

// Returns { ok: true, donation } or { ok: false, reason }.
export function checkDonationOrder(o, now = Date.now()) {
  if (!o || typeof o !== 'object') return { ok: false, reason: 'no order body' };
  if (o.status !== 'COMPLETED') return { ok: false, reason: 'status ' + o.status };
  const units = Array.isArray(o.purchase_units) ? o.purchase_units : [];
  if (units.length !== 1) return { ok: false, reason: 'purchase_units ' + units.length };
  const pu = units[0] || {};
  if (pu.custom_id !== DONATION_MARKER && pu.reference_id !== DONATION_MARKER) return { ok: false, reason: 'not a donation (no marker)' };
  const items = Array.isArray(pu.items) ? pu.items : [];
  if (items.some((it) => !it || it.category !== 'DONATION' || (it.sku != null && it.sku !== ''))) return { ok: false, reason: 'not a donation (items)' };
  const captures = ((pu.payments || {}).captures || []).filter((c) => c && c.status === 'COMPLETED');
  if (!captures.length) return { ok: false, reason: 'no COMPLETED capture' };
  let cents = 0;
  for (const c of captures) {
    if (!c.amount || c.amount.currency_code !== 'USD') return { ok: false, reason: 'non-USD capture' };
    const v = Math.round(Number(c.amount.value) * 100);
    if (!Number.isFinite(v)) return { ok: false, reason: 'bad capture amount' };
    cents += v;
  }
  if (cents <= 0) return { ok: false, reason: 'zero amount' };
  const t = Date.parse(captures[0].create_time || captures[0].update_time || o.update_time || o.create_time || '');
  if (!Number.isFinite(t)) return { ok: false, reason: 'no capture time' };
  if (now - t > MAX_AGE_HOURS * 3600 * 1000) return { ok: false, reason: 'capture too old' };
  const payer = o.payer || {};
  return {
    ok: true,
    donation: {
      amountCents: cents,
      captureId: String(captures[0].id || ''),
      date: new Date(t),
      payerEmail: String(payer.email_address || ''),
      firstName: String((payer.name && payer.name.given_name) || '').trim().slice(0, 60),
    },
  };
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
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'dog-donation-thanks' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  body = body || {};
  const paypalOrderId = typeof body.paypalOrderId === 'string' ? body.paypalOrderId.trim().slice(0, 64) : '';
  const ctx = { paypalOrderId };

  try {
    if (!/^[A-Z0-9]{8,64}$/i.test(paypalOrderId)) {
      log('warn', 'donation thanks: bad paypalOrderId', {});
      return res.status(200).json({ ok: true });
    }
    const token = await paypalAccessToken();
    const r = await fetchJson(paypalBase() + '/v2/checkout/orders/' + encodeURIComponent(paypalOrderId), {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    if (!r.ok || !r.body) {
      log('warn', 'donation thanks: PayPal GET order failed', { ...ctx, status: r.status });
      return res.status(200).json({ ok: true });
    }
    const chk = checkDonationOrder(r.body);
    if (!chk.ok) {
      log('warn', 'donation thanks: not sent', { ...ctx, reason: chk.reason });
      return res.status(200).json({ ok: true });
    }
    const d = chk.donation;
    log('info', 'donation verified', { ...ctx, amountCents: d.amountCents, captureId: d.captureId });
    await sendDonationThanks(d.payerEmail, {
      orderId: paypalOrderId,
      captureId: d.captureId,
      date: d.date,
      firstName: d.firstName,
      amountCents: d.amountCents,
    }, { log });
  } catch (e) {
    log('error', 'donation thanks error', { ...ctx, err: String((e && e.message) || e) });
  }
  return res.status(200).json({ ok: true });
}
