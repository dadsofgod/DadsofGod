// DoG PayPal webhook (Vercel serverless function).
//
// Backup for a shopper who pays and never reaches POST /api/fulfill (closed tab, dropped network).
// PayPal POSTs PAYMENT.CAPTURE.COMPLETED here. We verify the signature, skip donations, then run
// the same fulfillPaidOrder path as the browser (duplicate-safe, 24h capture limit).
//
// The customer confirmation uses the existing Resend Idempotency-Key per PayPal order id, and a
// duplicate hit does not send another email.
//
// This route is not rate-limited: PayPal must be able to reach it.
//
// Env:
//   PAYPAL_WEBHOOK_ID     PayPal webhook id from the live app. When unset, log and return 200
//                          without verifying or fulfilling, so this can deploy before the webhook exists.
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV — same as api/fulfill.js
//   PRINTIFY_TOKEN and the alert/email vars — same as api/fulfill.js

import { isDonationOrder } from './donation-thanks.js';
import {
  addressFromPaypalOrder,
  fulfillPaidOrder,
  isPaypalOrderId,
  itemsFromPaypalOrder,
  paypalAuthedFetch,
} from './fulfill.js';

const log = (level, msg, extra) => console[level](JSON.stringify({ svc: 'dog-paypal-webhook', msg, ...extra }));

function header(req, name) {
  const h = (req && req.headers) || {};
  const v = h[name] != null ? h[name] : h[name.toLowerCase()];
  if (Array.isArray(v)) return String(v[0] || '');
  return v == null ? '' : String(v);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!req || req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const webhookId = String(process.env.PAYPAL_WEBHOOK_ID || '').trim();
  if (!webhookId) {
    log('warn', 'paypal webhook ignored; PAYPAL_WEBHOOK_ID unset');
    return res.status(200).json({ ok: true });
  }

  let event = req.body;
  if (typeof event === 'string') { try { event = JSON.parse(event); } catch (_) { event = null; } }
  if (!event || typeof event !== 'object') return res.status(400).json({ ok: false, error: 'Invalid webhook signature' });

  const auth_algo = header(req, 'paypal-auth-algo');
  const cert_url = header(req, 'paypal-cert-url');
  const transmission_id = header(req, 'paypal-transmission-id');
  const transmission_sig = header(req, 'paypal-transmission-sig');
  const transmission_time = header(req, 'paypal-transmission-time');
  if (!auth_algo || !cert_url || !transmission_id || !transmission_sig || !transmission_time) {
    log('warn', 'paypal webhook signature rejected', { reason: 'missing signature headers' });
    return res.status(400).json({ ok: false, error: 'Invalid webhook signature' });
  }

  let verified;
  try {
    verified = await paypalAuthedFetch('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: {
        auth_algo,
        cert_url,
        transmission_id,
        transmission_sig,
        transmission_time,
        webhook_id: webhookId,
        webhook_event: event,
      },
    });
  } catch (e) {
    log('error', 'paypal webhook verify failed', { err: String(e && e.message || e) });
    return res.status(503).json({ ok: false, error: 'Order service unavailable' });
  }
  const statusName = verified.body && verified.body.verification_status;
  if (!verified.ok || statusName !== 'SUCCESS') {
    const retry = verified.status === 429 || verified.status >= 500;
    log('warn', 'paypal webhook signature rejected', { status: verified.status, verification_status: statusName || '' });
    return res.status(retry ? 503 : 400).json({ ok: false, error: retry ? 'Order service unavailable' : 'Invalid webhook signature' });
  }

  if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
    log('info', 'paypal webhook ignored', { event_type: String(event.event_type || '') });
    return res.status(200).json({ ok: true });
  }

  const resource = event.resource || {};
  const related = (resource.supplementary_data && resource.supplementary_data.related_ids) || {};
  const paypalOrderId = String(related.order_id || '').trim();
  if (!isPaypalOrderId(paypalOrderId)) {
    log('warn', 'paypal webhook missing order id', {});
    return res.status(200).json({ ok: true });
  }

  let got;
  try {
    got = await paypalAuthedFetch('/v2/checkout/orders/' + encodeURIComponent(paypalOrderId));
  } catch (e) {
    log('error', 'paypal webhook order fetch failed', { paypalOrderId, err: String(e && e.message || e) });
    return res.status(503).json({ ok: false, error: 'Order service unavailable' });
  }
  if (got.status === 429 || got.status >= 500) {
    log('warn', 'paypal webhook order fetch failed', { paypalOrderId, status: got.status });
    return res.status(503).json({ ok: false, error: 'Order service unavailable' });
  }
  if (!got.ok || !got.body) {
    log('warn', 'paypal webhook order fetch failed', { paypalOrderId, status: got.status });
    return res.status(400).json({ ok: false, error: 'Invalid order' });
  }
  if (isDonationOrder(got.body)) {
    log('info', 'paypal webhook donation skipped', { paypalOrderId });
    return res.status(200).json({ ok: true });
  }

  return fulfillPaidOrder({
    paypalOrderId,
    items: itemsFromPaypalOrder(got.body),
    address: addressFromPaypalOrder(got.body),
  }, res, 'webhook');
}
