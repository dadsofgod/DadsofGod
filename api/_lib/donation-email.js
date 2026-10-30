// DoG donation thank-you email (sent via Resend after a verified, COMPLETED donation capture).
// Underscore folder: Vercel does not expose files under api/_lib as functions.
// Same look as api/_lib/order-email.js (lemon #FDD10C on dark zinc) and the same env vars:
//   RESEND_API_KEY, ORDER_EMAIL_FROM (fallback ALERT_EMAIL_FROM), ORDER_EMAIL_REPLY_TO (default contact@dadsofgod.com).
// DoG is a for-profit company: no tax-receipt language, no impact or rescue claims.

import { LOGO_URL, CONTACT_EMAIL, SHAWN_SIGNOFF, DONATION_WORDING } from './order-email.js';

// Shawn's note adapted for donations; his second sentence is kept word for word.
export const DONATION_NOTE = 'Thank you for giving with purpose. The Kingdom can only come when children are free.';

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const money = (cents) => '$' + (Math.round(cents) / 100).toFixed(2);

export const DONATION_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>Thank you for your donation</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
  body,table,td,a,p,div,span{font-family:Inter,'Helvetica Neue',Helvetica,Arial,sans-serif}
  @media (max-width:620px){.card{padding:24px 20px !important}.h1{font-size:30px !important}}
</style>
</head>
<body style="margin:0;padding:0;background:#09090b;color:#ffffff;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Thank you for your donation to the Dads of God donation pool.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#09090b;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">

  <tr><td align="center" style="padding:8px 0 24px;">
    <img src="{{logo_url}}" width="150" alt="Dads of God logo" style="display:block;width:150px;max-width:150px;height:auto;border:0;margin:0 auto;">
    <div style="font-weight:900;font-size:32px;letter-spacing:-1px;color:#FDD10C;margin-top:12px;line-height:1;">DoG</div>
    <div style="font-size:10px;letter-spacing:4px;color:#a1a1aa;margin-top:4px;">DADS OF GOD</div>
  </td></tr>

  <tr><td class="card" style="background:#18181b;border:1px solid #27272a;border-radius:24px;padding:36px 36px;">
    <div style="text-transform:uppercase;letter-spacing:4px;color:#FDD10C;font-size:12px;font-weight:700;">Donation received</div>
    <h1 class="h1" style="margin:10px 0 12px;font-size:36px;line-height:1.05;font-weight:900;letter-spacing:-1px;color:#ffffff;">Thank you for your donation, {{first_name}}.</h1>
    <p style="margin:0 0 28px;font-size:13px;color:#a1a1aa;">{{donation_date}}</p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 28px;">
      <tr><td align="center" style="background:#09090b;border:1px solid #27272a;border-radius:16px;padding:22px 20px;">
        <div style="text-transform:uppercase;letter-spacing:3px;color:#a1a1aa;font-size:11px;font-weight:700;margin-bottom:6px;">Amount donated</div>
        <div style="font-weight:900;font-size:40px;letter-spacing:-1px;line-height:1.1;color:#FDD10C;">{{amount}}</div>
        <div style="font-size:13px;color:#a1a1aa;margin-top:6px;">DoG donation pool</div>
      </td></tr>
    </table>

    <!-- Personal note from Shawn -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 28px;">
      <tr><td style="border-left:3px solid #FDD10C;background:#09090b;border-radius:0 16px 16px 0;padding:18px 20px;">
        <p style="margin:0 0 10px;font-size:17px;line-height:1.6;color:#ffffff;font-style:italic;">&ldquo;{{personal_note}}&rdquo;</p>
        <p style="margin:0;font-size:14px;font-weight:600;color:#FDD10C;">{{personal_signoff}}</p>
      </td></tr>
    </table>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 4px;">
      <tr><td style="background:#27272a;border-radius:16px;padding:16px 18px;">
        <div style="font-weight:700;font-size:14px;color:#FDD10C;margin-bottom:4px;">Where your donation goes</div>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#d4d4d8;">{{donation_wording}}</p>
      </td></tr>
    </table>

    <div style="text-transform:uppercase;letter-spacing:3px;color:#a1a1aa;font-size:11px;font-weight:700;margin:28px 0 8px;">PayPal reference</div>
    <p style="margin:0;font-size:14px;line-height:1.7;color:#d4d4d8;">{{reference_html}}</p>

    <p style="margin:28px 0 0;font-size:14px;line-height:1.6;color:#d4d4d8;">Questions about your donation? Email us at <a href="mailto:{{contact_email}}" style="color:#FDD10C;text-decoration:underline;">{{contact_email}}</a> and include your PayPal transaction ID.</p>
  </td></tr>

  <tr><td align="center" style="padding:24px 8px 8px;font-size:12px;line-height:1.6;color:#71717a;">
    &copy; 2026 <span style="color:#FDD10C;">DoG</span> &mdash; Dads of God. Dads of God is a for-profit company.<br>
    <a href="https://www.dadsofgod.com/" style="color:#a1a1aa;">dadsofgod.com</a> &middot;
    <a href="https://www.dadsofgod.com/terms.html" style="color:#a1a1aa;">Terms</a> &middot;
    <a href="https://www.dadsofgod.com/privacy.html" style="color:#a1a1aa;">Privacy</a>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
`;

// data: { orderId, captureId, date (Date), firstName, amountCents }
export function renderDonationEmail(data) {
  const d = data.date instanceof Date && !isNaN(data.date) ? data.date : new Date();
  const dateStr = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
  const refs = [];
  if (data.captureId) refs.push(['Transaction ID', data.captureId]);
  refs.push(['Order ID', data.orderId]);
  const vals = {
    logo_url: esc(LOGO_URL),
    first_name: esc(data.firstName || 'friend'),
    donation_date: esc(dateStr),
    amount: money(data.amountCents),
    personal_note: esc(DONATION_NOTE),
    personal_signoff: esc(SHAWN_SIGNOFF),
    donation_wording: esc(DONATION_WORDING),
    reference_html: refs.map(([k, v]) => esc(k) + ': <span style="color:#ffffff;font-family:Menlo,Consolas,monospace;">' + esc(v) + '</span>').join('<br>'), // RAW (escaped parts)
    contact_email: esc(CONTACT_EMAIL),
  };
  const html = DONATION_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vals ? vals[k] : m));
  const text = [
    `Thank you for your donation, ${data.firstName || 'friend'}.`,
    dateStr,
    '',
    `Amount donated: ${money(data.amountCents)} (DoG donation pool)`,
    '',
    `"${DONATION_NOTE}"`,
    SHAWN_SIGNOFF,
    '',
    DONATION_WORDING,
    '',
    'PAYPAL REFERENCE',
    ...refs.map(([k, v]) => `${k}: ${v}`),
    '',
    `Questions? Email ${CONTACT_EMAIL} and include your PayPal transaction ID.`,
    '',
    '(c) 2026 DoG - Dads of God. Dads of God is a for-profit company. https://www.dadsofgod.com',
  ].join('\n');
  return { subject: 'Thank you for your donation – Dads of God', html, text };
}

// Never throws. Returns { sent: boolean, id?, skipped?, status?, error? }.
export async function sendDonationThanks(to, data, { log = () => {}, timeoutMs = 5000 } = {}) {
  try {
    const key = String(process.env.RESEND_API_KEY || '').trim();
    const from = process.env.ORDER_EMAIL_FROM || process.env.ALERT_EMAIL_FROM || '';
    const replyTo = process.env.ORDER_EMAIL_REPLY_TO || CONTACT_EMAIL;
    const email = String(to || '').trim();
    const why = !key ? 'no RESEND_API_KEY' : !from ? 'no ORDER_EMAIL_FROM/ALERT_EMAIL_FROM' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'no valid payer email' : '';
    if (why) {
      log('warn', 'donation thanks skipped', { paypalOrderId: data && data.orderId, reason: why });
      return { sent: false, skipped: why };
    }
    const { subject, html, text } = renderDonationEmail(data);
    // Referenced timer (AbortSignal.timeout is unref'd on Node 22 and may never fire).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeoutMs);
    let r;
    try {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'dog-donation-thanks-' + String(data.orderId), // a repeated call never emails twice (24 h)
        },
        body: JSON.stringify({ from, to: [email], reply_to: replyTo, subject, html, text }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    let rb = null;
    try { rb = await r.json(); } catch (_) { rb = null; }
    if (!r.ok) {
      log('error', 'donation thanks failed', { paypalOrderId: data.orderId, status: r.status, name: rb && rb.name, message: rb && String(rb.message || '').slice(0, 300) });
      return { sent: false, status: r.status };
    }
    log('info', 'donation thanks sent', { paypalOrderId: data.orderId, resendId: rb && rb.id });
    return { sent: true, id: rb && rb.id };
  } catch (e) {
    try { log('error', 'donation thanks failed', { paypalOrderId: data && data.orderId, err: String(e && e.message) }); } catch (_) { /* ignore */ }
    return { sent: false, error: String(e && e.message) };
  }
}
