const SHOP = process.env.PRINTIFY_SHOP_ID || '27166805';
const MAP = {
  'DOG-TEE': { product: '69dc4507f6f60e22c60dec14', sizes: { S:12126, M:12125, L:12124, XL:12127, '2XL':12128 } },
  'DOG-LS': { product: '69dc53923ff9b45b4504917c', sizes: { S:33796, M:33797, L:33798, XL:33799, '2XL':33800 } },
  'DOG-HOOD': { product: '69dc553ba6714c1fd5037169', sizes: { S:109373, M:109396, L:109419, XL:109442, '2XL':109465 } },
  'DOG-CAP': { product: '69f6f9549eacb75844020e88', sizes: { 'S/M':118238, 'L/XL':118238, S:118238, M:118238, L:118238, XL:118238 } },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.dadsofgod.com');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'dog-fulfill' });
  try {
    const token = process.env.PRINTIFY_TOKEN;
    if (!token) return res.status(501).json({ error: 'PRINTIFY_TOKEN missing on host' });
    const { items, address, paypalOrderId } = req.body || {};
    if (!items || !address) return res.status(400).json({ error: 'items and address required' });
    const line_items = [];
    for (const i of items) {
      const row = MAP[i.sku];
      if (!row) return res.status(400).json({ error: 'unknown sku ' + i.sku });
      const variant_id = row.sizes[i.size] || row.sizes.M || row.sizes['S/M'];
      if (!variant_id) return res.status(400).json({ error: 'bad size ' + i.size });
      line_items.push({ product_id: row.product, variant_id, quantity: Number(i.quantity || 1) });
    }
    const name = String(address.name || 'DoG Customer').trim();
    const [first_name, ...rest] = name.split(' ');
    const body = {
      external_id: 'dog-' + (paypalOrderId || Date.now()),
      label: 'DoG web order',
      line_items,
      shipping_method: 1,
      send_shipping_notification: true,
      address_to: {
        first_name: first_name || 'DoG',
        last_name: rest.join(' ') || 'Customer',
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
    const createdRes = await fetch('https://api.printify.com/v1/shops/' + SHOP + '/orders.json', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'DoG-fulfill' },
      body: JSON.stringify(body),
    });
    const created = await createdRes.json();
    if (!createdRes.ok) return res.status(502).json({ error: 'Printify create failed', created });
    await fetch('https://api.printify.com/v1/shops/' + SHOP + '/orders/' + created.id + '/send_to_production.json', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'DoG-fulfill' },
    });
    return res.status(200).json({ ok: true, printifyId: created.id });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
