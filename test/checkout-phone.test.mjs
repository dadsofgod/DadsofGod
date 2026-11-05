// node --test test/   Static checks on index.html: the phone field is required, and the browser
// blocks PayPal (onClick + createOrder) before payment when the phone is invalid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('phone input is required, type=tel, autocomplete=tel, not marked optional', () => {
  const m = html.match(/<input id="ship-phone"[^>]*>/);
  assert.ok(m, 'ship-phone input exists');
  const tag = m[0];
  for (const attr of [' required', 'type="tel"', 'autocomplete="tel"', 'minlength="10"', 'pattern="']) assert.ok(tag.includes(attr), 'has ' + attr);
  assert.ok(!/optional/i.test(tag), 'not labeled optional');
  const pat = new RegExp('^(?:' + tag.match(/pattern="([^"]*)"/)[1] + ')$', 'v');
  assert.ok(pat.test('(512) 555-0123')); assert.ok(pat.test('5125550123'));
  assert.ok(!pat.test('555-0123')); assert.ok(!pat.test(''));
});

test('phoneOk(): 10-15 digits after stripping non-digits', () => {
  const src = html.match(/function phoneOk\(p\)\{[^\n]*\}/)[0];
  const phoneOk = new Function(src + '; return phoneOk;')();
  for (const ok of ['5125550123', '(512) 555-0123', '+1 512-555-0123', '123456789012345']) assert.equal(phoneOk(ok), true, ok);
  for (const bad of ['', '   ', undefined, null, '555-0123', '512555012', 'abc', '1234567890123456']) assert.equal(phoneOk(bad), false, String(bad));
});

test('shipValid() checks the phone, and PayPal onClick + createOrder call shipValid() before creating the order', () => {
  const sv = html.match(/function shipValid\(\)\{[^\n]*\}/)[0];
  assert.match(sv, /if\(!phoneOk\(s\.phone\)\)return shipError\(/);
  assert.match(html, /onClick:function\(d,a\)\{return shipValid\(\)\?a\.resolve\(\):a\.reject\(\)\}/);
  const co = html.match(/createOrder:function\(d,a\)\{([\s\S]*?)a\.order\.create/)[1];
  assert.match(co, /^if\(!shipValid\(\)\)return a\.reject\(\);/);
});

test('continue shopping closes the cart and goes to #shop without clearing dogCart', () => {
  const btn = html.match(/<button type="button" id="continue-shopping"[^>]*>Continue shopping<\/button>/);
  assert.ok(btn, 'continue shopping button exists');
  assert.match(btn[0], /border-\[#FDD10C\]/);
  assert.ok(!/gold-bg/.test(btn[0]), 'secondary, not the solid PayPal-style fill');
  const fn = html.slice(html.indexOf('function continueShopping()'), html.indexOf('function showOrderResult'));
  assert.match(fn, /hideCart\(\)/);
  assert.match(fn, /getElementById\('shop'\)/);
  assert.match(fn, /scrollIntoView\(\{behavior:'smooth',block:'start'\}\)/);
  assert.match(fn, /location\.href='\/#shop'/);
  assert.ok(!fn.includes('saveCart'));
  assert.match(html, /if\(keep\)keep\.classList\.toggle\('hidden',!cart\.length\)/);
});

test('successful fulfill closes the cart, confirms the order, then returns home', () => {
  assert.match(html, /function showOrderConfirmed\(orderId,email\)/);
  assert.match(html, /cart=\[\];saveCart\(\);hideCart\(\)/);
  assert.match(html, /Thank you! Your order is confirmed\./);
  assert.match(html, /A confirmation email is on its way to/);
  assert.match(html, /Back to home/);
  assert.match(html, /setTimeout\(goHome,5000\)/);
  assert.match(html, /location\.href='\/'/);
  assert.match(html, /sendToFulfill\(payload\)\.then\(function\(\)\{showOrderConfirmed\(orderId,getShip\(\)\.email\)\}/);
  assert.match(html, /Payment received; we\\'re confirming your order, we\\'ll email you\./);
});

test('privacy and shipping pages describe phone as required, shipping/delivery only', () => {
  const privacy = readFileSync(new URL('../privacy.html', import.meta.url), 'utf8');
  const shipping = readFileSync(new URL('../shipping.html', import.meta.url), 'utf8');
  assert.ok(!/phone \(if you give one\)/.test(privacy)); assert.match(privacy, /used only for shipping and delivery/);
  assert.ok(!/optional phone/.test(shipping)); assert.match(shipping, /used only for shipping and delivery/);
});
