/**
 * Vercel serverless: verify PayPal capture, then create a Printify order.
 * Env: PRINTIFY_TOKEN, PRINTIFY_SHOP_ID, PAYPAL_CLIENT_ID, PAYPAL_SECRET
 * Map line items by Printify SKU, not Pop-Up page IDs.
 */
const PAYPAL_BASE = 'https://api-m.paypal.com';

async function paypalToken() {
  const auth = Buffer.from(process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_SECRET).toString('base64');
  const res = await fetch(PAYPAL_BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('PayPal auth failed');
  return data.access_token;
}

async function paypalOrder(id, token) {
  const res = await fetch(PAYPAL_BASE + '/v2/checkout/orders/' + id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.dadsofgod.com');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { paypalOrderId, items, address } = req.body || {};
    if (!paypalOrderId || !Array.isArray(items) || !items.length || !address) {
      return res.status(400).json({ error: 'paypalOrderId, items, address required' });
    }

    const ptok = await paypalToken();
    const order = await paypalOrder(paypalOrderId, ptok);
    const status = order.status || '';
    if (status !== 'COMPLETED' && status !== 'APPROVED') {
      return res.status(402).json({ error: 'PayPal order not paid', status });
    }

    const name = String(address.name || '').trim();
    const [first_name, ...rest] = name.split(' ');
    const last_name = rest.join(' ') || 'Customer';

    const body = {
      external_id: 'dog-' + paypalOrderId,
      label: 'DoG ' + paypalOrderId.slice(-8),
      line_items: items.map((i) => ({
        sku: String(i.sku),
        quantity: Number(i.quantity || 1),
      })),
      shipping_method: 1,
      send_shipping_notification: true,
      address_to: {
        first_name: first_name || 'DoG',
        last_name,
        email: address.email,
        phone: address.phone || '0000000000',
        country: address.country === 'United States' ? 'US' : (address.country || 'US'),
        region: address.state || '',
        address1: address.address,
        address2: '',
        city: address.city,
        zip: address.zip,
      },
    };

    const printify = await fetch(
      'https://api.printify.com/v1/shops/' + process.env.PRINTIFY_SHOP_ID + '/orders.json',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.PRINTIFY_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
    const created = await printify.json();
    if (!printify.ok) return res.status(502).json({ error: 'Printify rejected order', created });

    const send = await fetch(
      'https://api.printify.com/v1/shops/' +
        process.env.PRINTIFY_SHOP_ID +
        '/orders/' +
        created.id +
        '/send_to_production.json',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.PRINTIFY_TOKEN },
      }
    );

    return res.status(200).json({ ok: true, printifyId: created.id, production: send.status });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
