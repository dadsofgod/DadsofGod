// Partner-pool math for GET /api/pool (pure functions + small I/O helpers; no writes anywhere).
//
// Pool basis (matches the site: "25% of profits after print, shipping, and fees"):
//   per paid website order: profit = revenue - Printify charge - PayPal fee
//                           pool   = 25% x max(profit, 0)          (integer cents, rounded per order)
//   set_aside = sum(pool) over counted orders, minus orders reversed as refunds
//   paid_out  = sum of payouts in pool-ledger.json;  held = set_aside - paid_out
//
// Inputs, actual wherever possible:
//   revenue        = PayPal capture gross (items + $5.99 shipping; donations are separate PayPal orders
//                    and never appear here). Fallback when PayPal can't be read: CATALOG price x qty + $5.99.
//   PayPal fee     = capture.seller_receivable_breakdown.paypal_fee (same GET /v2/checkout/orders call
//                    fulfill.js already makes; no new permission). Fallback estimate: 3.49% + $0.49.
//   Printify charge= order.total_price + total_shipping + total_tax (cents) once Printify has billed it.
//                    Before that (total_price 0): estimate from COST_ESTIMATE below + 7% tax estimate.
//
// Counted orders: metadata.order_type 'api', metadata.shop_order_id is a PayPal order id (as sent by
// api/fulfill.js as external_id; legacy 'dog-' prefix accepted), status not canceled, not a reprint,
// created_at >= POOL_START. Everything else (manual orders, old test orders, Pop-Up store) is ignored.

export const POOL_RATE = 0.25;
// Launch: 2026-11-01 00:00 America/Chicago (CDT, UTC-5). Orders before this are never counted.
export const POOL_START = '2026-11-01T00:00:00-05:00';
export const BASIS = '25% of profit after print, shipping, and PayPal fees';
export const SHIPPING_CENTS = 599;

// PayPal Checkout fee used ONLY when the actual fee can't be read (PayPal US merchant fees page,
// "PayPal Checkout" 3.49% + $0.49 fixed, last updated 2026-10-01).
export const FEE_PCT = 0.0349;
export const FEE_FIXED_CENTS = 49;
// Printify sales tax estimate for not-yet-billed orders: 7.0% of item cost (what Printify billed on the
// 2026-09-17 order: $1.11 on $15.82). Real tax varies by ship-to state.
export const TAX_EST = 0.07;

// Printify cost estimates for not-yet-billed orders (cents). Read from Printify on 2026-10-31:
// variants[].cost (GET /v1/shops/27166805/products/{id}.json) and v2 standard US shipping
// (first item / each additional). Update if Printify changes prices.
export const COST_ESTIMATE = {
  '69dc4507f6f60e22c60dec14': { first: 495, add: 240, cost: { 12126: 1593, 12125: 1593, 12124: 1593, 12127: 1593, 12128: 1802 } }, // DOG-TEE
  '69dc53923ff9b45b4504917c': { first: 495, add: 240, cost: { 33796: 1910, 33797: 1910, 33798: 1910, 33799: 1910, 33800: 2105 } }, // DOG-LS
  '69dc553ba6714c1fd5037169': { first: 879, add: 209, cost: { 109373: 3218, 109396: 3218, 109419: 3218, 109442: 3218, 109465: 3452 } }, // DOG-HOOD
  '69f6f9549eacb75844020e88': { first: 509, add: 219, cost: { 118238: 1828 } }, // DOG-CAP
};

const PAYPAL_ID_RE = /^(?:dog-)?([A-Z0-9]{8,64})$/i;
const cents = (v) => Math.round(Number(v) * 100);
const dollars = (c) => Math.round(c) / 100;

// Printify timestamps look like '2026-09-17 05:46:06+00:00'.
export function parseTs(s) {
  const t = Date.parse(String(s || '').replace(' ', 'T'));
  return Number.isFinite(t) ? t : NaN;
}

// PayPal order id for a Printify order created by api/fulfill.js, or null if it isn't one.
export function websiteOrderId(o) {
  const m = o && o.metadata;
  if (!m || m.order_type !== 'api' || m.is_reprint) return null;
  const hit = PAYPAL_ID_RE.exec(String(m.shop_order_id || ''));
  return hit ? hit[1].toUpperCase() : null;
}

export function isCounted(o, startMs) {
  if (!websiteOrderId(o)) return false;
  if (String(o.status || '').toLowerCase() === 'canceled' || String(o.status || '').toLowerCase() === 'cancelled') return false;
  const t = parseTs(o.created_at);
  return Number.isFinite(t) && t >= startMs;
}

// Printify cost in cents: actual once billed, otherwise an estimate.
export function printifyCost(o) {
  const actual = (Number(o.total_price) || 0) + (Number(o.total_shipping) || 0) + (Number(o.total_tax) || 0);
  if ((Number(o.total_price) || 0) > 0) return { cents: actual, estimated: false };
  let items = 0;
  let firsts = [];
  let adds = 0;
  for (const li of o.line_items || []) {
    if (String(li.status || '').toLowerCase() === 'canceled') continue;
    const q = Math.max(1, Number(li.quantity) || 1);
    const p = COST_ESTIMATE[li.product_id];
    const unit = (Number(li.cost) || 0) > 0 ? Number(li.cost) : (p && p.cost[li.variant_id]) || 0;
    if (!unit || !p) return { cents: null, estimated: true }; // unknown item: can't estimate honestly
    items += unit * q;
    firsts.push(p.first - p.add); // first item of an order pays (first - add) on top of add
    adds += p.add * q;
  }
  if (!firsts.length) return { cents: null, estimated: true };
  const ship = adds + Math.max(...firsts);
  return { cents: items + ship + Math.round(items * TAX_EST), estimated: true };
}

// Revenue from the CATALOG (fallback only) = price x qty + flat shipping.
export function catalogRevenue(o, catalog) {
  const byVariant = {};
  for (const row of Object.values(catalog || {})) for (const v of Object.values(row.sizes)) byVariant[v] = row.priceCents;
  let sum = 0;
  for (const li of o.line_items || []) {
    const p = byVariant[li.variant_id];
    if (!p) return null;
    sum += p * Math.max(1, Number(li.quantity) || 1);
  }
  return sum + SHIPPING_CENTS;
}

// From a PayPal GET /v2/checkout/orders/{id} body: gross, fee, refunded? (all cents). null if unusable.
export function paypalFacts(body) {
  if (!body || body.status !== 'COMPLETED') return null;
  const pu = (body.purchase_units || [])[0] || {};
  const caps = (pu.payments || {}).captures || [];
  if (!caps.length) return null;
  let gross = 0, fee = 0, feeKnown = true, refunded = false, partial = false;
  for (const c of caps) {
    const st = String(c.status || '').toUpperCase();
    if (!['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(st)) continue;
    if (st === 'REFUNDED') refunded = true;
    if (st === 'PARTIALLY_REFUNDED') partial = true;
    if (!c.amount || c.amount.currency_code !== 'USD') return null;
    const b = c.seller_receivable_breakdown || {};
    gross += cents((b.gross_amount && b.gross_amount.value) || c.amount.value);
    if (b.paypal_fee && b.paypal_fee.currency_code === 'USD') fee += cents(b.paypal_fee.value);
    else feeKnown = false;
  }
  if (!gross) return null;
  return { gross, fee: feeKnown ? fee : null, refunded, partial };
}

export const estimateFee = (grossCents) => Math.round(grossCents * FEE_PCT) + FEE_FIXED_CENTS;

// Validate pool-ledger.json. Throws on anything malformed (fail closed: no number beats a wrong one).
export function readLedger(raw) {
  const l = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!l || typeof l !== 'object' || !Array.isArray(l.refunds) || !Array.isArray(l.payouts)) throw new Error('ledger: refunds[] and payouts[] required');
  const reversed = new Set();
  for (const r of l.refunds) {
    if (!r || typeof r.orderId !== 'string' || !r.orderId.trim()) throw new Error('ledger: refund needs orderId');
    if (r.reverse !== false) reversed.add(r.orderId.trim().replace(/^dog-/i, '').toUpperCase());
  }
  let paid = 0;
  for (const p of l.payouts) {
    const a = Number(p && p.amount);
    if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) || !String(p.partner || '').trim() || !Number.isFinite(a) || a <= 0) {
      throw new Error('ledger: payout needs date YYYY-MM-DD, partner, amount > 0');
    }
    paid += cents(a);
  }
  return { reversed, paidOutCents: paid };
}

// Core: orders = Printify order objects; paypal = async (paypalOrderId) => PayPal order body | null.
export async function computePool({ orders, paypal, ledger, catalog, start = POOL_START, now = new Date() }) {
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) throw new Error('bad start date');
  const { reversed, paidOutCents } = readLedger(ledger);
  const counted = (orders || []).filter((o) => isCounted(o, startMs));
  const seen = new Set();
  let setAside = 0, n = 0, refundsReversed = 0, pending = false, feeEst = false, revenueEst = false, unpriced = 0;
  const facts = await Promise.all(counted.map(async (o) => {
    try { return paypalFacts(await paypal(websiteOrderId(o))); } catch (_) { return null; }
  }));
  counted.forEach((o, i) => {
    const id = websiteOrderId(o);
    if (seen.has(id)) return; // one Printify order per PayPal order (fulfill is idempotent); never double count
    seen.add(id);
    const pp = facts[i];
    const cost = printifyCost(o);
    let rev = pp ? pp.gross : catalogRevenue(o, catalog);
    if (!pp) revenueEst = true;
    if (rev == null || cost.cents == null) { unpriced++; pending = true; return; }
    let fee = pp && pp.fee != null ? pp.fee : estimateFee(rev);
    if (!pp || pp.fee == null) feeEst = true;
    if (cost.estimated) pending = true;
    const pool = Math.round(POOL_RATE * Math.max(rev - cost.cents - fee, 0));
    if (reversed.has(id) || (pp && pp.refunded)) { refundsReversed++; return; }
    setAside += pool;
    n++;
  });
  const out = {
    set_aside: dollars(setAside),
    paid_out: dollars(paidOutCents),
    held: dollars(setAside - paidOutCents),
    orders_counted: n,
    pending_estimates: pending,
    fee_estimates: feeEst || revenueEst,
    refunds_reversed: refundsReversed,
    currency: 'USD',
    as_of: now.toISOString(),
    start_date: start,
    basis: BASIS,
  };
  if (unpriced) out.orders_not_priced = unpriced;
  return out;
}
