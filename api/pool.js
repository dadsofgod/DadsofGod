// DoG partner-pool tracker (Vercel serverless function). GET only, read-only.
//
// Returns the public running total of DoG's pledge: 25% of profit after print, shipping, and PayPal
// fees on every paid dadsofgod.com order since launch, minus refunds, with payouts from
// pool-ledger.json. Aggregates only: no order ids, names, emails, or addresses in the response.
// Math and rules: api/_lib/pool.js.
//
// Env vars (all already used by api/fulfill.js; nothing new):
//   PRINTIFY_TOKEN        Printify token (orders.read is enough here)
//   PRINTIFY_SHOP_ID      optional, defaults to 27166805
//   PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV   read the actual PayPal fee per order.
//                          If missing or PayPal errors, the fee is estimated (3.49% + $0.49) and
//                          the response says fee_estimates: true.
//   EXTRA_ALLOWED_ORIGINS optional, NON-PRODUCTION ONLY (same rule as fulfill.js)
//
// Cached at Vercel's CDN for 10 minutes (stale-while-revalidate 1 hour); errors are never cached.

import { readFileSync } from 'node:fs';
import { CATALOG } from './fulfill.js';
import { computePool, parseTs, POOL_START } from './_lib/pool.js';

const SHOP = process.env.PRINTIFY_SHOP_ID || '27166805';
const BASE_ORIGINS = ['https://www.dadsofgod.com', 'https://dadsofgod.com'];
const TIMEOUT_MS = 8000;
const PAGE_LIMIT = 10; // Printify max
const MAX_PAGES = 50; // 500 orders; raise (or move to a stored ledger) well before that
const PAYPAL_CONCURRENCY = 4;

const isProduction = () => process.env.VERCEL_ENV === 'production';
function allowedOrigins() {
  if (isProduction()) return BASE_ORIGINS;
  const extra = String(process.env.EXTRA_ALLOWED_ORIGINS || '')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter((o) => /^https?:\/\/[^\s/]+$/i.test(o));
  return BASE_ORIGINS.concat(extra);
}
const log = (level, msg, extra) => console[level](JSON.stringify({ svc: 'dog-pool', msg, ...extra }));

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { ok: r.ok, status: r.status, body };
}

// All Printify orders created on/after `startMs` (newest first; stops at the first older page).
export async function listOrdersSince(token, startMs, fetcher = fetchJson) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetcher('https://api.printify.com/v1/shops/' + SHOP + '/orders.json?limit=' + PAGE_LIMIT + '&page=' + page, {
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'DoG-pool' },
    });
    if (!r.ok || !r.body || !Array.isArray(r.body.data)) throw new Error('Printify list orders failed ' + r.status);
    out.push(...r.body.data);
    const times = r.body.data.map((o) => parseTs(o.created_at)).filter(Number.isFinite);
    if (times.length && Math.min(...times) < startMs) break;
    const last = Number(r.body.last_page);
    if (Number.isFinite(last) ? page >= last : (r.body.data.length < PAGE_LIMIT || !r.body.next_page_url)) break;
    if (page === MAX_PAGES) throw new Error('more than ' + MAX_PAGES + ' pages of orders; raise MAX_PAGES');
  }
  return out;
}

function paypalBase() {
  return (process.env.PAYPAL_ENV || 'live').toLowerCase() === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
}

let ppToken = null;
async function paypalAccessToken() {
  if (ppToken && ppToken.exp > Date.now() + 60000) return ppToken.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await fetchJson(paypalBase() + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok || !r.body || !r.body.access_token) { log('warn', 'PayPal auth failed; fees will be estimated', { status: r.status }); return null; }
  ppToken = { token: r.body.access_token, exp: Date.now() + (Number(r.body.expires_in) || 300) * 1000 };
  return ppToken.token;
}

// Read-only GET of one PayPal order (same call fulfill.js makes). null on any failure.
function makePaypalReader() {
  let active = 0;
  const queue = [];
  const run = (fn) => new Promise((resolve) => {
    const go = async () => { active++; try { resolve(await fn()); } catch (_) { resolve(null); } finally { active--; if (queue.length) queue.shift()(); } };
    if (active < PAYPAL_CONCURRENCY) go(); else queue.push(go);
  });
  return (orderId) => run(async () => {
    const token = await paypalAccessToken();
    if (!token) return null;
    const r = await fetchJson(paypalBase() + '/v2/checkout/orders/' + encodeURIComponent(orderId), { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) { log('warn', 'PayPal GET order failed; fee estimated', { status: r.status }); return null; }
    return r.body;
  });
}

export function loadLedger() {
  return readFileSync(new URL('../pool-ledger.json', import.meta.url), 'utf8');
}

export default async function handler(req, res) {
  const origin = req.headers && req.headers.origin;
  const origins = allowedOrigins();
  res.setHeader('Access-Control-Allow-Origin', origins.includes(origin) ? origin : origins[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  if (req.method === 'OPTIONS') { res.setHeader('Cache-Control', 'public, max-age=86400'); return res.status(204).end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const token = process.env.PRINTIFY_TOKEN || process.env.PRINTIFY_API_TOKEN;
  try {
    if (!token) throw new Error('PRINTIFY_TOKEN missing');
    const ledger = loadLedger();
    const orders = await listOrdersSince(token, Date.parse(POOL_START));
    const out = await computePool({ orders, paypal: makePaypalReader(), ledger, catalog: CATALOG });
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json(out);
  } catch (e) {
    log('error', 'pool failed', { detail: String((e && e.message) || e).slice(0, 300) });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ ok: false, error: 'Pool total temporarily unavailable' });
  }
}
