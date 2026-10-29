// DoG customer order-confirmation email (sent via Resend after a successful Printify order).
// Underscore folder: Vercel does not expose files under api/_lib as functions.
//
// Env vars:
//   RESEND_API_KEY        (required to send) same key used for alerts
//   ORDER_EMAIL_FROM      (preferred) e.g. 'Dads of God <orders@dadsofgod.com>' on a Resend-verified domain
//   ALERT_EMAIL_FROM      (fallback sender if ORDER_EMAIL_FROM is unset)
//   ORDER_EMAIL_REPLY_TO  (optional) defaults to contact@dadsofgod.com
// If no sender is configured the email is skipped (onboarding@resend.dev cannot deliver to customers).

export const LOGO_URL = 'https://www.dadsofgod.com/logo.png';
export const CONTACT_EMAIL = 'contact@dadsofgod.com';
export const SHAWN_NOTE = 'Thank you for your purchase with purpose. The Kingdom can only come when children are free.';
export const SHAWN_SIGNOFF = '— Shawn, Dads of God';
export const DONATION_WORDING = "100% of donations, after PayPal's processing fee, go to our nonprofit partners. Not tax-deductible.";
// Wording from terms.html (main): "Each item is printed to order by our print partner, Printify, after you pay.
// Typical fulfillment is 5–12 business days before it ships."
export const FULFILLMENT_NOTE = 'Each item is printed to order by our print partner, Printify, after you pay. Typical fulfillment is 5–12 business days before it ships.';

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const money = (cents) => '$' + (Math.round(cents) / 100).toFixed(2);

// {{tokens}} are filled by renderOrderEmail(). Values marked RAW are pre-built, already-escaped HTML.
export const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>Your Dads of God order is confirmed</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
  body,table,td,a,p,div,span{font-family:Inter,'Helvetica Neue',Helvetica,Arial,sans-serif}
  @media (max-width:620px){.card{padding:24px 20px !important}.h1{font-size:30px !important}}
</style>
</head>
<body style="margin:0;padding:0;background:#09090b;color:#ffffff;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Thank you for your order. Here is your summary from Dads of God.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#09090b;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">

  <tr><td align="center" style="padding:8px 0 24px;">
    <img src="{{logo_url}}" width="150" alt="Dads of God logo" style="display:block;width:150px;max-width:150px;height:auto;border:0;margin:0 auto;">
    <div style="font-weight:900;font-size:32px;letter-spacing:-1px;color:#D4AF37;margin-top:12px;line-height:1;">DoG</div>
    <div style="font-size:10px;letter-spacing:4px;color:#a1a1aa;margin-top:4px;">DADS OF GOD</div>
  </td></tr>

  <tr><td class="card" style="background:#18181b;border:1px solid #27272a;border-radius:24px;padding:36px 36px;">
    <div style="text-transform:uppercase;letter-spacing:4px;color:#D4AF37;font-size:12px;font-weight:700;">Order confirmed</div>
    <h1 class="h1" style="margin:10px 0 12px;font-size:36px;line-height:1.05;font-weight:900;letter-spacing:-1px;color:#ffffff;">Thank you, {{first_name}}.</h1>
    <p style="margin:0 0 6px;font-size:16px;line-height:1.6;color:#d4d4d8;">We received your payment and sent your order to be printed.</p>
    <p style="margin:0 0 28px;font-size:13px;color:#a1a1aa;">PayPal order {{order_id}} &middot; {{order_date}}</p>

    <!-- Personal note from Shawn -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 28px;">
      <tr><td style="border-left:3px solid #D4AF37;background:#09090b;border-radius:0 16px 16px 0;padding:18px 20px;">
        <p style="margin:0 0 10px;font-size:17px;line-height:1.6;color:#ffffff;font-style:italic;">&ldquo;{{personal_note}}&rdquo;</p>
        <p style="margin:0;font-size:14px;font-weight:600;color:#D4AF37;">{{personal_signoff}}</p>
      </td></tr>
    </table>

    <div style="text-transform:uppercase;letter-spacing:3px;color:#a1a1aa;font-size:11px;font-weight:700;margin-bottom:8px;">Order summary</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;font-size:15px;">
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #27272a;color:#a1a1aa;font-size:12px;">Item</td>
        <td align="center" style="padding:8px 0;border-bottom:1px solid #27272a;color:#a1a1aa;font-size:12px;width:48px;">Qty</td>
        <td align="right" style="padding:8px 0;border-bottom:1px solid #27272a;color:#a1a1aa;font-size:12px;width:90px;">Price</td>
      </tr>
      {{item_rows}}
      <tr>
        <td colspan="2" style="padding:12px 0 4px;color:#d4d4d8;">Shipping (flat, US)</td>
        <td align="right" style="padding:12px 0 4px;color:#d4d4d8;">{{shipping}}</td>
      </tr>
      {{donation_row}}
      <tr>
        <td colspan="2" style="padding:12px 0 0;border-top:1px solid #27272a;font-weight:900;font-size:18px;color:#ffffff;">Total paid</td>
        <td align="right" style="padding:12px 0 0;border-top:1px solid #27272a;font-weight:900;font-size:18px;color:#D4AF37;">{{total}}</td>
      </tr>
    </table>
    {{donation_note}}

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;">
      <tr><td valign="top" style="padding:0;">
        <div style="text-transform:uppercase;letter-spacing:3px;color:#a1a1aa;font-size:11px;font-weight:700;margin-bottom:8px;">Shipping to</div>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#ffffff;">{{address_html}}</p>
      </td></tr>
    </table>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;">
      <tr><td style="background:#27272a;border-radius:16px;padding:16px 18px;">
        <div style="font-weight:700;font-size:14px;color:#D4AF37;margin-bottom:4px;">What happens next</div>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#d4d4d8;">{{fulfillment_note}}</p>
      </td></tr>
    </table>

    <p style="margin:28px 0 0;font-size:14px;line-height:1.6;color:#d4d4d8;">Questions about your order? Email us at <a href="mailto:{{contact_email}}" style="color:#D4AF37;text-decoration:underline;">{{contact_email}}</a> and include your PayPal order number.</p>
  </td></tr>

  <tr><td align="center" style="padding:24px 8px 8px;font-size:12px;line-height:1.6;color:#71717a;">
    &copy; 2026 <span style="color:#D4AF37;">DoG</span> &mdash; Dads of God.<br>
    <a href="https://www.dadsofgod.com/shipping.html" style="color:#a1a1aa;">Shipping</a> &middot;
    <a href="https://www.dadsofgod.com/returns.html" style="color:#a1a1aa;">Returns</a> &middot;
    <a href="https://www.dadsofgod.com/terms.html" style="color:#a1a1aa;">Terms</a> &middot;
    <a href="https://www.dadsofgod.com/privacy.html" style="color:#a1a1aa;">Privacy</a>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
`;

// data: { orderId, date (Date), firstName, lines:[{name,size,quantity,priceCents}], shippingCents,
//         donationCents (optional, 0 for merch orders), totalCents, address:{first_name,last_name,address1,address2,city,region,zip} }
export function renderOrderEmail(data) {
  const lines = data.lines || [];
  const itemRows = lines.map((l) => `<tr>
        <td style="padding:12px 0;border-bottom:1px solid #27272a;color:#ffffff;"><span style="font-weight:700;">${esc(l.name)}</span><br><span style="font-size:13px;color:#a1a1aa;">Size: ${esc(l.size)} &middot; Black</span></td>
        <td align="center" style="padding:12px 0;border-bottom:1px solid #27272a;color:#ffffff;">${esc(l.quantity)}</td>
        <td align="right" style="padding:12px 0;border-bottom:1px solid #27272a;color:#ffffff;">${money(l.priceCents * l.quantity)}</td>
      </tr>`).join('\n      ');
  const don = Number(data.donationCents) || 0;
  const donationRow = don > 0 ? `<tr>
        <td colspan="2" style="padding:4px 0;color:#d4d4d8;">Donation to the partner pool</td>
        <td align="right" style="padding:4px 0;color:#d4d4d8;">${money(don)}</td>
      </tr>` : '';
  const donationNote = don > 0 ? `<p style="margin:10px 0 0;font-size:12px;line-height:1.5;color:#a1a1aa;">${esc(DONATION_WORDING)}</p>` : '';
  const a = data.address || {};
  const addressHtml = [
    [a.first_name, a.last_name].filter(Boolean).join(' '),
    a.address1, a.address2,
    [a.city, [a.region, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    'United States',
  ].filter(Boolean).map(esc).join('<br>');
  const d = data.date instanceof Date ? data.date : new Date();
  const dateStr = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
  const vals = {
    logo_url: esc(LOGO_URL),
    first_name: esc(data.firstName || 'friend'),
    order_id: esc(data.orderId),
    order_date: esc(dateStr),
    personal_note: esc(SHAWN_NOTE),
    personal_signoff: esc(SHAWN_SIGNOFF),
    item_rows: itemRows, // RAW
    shipping: money(data.shippingCents),
    donation_row: donationRow, // RAW
    donation_note: donationNote, // RAW
    total: money(data.totalCents),
    address_html: addressHtml, // RAW (escaped parts)
    fulfillment_note: esc(FULFILLMENT_NOTE),
    contact_email: esc(CONTACT_EMAIL),
  };
  const html = TEMPLATE.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vals ? vals[k] : m));
  const text = [
    `Thank you, ${data.firstName || 'friend'}.`,
    'We received your payment and sent your order to be printed.',
    `PayPal order ${data.orderId} - ${dateStr}`,
    '',
    `"${SHAWN_NOTE}"`,
    SHAWN_SIGNOFF,
    '',
    'ORDER SUMMARY',
    ...lines.map((l) => `- ${l.name} (Size: ${l.size}) x${l.quantity}  ${money(l.priceCents * l.quantity)}`),
    `Shipping (flat, US): ${money(data.shippingCents)}`,
    ...(don > 0 ? [`Donation to the partner pool: ${money(don)}`, DONATION_WORDING] : []),
    `Total paid: ${money(data.totalCents)}`,
    '',
    'SHIPPING TO',
    addressHtml.split('<br>').map((s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")).join('\n'),
    '',
    FULFILLMENT_NOTE,
    '',
    `Questions? Email ${CONTACT_EMAIL} and include your PayPal order number.`,
    '',
    '(c) 2026 DoG - Dads of God. https://www.dadsofgod.com',
  ].join('\n');
  return { subject: 'Your Dads of God order is confirmed (' + String(data.orderId) + ')', html, text };
}

// Never throws. Returns { sent: boolean, id?, skipped?, status?, error? }.
export async function sendOrderConfirmation(to, data, { log = () => {}, timeoutMs = 5000 } = {}) {
  try {
    const key = String(process.env.RESEND_API_KEY || '').trim();
    const from = process.env.ORDER_EMAIL_FROM || process.env.ALERT_EMAIL_FROM || '';
    const replyTo = process.env.ORDER_EMAIL_REPLY_TO || CONTACT_EMAIL;
    const email = String(to || '').trim();
    const why = !key ? 'no RESEND_API_KEY' : !from ? 'no ORDER_EMAIL_FROM/ALERT_EMAIL_FROM' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'no valid payer email' : '';
    if (why) {
      log('warn', 'order confirmation skipped', { paypalOrderId: data && data.orderId, reason: why });
      return { sent: false, skipped: why };
    }
    const { subject, html, text } = renderOrderEmail(data);
    // AbortSignal.timeout() uses an unref'd timer on Node 22, so a hung Resend call never
    // aborts and the await never settles. A referenced timer keeps the 5 s limit real.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeoutMs);
    let r;
    try {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'dog-order-confirm-' + String(data.orderId), // a retried request never emails twice
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
      log('error', 'order confirmation failed', { paypalOrderId: data.orderId, status: r.status, name: rb && rb.name, message: rb && String(rb.message || '').slice(0, 300) });
      return { sent: false, status: r.status };
    }
    log('info', 'order confirmation sent', { paypalOrderId: data.orderId, resendId: rb && rb.id });
    return { sent: true, id: rb && rb.id };
  } catch (e) {
    try { log('error', 'order confirmation failed', { paypalOrderId: data && data.orderId, err: String(e && e.message) }); } catch (_) { /* ignore */ }
    return { sent: false, error: String(e && e.message) };
  }
}
