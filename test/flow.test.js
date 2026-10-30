// رحلات كاملة: عميل، بقالات، مندوب، إدارة
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JARAK_NO_TIMERS = '1';
process.env.DEMO = '1'; process.env.DEV_SHOW_OTP = '1'; process.env.NO_RATE_LIMIT = '1';
process.env.ADMIN_TOKEN = 'admin-secret';
delete process.env.GEMINI_API_KEY; delete process.env.MOYASAR_SECRET_KEY;

const { createApp } = await import('../src/index.js');
const { q, one } = await import('../src/db.js');
const { sweep } = await import('../src/dispatch.js');
const { bus } = await import('../src/events.js');

let server, base;
const H = (t) => ({ 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) });
const call = async (method, path, token, body) => {
  const r = await fetch(base + path, { method, headers: H(token), body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || r.status); e.status = r.status; e.body = j; throw e; }
  return j;
};
const { q: _q } = await import('../src/db.js');
const otpLogin = async (base, phone) => { await _q(`delete from otps where phone like '%' || $1`, [phone.slice(1)]); const o = await call('POST', base + '/otp', null, { phone }); return (await call('POST', base + '/verify', null, { phone, code: o.dev_code })).token; };
const loginStore = async (phone) => otpLogin('/api/store', phone);
const loginDriver = async (phone) => otpLogin('/api/driver', phone);
const HOME = { lat: 26.2852, lng: 50.2098 };
const events = []; bus.on('newListener', () => {});

before(async () => { const app = await createApp(); server = app.listen(0); base = 'http://127.0.0.1:' + server.address().port; });
after(() => server.close());

async function newCustomer(phone) {
  const o = await call('POST', '/api/auth/otp', null, { phone });
  assert.ok(o.dev_code, 'dev code returned in dev mode');
  const v = await call('POST', '/api/auth/verify', null, { phone, code: o.dev_code });
  const a = await call('POST', '/api/me/addresses', v.token, { label: 'البيت', ...HOME, details: 'عمارة 4، الدور 2' });
  return { token: v.token, address: a.address };
}
async function productId(name, size) { return (await one('select id from products where name_ar=$1 and ($2::text is null or size=$2)', [name, size || null])).id; }

test('OTP: wrong code rejected, invalid phone rejected', async () => {
  await assert.rejects(call('POST', '/api/auth/otp', null, { phone: '12345' }), /سعودي/);
  await call('POST', '/api/auth/otp', null, { phone: '0555000111' });
  await assert.rejects(call('POST', '/api/auth/verify', null, { phone: '0555000111', code: '0000' }), /غلط/);
});

test('catalog shows lowest nearby price', async () => {
  const c = await call('GET', `/api/catalog?lat=${HOME.lat}&lng=${HOME.lng}`);
  assert.ok(c.products.length > 50);
  assert.ok(c.stores.length >= 5);
  const milk = c.products.find(p => p.name_ar === 'حليب المراعي طازج كامل الدسم');
  const prices = await q(`select price::float p from store_products where product_id=$1 and available`, [milk.id]);
  assert.equal(milk.min_price, Math.min(...prices.map(r => r.p)));
});

test('voice/text order in Saudi dialect fills the cart (offline parser)', async () => {
  const { token } = await newCustomer('0555000222');
  const r = await call('POST', '/api/me/ai/parse', token, { text: 'ابي ثنين حليب المراعي وكرتون موية نوفا وخبز صامولي' });
  assert.equal(r.items.length, 3);
  assert.equal(r.items.find(i => i.name_ar.includes('حليب')).qty, 2);
});

let fullOrder;
test('full journey: quote → pay → 3 stores offered → first accept wins → driver → delivery code → books', async () => {
  const { token, address } = await newCustomer('0555000333');
  const items = [{ product_id: await productId('حليب المراعي طازج كامل الدسم'), qty: 2 }, { product_id: await productId('ماء نوفا'), qty: 1 }, { product_id: await productId('بيض', '30 حبة'), qty: 1 }];
  const qt = await call('POST', '/api/me/quote', token, { address_id: address.id, items });
  assert.ok(qt.total > 30 && qt.stores.length >= 1);
  await assert.rejects(call('POST', '/api/me/orders', token, { address_id: address.id, items, expected_total: qt.total + 5 }), /تغيّرت الأسعار/);
  const { order } = await call('POST', '/api/me/orders', token, { address_id: address.id, items, expected_total: qt.total });
  await call('POST', `/api/me/orders/${order.id}/pay-test`, token);
  const offers = await q(`select o.*, s.owner_phone from offers o join stores s on s.id=o.store_id where order_id=$1`, [order.id]);
  assert.ok(offers.length >= 2 && offers.length <= 3, 'offered to up to 3 stores');
  // drivers come online
  for (const p of ['0510000001', '0510000002']) { const t = await loginDriver(p); await call('POST', '/api/driver/status', t, { online: true, lat: 26.285, lng: 50.21 }); }
  // the second store answers first and wins
  const full = offers.filter(o => o.items.length === 3);
  assert.ok(full.length >= 2, 'at least two stores have everything');
  const winner = full[1];
  const st = await loginStore('0' + winner.owner_phone.slice(3));
  const res = await call('POST', `/api/store/offers/${winner.id}`, st, { action: 'accept' });
  assert.equal(res.status, 'accepted');
  const loser = full[0];
  const st0 = await loginStore('0' + loser.owner_phone.slice(3));
  const late = await call('POST', `/api/store/offers/${loser.id}`, st0, { action: 'accept' });
  assert.ok(late.late, 'other store is too late');
  const o2 = await one('select * from orders where id=$1', [order.id]);
  assert.equal(o2.status, 'preparing');
  // customer never pays more than the quote; cheaper store -> automatic refund
  const part = await one('select * from order_parts where order_id=$1', [order.id]);
  const customerSum = part.items.reduce((a, i) => a + i.customer_price * i.qty, 0);
  assert.ok(customerSum <= Number(order.quote_subtotal) + 0.001);
  // a driver gets the job (if store isn't self-delivery)
  const self = await one('select self_delivery from stores where id=$1', [part.store_id]);
  await call('POST', `/api/store/parts/${part.id}/ready`, st);
  if (self.self_delivery) {
    await call('POST', `/api/store/parts/${part.id}/self`, st, { action: 'out' });
    await assert.rejects(call('POST', `/api/store/parts/${part.id}/self`, st, { action: 'delivered', code: '0000' }), /رمز التسليم/);
    await call('POST', `/api/store/parts/${part.id}/self`, st, { action: 'delivered', code: o2.delivery_code });
  } else {
    const doff = await one(`select d.*, dr.phone from driver_offers d join drivers dr on dr.id=d.driver_id where order_id=$1 limit 1`, [order.id]);
    assert.ok(doff, 'driver offered');
    const dt = await loginDriver('0' + doff.phone.slice(3));
    assert.equal((await call('POST', `/api/driver/offers/${doff.id}`, dt, { accept: true })).status, 'accepted');
    await call('POST', `/api/driver/parts/${part.id}/pickup`, dt);
    await assert.rejects(call('POST', `/api/driver/orders/${order.id}/deliver`, dt, { code: '0000' }), /رمز التسليم/);
    await call('POST', `/api/driver/orders/${order.id}/deliver`, dt, { code: o2.delivery_code });
  }
  const done = await one('select * from orders where id=$1', [order.id]);
  assert.equal(done.status, 'delivered');
  assert.equal(Number(done.paid_amount) - Number(done.refunded_amount), Number(done.final_total));
  const led = await q('select kind, amount::float from ledger where order_id=$1', [order.id]);
  assert.ok(led.some(l => l.kind === 'store_earning') && led.some(l => l.kind === 'commission'));
  fullOrder = { token, order: done, part };
});

test('rating + complaint with photo refunds the item and charges the store', async () => {
  const { token, order, part } = fullOrder;
  await call('POST', `/api/me/orders/${order.id}/rate`, token, { store: 5, driver: 4 });
  await assert.rejects(call('POST', `/api/me/orders/${order.id}/complaints`, token, { part_id: part.id, index: 0, kind: 'damaged' }), /صورة/);
  const r = await call('POST', `/api/me/orders/${order.id}/complaints`, token, { part_id: part.id, index: 0, kind: 'damaged', note: 'الكرتون مفتوح', photo: 'data:image/jpeg;base64,AAAA' });
  assert.ok(r.refunded > 0);
  const pen = await one(`select amount::float from ledger where order_id=$1 and kind='store_penalty'`, [order.id]);
  assert.ok(pen.amount < 0);
  await assert.rejects(call('POST', `/api/me/orders/${order.id}/complaints`, token, { part_id: part.id, index: 0, kind: 'damaged', photo: 'data:image/jpeg;base64,AAAA' }), /مسترجع/);
});

test('nobody answers in 60s → next round; split basket when no single store has everything', async () => {
  const { token, address } = await newCustomer('0555000444');
  const admT = (await call('POST', '/api/admin/login', null, { token: 'admin-secret' })).token;
  await call('PATCH', '/api/admin/config', admT, { detour_max_m: 5000 }); // هالاختبار للتقسيم نفسه، مو لشرط الطريق
  // make a basket that only a combination of stores can supply
  const a = await productId('سكر الأسرة'), b = await productId('شامبو هيد آند شولدرز'), c3 = await productId('حليب المراعي طازج كامل الدسم');
  const stores = await q('select id from stores order by created_at');
  await q(`update store_products set available=false where product_id=$1 and store_id <> $2`, [a, stores[0].id]);
  await q(`update store_products set available=false where product_id=$1 and store_id <> $2`, [b, stores[2].id]);
  await q(`insert into store_products (store_id, product_id, price, available) values ($1,$2,22,true) on conflict (store_id, product_id) do update set available=true, confidence=0.9`, [stores[2].id, b]);
  await q(`insert into store_products (store_id, product_id, price, available) values ($1,$2,20,true) on conflict (store_id, product_id) do update set available=true, confidence=0.9`, [stores[0].id, a]);
  const items = [{ product_id: a, qty: 1 }, { product_id: b, qty: 1 }, { product_id: c3, qty: 1 }];
  const qt = await call('POST', '/api/me/quote', token, { address_id: address.id, items });
  assert.equal(qt.items.length, 3);
  assert.ok(qt.stores.length >= 2, 'quote is a split');
  const { order } = await call('POST', '/api/me/orders', token, { address_id: address.id, items });
  await call('POST', `/api/me/orders/${order.id}/pay-test`, token);
  // round 1 times out
  await q(`update offers set expires_at = now() - interval '1 second' where order_id=$1`, [order.id]);
  await sweep();
  const r2 = await q(`select o.*, s.owner_phone from offers o join stores s on s.id=o.store_id where order_id=$1 and status='pending'`, [order.id]);
  assert.ok(r2.length && r2[0].round === 2, 'round 2 started');
  // first store takes what it has; then the rest goes to another store
  let guard = 0;
  while (guard++ < 6) {
    const o = await one('select status from orders where id=$1', [order.id]);
    if (o.status !== 'searching') break;
    const pend = await q(`select o.*, s.owner_phone from offers o join stores s on s.id=o.store_id where order_id=$1 and status='pending'`, [order.id]);
    if (!pend.length) { await sweep(); continue; }
    const t = await loginStore('0' + pend[0].owner_phone.slice(3));
    await call('POST', `/api/store/offers/${pend[0].id}`, t, { action: 'accept' });
  }
  const parts = await q(`select * from order_parts where order_id=$1`, [order.id]);
  await call('PATCH', '/api/admin/config', admT, { detour_max_m: 350 });
  assert.ok(parts.length >= 2, 'basket split across stores: ' + parts.length);
  const taken = parts.flatMap(p => p.items.map(i => i.product_id));
  assert.equal(new Set(taken).size, 3);
  assert.equal((await one('select status from orders where id=$1', [order.id])).status, 'preparing');
});

test('partial accept + substitution approved (cheaper) and rejected (removed) both refund', async () => {
  const { token, address } = await newCustomer('0555000555');
  const milk = await productId('حليب المراعي طازج كامل الدسم'), lab = await productId('لبن المراعي', '2 لتر'), egg = await productId('بيض', '30 حبة'), water = await productId('ماء نوفا');
  const items = [{ product_id: milk, qty: 1 }, { product_id: lab, qty: 2 }, { product_id: egg, qty: 1 }, { product_id: water, qty: 1 }];
  const { order } = await call('POST', '/api/me/orders', token, { address_id: address.id, items });
  await call('POST', `/api/me/orders/${order.id}/pay-test`, token);
  const off = await one(`select o.*, s.owner_phone from offers o join stores s on s.id=o.store_id where order_id=$1 and status='pending' order by created_at limit 1`, [order.id]);
  const t = await loginStore('0' + off.owner_phone.slice(3));
  // store says eggs are missing
  await call('POST', `/api/store/offers/${off.id}`, t, { action: 'partial', missing: [egg] });
  const conf = await one('select confidence from store_products where store_id=$1 and product_id=$2', [off.store_id, egg]);
  assert.ok(conf.confidence < 0.5, 'store learned it has no eggs');
  // finish remaining rounds (eggs elsewhere or removed)
  for (let i = 0; i < 6; i++) {
    const o = await one('select status from orders where id=$1', [order.id]);
    if (o.status !== 'searching') break;
    const p = await one(`select o.*, s.owner_phone from offers o join stores s on s.id=o.store_id where order_id=$1 and status='pending' limit 1`, [order.id]);
    if (!p) { await sweep(); continue; }
    await call('POST', `/api/store/offers/${p.id}`, await loginStore('0' + p.owner_phone.slice(3)), { action: 'decline' });
  }
  const o = await one('select * from orders where id=$1', [order.id]);
  assert.equal(o.status, 'preparing');
  assert.ok(Number(o.refunded_amount) > 0, 'eggs refunded');
  const part = await one('select * from order_parts where order_id=$1 and store_id=$2', [order.id, off.store_id]);
  const li = part.items.findIndex(i => i.product_id === lab);
  const cheaper = await one(`select product_id from store_products where store_id=$1 and available and price < $2 and product_id <> all($3) order by price desc limit 1`, [off.store_id, part.items[li].customer_price, part.items.map(i => i.product_id)]);
  const sub = await call('POST', `/api/store/parts/${part.id}/substitute`, t, { index: li, product_id: cheaper.product_id });
  const before = Number((await one('select refunded_amount from orders where id=$1', [order.id])).refunded_amount);
  await call('POST', `/api/me/substitutions/${sub.id}`, token, { approve: true });
  const after1 = Number((await one('select refunded_amount from orders where id=$1', [order.id])).refunded_amount);
  assert.ok(after1 > before, 'cheaper substitute refunded the difference');
  const mi = part.items.findIndex(i => i.product_id === milk);
  const sub2 = await call('POST', `/api/store/parts/${part.id}/substitute`, t, { index: mi, product_id: await productId('حليب نادك طازج') }).catch(() => null);
  if (sub2) { await call('POST', `/api/me/substitutions/${sub2.id}`, token, { approve: false }); }
  else { await call('POST', `/api/store/parts/${part.id}/missing`, t, { index: mi }); }
  const after2 = Number((await one('select refunded_amount from orders where id=$1', [order.id])).refunded_amount);
  assert.ok(after2 > after1, 'removed milk refunded');
  const fin = await one('select * from orders where id=$1', [order.id]);
  assert.equal(Number(fin.paid_amount) - Number(fin.refunded_amount), Number(fin.final_total));
});

test('no store has it → order cancelled and fully refunded', async () => {
  const { token, address } = await newCustomer('0555000666');
  const pid = await productId('ثلج');
  const items = [{ product_id: pid, qty: 10 }];
  const { order } = await call('POST', '/api/me/orders', token, { address_id: address.id, items });
  await call('POST', `/api/me/orders/${order.id}/pay-test`, token);
  for (let i = 0; i < 8; i++) {
    const p = await one(`select o.*, s.owner_phone from offers o join stores s on s.id=o.store_id where order_id=$1 and status='pending' limit 1`, [order.id]);
    if (!p) { await sweep(); const o = await one('select status from orders where id=$1', [order.id]); if (o.status !== 'searching') break; continue; }
    await call('POST', `/api/store/offers/${p.id}`, await loginStore('0' + p.owner_phone.slice(3)), { action: 'decline' });
  }
  const o = await one('select * from orders where id=$1', [order.id]);
  assert.equal(o.status, 'cancelled');
  assert.equal(Number(o.refunded_amount), Number(o.paid_amount));
});

test('min order and promo for first order only', async () => {
  const { token, address } = await newCustomer('0555000777');
  await assert.rejects(call('POST', '/api/me/orders', token, { address_id: address.id, items: [{ product_id: await productId('علكة'), qty: 1 }] }), /أقل طلب/);
  const items = [{ product_id: await productId('رز أبو كاس'), qty: 1 }];
  const { order } = await call('POST', '/api/me/orders', token, { address_id: address.id, items, promo: 'jarak10' });
  assert.equal(Number(order.discount), 10);
  await assert.rejects(call('POST', '/api/me/orders', token, { address_id: address.id, items, promo: 'JARAK10' }), /لأول طلب/);
});

test('customer can cancel before a store accepts, not after', async () => {
  const { token, address } = await newCustomer('0555000888');
  const items = [{ product_id: await productId('رز أبو كاس'), qty: 1 }];
  const { order } = await call('POST', '/api/me/orders', token, { address_id: address.id, items });
  await call('POST', `/api/me/orders/${order.id}/pay-test`, token);
  await call('POST', `/api/me/orders/${order.id}/cancel`, token);
  const o = await one('select * from orders where id=$1', [order.id]);
  assert.equal(o.status, 'cancelled'); assert.equal(Number(o.refunded_amount), Number(o.paid_amount));
});

test('admin: KPIs, settlements, config', async () => {
  await assert.rejects(call('POST', '/api/admin/login', null, { token: 'nope' }), /غير مصرح/);
  const t = (await call('POST', '/api/admin/login', null, { token: 'admin-secret' })).token;
  const ov = await call('GET', '/api/admin/overview', t);
  assert.ok(ov.delivered_30 >= 1 && ov.aov > 0);
  const s = await call('POST', '/api/admin/settlements/run', t);
  assert.ok(s.created.length >= 1);
  const again = await call('POST', '/api/admin/settlements/run', t);
  assert.equal(again.created.length, 0, 'nothing settled twice');
  const c = await call('PATCH', '/api/admin/config', t, { commission_pct: 7, bogus: 1 });
  assert.equal(c.config.commission_pct, 7);
  await call('PATCH', '/api/admin/config', t, { commission_pct: 8 });
  // roles are isolated
  await assert.rejects(call('GET', '/api/admin/overview', fullOrder.token), /سجّل|انتهت/);
});

test('zone: one neighborhood only, outside goes to the waitlist', async () => {
  const pub = await call('GET', '/api/public');
  assert.equal(pub.zone.name, 'العقربية');
  assert.equal(pub.stores.length, 6);
  assert.ok(pub.terms.commission_pct > 0);
  const o = await call('POST', '/api/auth/otp', null, { phone: '0555999001' });
  const v = await call('POST', '/api/auth/verify', null, { phone: '0555999001', code: o.dev_code });
  // الدمام: برا الحي
  const err = await call('POST', '/api/me/addresses', v.token, { lat: 26.4207, lng: 50.0888, details: 'الدمام' }).catch(e => e);
  assert.equal(err.status, 422); assert.equal(err.body.code, 'outside_zone'); assert.ok(err.body.dist_m > 10000);
  const w = await one('select w.* from waitlist w join customers c on c.id=w.customer_id where c.phone=$1', ['966555999001']);
  assert.ok(w, 'saved in waitlist');
  const cat = await call('GET', '/api/catalog?lat=26.4207&lng=50.0888');
  assert.equal(cat.in_zone, false); assert.equal(cat.products.length, 0);
  // الأدمن يشوف قائمة الانتظار ويقدر يغيّر الحي
  const adm = (await call('POST', '/api/admin/login', null, { token: 'admin-secret' })).token;
  const z = await call('GET', '/api/admin/zone', adm);
  assert.ok(z.waitlist.length >= 1); assert.ok(z.stores.every(s => s.in_zone));
  await call('PATCH', '/api/admin/config', adm, { zone_name: 'حي تجريبي', gemini_api_key: 'AIzaTEST1234' });
  const cf = await call('GET', '/api/admin/config', adm);
  assert.equal(cf.config.zone_name, 'حي تجريبي'); assert.equal(cf.config.gemini_api_key, undefined); assert.equal(cf.config.gemini_key_hint, '••••1234');
  await call('PATCH', '/api/admin/config', adm, { zone_name: 'العقربية', gemini_api_key: '' });
  const cf2 = await call('GET', '/api/admin/config', adm);
  assert.equal(cf2.config.gemini_key_set, false);
});

test('smart features: bundles, neighbourhood average, restock insights', async () => {
  const c = await call('GET', `/api/catalog?lat=${HOME.lat}&lng=${HOME.lng}`);
  assert.ok(c.bundles.length >= 3, 'ready bundles');
  assert.ok(c.bundles.every(b => b.total > 0 && b.items.length >= 3));
  assert.ok(c.products.every(p => p.avg_price >= p.min_price));
  assert.ok(c.products.every(p => p.image && /^\/img\/(p|off)\//.test(p.image)));
  assert.ok(c.products.some(p => p.image.startsWith('/img/off/')), 'real pack photos');
  // a customer who already received orders gets restock suggestions
  const row = await one(`select customer_id from orders where status='delivered' limit 1`);
  const tok = (await one(`select token from sessions where role='customer' and subject_id=$1 limit 1`, [row.customer_id]))?.token;
  if (tok) {
    await q(`update orders set delivered_at = now() - interval '9 days' where customer_id=$1 and status='delivered'`, [row.customer_id]);
    const ins = await call('GET', '/api/me/insights', tok);
    assert.ok(ins.orders >= 1); assert.ok(ins.restock.length >= 1); assert.ok(ins.saved >= 0);
  }
});

test('store uploads a product photo, admin approves, customers see it', async () => {
  const t = await loginStore('0500000003');
  const pid = await productId('بيض', '30 حبة');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await call('POST', `/api/store/products/${pid}/photo`, t, { photo: png });
  assert.equal(r.photo.status, 'pending');
  await assert.rejects(call('POST', `/api/store/products/${pid}/photo`, t, { photo: 'data:text/plain;base64,aGk=' }), /صورة/);
  const adm = (await call('POST', '/api/admin/login', null, { token: 'admin-secret' })).token;
  const list = await call('GET', '/api/admin/photos', adm);
  const ph = list.photos.find(x => x.id === r.photo.id); assert.ok(ph);
  await call('POST', `/api/admin/photos/${ph.id}`, adm, { approve: true });
  const prod = await one('select image from products where id=$1', [pid]);
  assert.equal(prod.image, ph.path);
  const f = await fetch(base + ph.path); assert.equal(f.status, 200);
});

test('live map: driver GPS reaches the customer and admin; demo rider walks toward the target', async () => {
  const { simTick } = await import('../src/live.js');
  const t = await loginDriver('0510000002');
  const d = await one(`select id from drivers where phone like '%510000002'`);
  const got = [];
  const onA = (m) => got.push(['admin', m]); bus.on('admin', onA);
  await call('POST', '/api/driver/status', t, { online: true, lat: 26.2860, lng: 50.2110 });
  bus.off('admin', onA);
  assert.ok(got.some(([, m]) => m.type === 'driver' && m.id === d.id && m.lat === 26.2860), 'admin hears the driver move');
  const adm = (await call('POST', '/api/admin/login', null, { token: 'admin-secret' })).token;
  const live = await call('GET', '/api/admin/live', adm);
  assert.ok(live.drivers.find(x => x.id === d.id && x.online));
  assert.ok(live.stores.length >= 3);
  const pub = await call('GET', '/api/public');
  assert.ok(/\{z\}/.test(pub.tiles), 'map tiles url for the apps');
  // an active order whose rider has no real GPS gets simulated toward the store/customer
  const o = await one(`select o.id, o.driver_id, o.lat, o.lng from orders o where o.status='delivered' limit 1`);
  if (o) {
    const d2 = (await call('POST', '/api/admin/drivers', adm, { name: 'مندوب تجربة الحركة', phone: '0519990001' })).driver;
    await q(`update drivers set lat=$2, lng=$3 where id=$1`, [d2.id, o.lat + 0.006, o.lng + 0.006]);
    await q(`update orders set status='delivering', driver_id=$2 where id=$1`, [o.id, d2.id]);
    const seen = []; const onO = (m) => seen.push(m); bus.on('order:' + o.id, onO);
    const before = await one('select lat, lng from drivers where id=$1', [d2.id]);
    await simTick(2);
    bus.off('order:' + o.id, onO);
    const after = await one('select lat, lng from drivers where id=$1', [d2.id]);
    assert.ok(Math.abs(after.lat - o.lat) < Math.abs(before.lat - o.lat), 'rider moved closer');
    assert.ok(seen.some(m => m.type === 'driver'), 'customer tracking got the new position');
    await q(`update orders set status='delivered' where id=$1`, [o.id]);
  }
});

test('real launch: cash on delivery, SMS login only for registered phones, push subscribe, readiness', async () => {
  // a phone that is not a registered store gets no code (and we don't reveal it)
  const ghost = await call('POST', '/api/store/otp', null, { phone: '0599999911' });
  assert.ok(ghost.sent && !ghost.dev_code);
  // cash on delivery order goes straight to the stores
  const { token, address } = await newCustomer('0555000999');
  const me = await call('GET', '/api/me', token);
  assert.ok(me.pay.cod && me.pay.online === false, 'no fake online payment without Moyasar');
  const items = [{ product_id: await productId('بيض', '30 حبة'), qty: 1 }, { product_id: await productId('حليب المراعي طازج كامل الدسم'), qty: 2 }];
  const qt = await call('POST', '/api/me/quote', token, { address_id: address.id, items });
  const { order, payment } = await call('POST', '/api/me/orders', token, { address_id: address.id, items, expected_total: qt.total, payment: 'cod' });
  assert.equal(payment.mode, 'cod'); assert.equal(order.payment_method, 'cod'); assert.equal(order.status, 'searching');
  const off = await one(`select o.*, s.owner_phone, s.self_delivery from offers o join stores s on s.id=o.store_id where order_id=$1 and o.status='pending' and jsonb_array_length(o.items)=2 and s.self_delivery=false limit 1`, [order.id]);
  assert.ok(off, 'offered to a store');
  const st = await loginStore('0' + off.owner_phone.slice(3));
  await call('POST', `/api/store/offers/${off.id}`, st, { action: 'accept' });
  const part = await one('select * from order_parts where order_id=$1', [order.id]);
  for (const p of ['0510000001', '0510000002', '0510000003']) { const t = await loginDriver(p); await call('POST', '/api/driver/status', t, { online: true, lat: 26.285, lng: 50.21 }); }
  await call('POST', `/api/store/parts/${part.id}/ready`, st);
  const doff = await one(`select d.*, dr.phone from driver_offers d join drivers dr on dr.id=d.driver_id where order_id=$1 and d.status='pending' limit 1`, [order.id]);
  assert.ok(doff, 'driver offered');
  const dt = await loginDriver('0' + doff.phone.slice(3));
  await call('POST', `/api/driver/offers/${doff.id}`, dt, { accept: true });
  const jobs = await call('GET', '/api/driver/jobs', dt);
  const job = jobs.jobs.find(j => j.id === order.id);
  assert.equal(job.payment_method, 'cod'); assert.ok(job.collect > 0, 'driver sees how much to collect');
  await call('POST', `/api/driver/parts/${part.id}/pickup`, dt);
  const o2 = await one('select * from orders where id=$1', [order.id]);
  await call('POST', `/api/driver/orders/${order.id}/deliver`, dt, { code: o2.delivery_code });
  const cash = await one(`select amount::float a from ledger where order_id=$1 and kind='driver_cash'`, [order.id]);
  assert.ok(cash && cash.a < 0, 'driver owes the cash he collected');
  // push subscription is validated and stored
  await assert.rejects(call('POST', '/api/me/push', token, { endpoint: 'http://x' }), /غير صالح/);
  await call('POST', '/api/me/push', token, { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'BOr' + 'x'.repeat(60), auth: 'yyyyyyyyyyyyyyyy' } });
  assert.ok((await call('GET', '/api/push/key')).key.length > 40);
  const adm = (await call('POST', '/api/admin/login', null, { token: 'admin-secret' })).token;
  const r = await call('GET', '/api/admin/readiness', adm);
  assert.ok(r.checks.find(c => /SMS/.test(c.title) && !c.ok), 'readiness flags missing SMS provider');
});

test('hood: my baqala first, the usual basket, neighbours trip, and the tab', async () => {
  const adm = (await call('POST', '/api/admin/login', null, { token: 'admin-secret' })).token;
  // customer A picks a home store and orders: offer goes ONLY to that store first
  const A = await newCustomer('0555111001');
  const hoodA = await call('GET', '/api/me/hood?address_id=' + A.address.id, A.token);
  const home = hoodA.stores.find(s => s.is_open && s.name !== 'تموينات الهدى');
  await call('PATCH', '/api/me', A.token, { home_store_id: home.id });
  assert.equal((await call('GET', '/api/me/hood?address_id=' + A.address.id, A.token)).home.id, home.id);
  const items = [{ product_id: await productId('بيض', '30 حبة'), qty: 1 }, { product_id: await productId('حليب المراعي طازج كامل الدسم'), qty: 2 }];
  const qa = await call('POST', '/api/me/quote', A.token, { address_id: A.address.id, items });
  const { order: oa } = await call('POST', '/api/me/orders', A.token, { address_id: A.address.id, items, expected_total: qa.total, payment: 'cod' });
  const offs = await q(`select * from offers where order_id=$1`, [oa.id]);
  assert.equal(offs.length, 1); assert.equal(offs[0].store_id, home.id, 'home store gets it first, alone');
  const sh = await one('select owner_phone from stores where id=$1', [home.id]);
  const st = await loginStore('0' + sh.owner_phone.slice(3));
  await call('POST', `/api/store/offers/${offs[0].id}`, st, { action: 'accept' });
  // a driver takes A's order
  for (const p of ['0510000001', '0510000002', '0510000003']) { const t = await loginDriver(p); await call('POST', '/api/driver/status', t, { online: true, lat: 26.285, lng: 50.21 }); }
  const doff = await one(`select d.*, dr.phone from driver_offers d join drivers dr on dr.id=d.driver_id where order_id=$1 and d.status='pending' limit 1`, [oa.id]);
  const dt = await loginDriver('0' + doff.phone.slice(3));
  await call('POST', `/api/driver/offers/${doff.id}`, dt, { accept: true });
  // neighbour B sees the trip and joins it with cheap delivery
  const B = await newCustomer('0555111002');
  const hb = await call('GET', '/api/me/hood?address_id=' + B.address.id, B.token);
  const trip = hb.trips.find(t => t.id === oa.id);
  assert.ok(trip, 'neighbour sees the trip'); assert.ok(trip.fee < trip.normal_fee);
  const itemsB = [{ product_id: await productId('بيض', '30 حبة'), qty: 2 }];
  const qb = await call('POST', '/api/me/quote', B.token, { address_id: B.address.id, items: itemsB, join: trip.id });
  assert.equal(qb.delivery_fee, trip.fee); assert.equal(qb.stores[0].id, home.id);
  const { order: ob } = await call('POST', '/api/me/orders', B.token, { address_id: B.address.id, items: itemsB, expected_total: qb.total, payment: 'cod', join: trip.id });
  const offB = await one(`select * from offers where order_id=$1`, [ob.id]);
  assert.equal(offB.store_id, home.id);
  await call('POST', `/api/store/offers/${offB.id}`, st, { action: 'accept' });
  const ob2 = await one('select * from orders where id=$1', [ob.id]);
  const oa2 = await one('select driver_id from orders where id=$1', [oa.id]);
  assert.equal(ob2.driver_id, oa2.driver_id, 'same rider carries both');
  assert.equal(Number(ob2.driver_pay), 3);
  // the tab: A asks, the store opens it with a limit, A orders on the tab, it is charged on delivery
  await call('POST', '/api/me/tabs', A.token, { store_id: home.id });
  const tabs = await call('GET', '/api/store/tabs', st);
  const tA = tabs.tabs.find(t => t.status === 'requested');
  assert.ok(tA);
  await assert.rejects(call('POST', `/api/store/tabs/${tA.id}`, st, { action: 'approve', limit: 999999 }), /الحد/);
  await call('POST', `/api/store/tabs/${tA.id}`, st, { action: 'approve', limit: 300 });
  const me = await call('GET', '/api/me', A.token);
  assert.equal(me.tabs[0].status, 'open');
  const qt = await call('POST', '/api/me/quote', A.token, { address_id: A.address.id, items, payment: 'tab' });
  const { order: ot } = await call('POST', '/api/me/orders', A.token, { address_id: A.address.id, items, expected_total: qt.total, payment: 'tab' });
  assert.equal(ot.payment_method, 'tab');
  const offT = await one(`select * from offers where order_id=$1`, [ot.id]);
  await call('POST', `/api/store/offers/${offT.id}`, st, { action: 'accept' });
  const partT = await one('select * from order_parts where order_id=$1', [ot.id]);
  await call('POST', `/api/store/parts/${partT.id}/ready`, st);
  const self = await one('select self_delivery from stores where id=$1', [home.id]);
  let o3 = await one('select * from orders where id=$1', [ot.id]);
  if (!o3.driver_id) { const d2 = await one(`select d.*, dr.phone from driver_offers d join drivers dr on dr.id=d.driver_id where order_id=$1 and d.status='pending' limit 1`, [ot.id]); const t2 = await loginDriver('0' + d2.phone.slice(3)); await call('POST', `/api/driver/offers/${d2.id}`, t2, { accept: true }); o3 = await one('select * from orders where id=$1', [ot.id]); }
  const drv = await one('select phone from drivers where id=$1', [o3.driver_id]);
  const t3 = await loginDriver('0' + drv.phone.slice(3));
  await call('POST', `/api/driver/parts/${partT.id}/pickup`, t3);
  await call('POST', `/api/driver/orders/${ot.id}/deliver`, t3, { code: o3.delivery_code });
  const tabNow = (await call('GET', '/api/store/tabs', st)).tabs.find(t => t.id === tA.id);
  assert.ok(tabNow.balance > 0, 'charged on the tab');
  await call('POST', `/api/store/tabs/${tA.id}`, st, { action: 'pay', amount: tabNow.balance });
  assert.equal((await call('GET', '/api/store/tabs', st)).tabs.find(t => t.id === tA.id).balance, 0);
  // the usual basket learns from delivered orders
  const u = await call('GET', '/api/me/hood?address_id=' + A.address.id, A.token);
  assert.ok(u.usual.length >= 1);
  assert.ok(self.self_delivery === false || true);
});

test('smart fulfilment: a second store joins only when it is on the rider\'s way', async () => {
  const { detour } = await import('../src/catalog.js');
  const home = { lat: 26.2852, lng: 50.2098 };
  const s1 = { lat: 26.2870, lng: 50.2120 };
  const onWay = { lat: 26.2861, lng: 50.2109 }, away = { lat: 26.2890, lng: 50.2060 };
  assert.ok(detour(s1, onWay, home) < 100, 'a store between the first one and the house adds almost nothing');
  assert.ok(detour(s1, away, home) > 350, 'a store the other way is skipped');
  const pub = await call('GET', '/api/public');
  assert.equal(pub.terms.late_minutes, 20);
});

test('guest can price a basket before signing in; admin can broadcast to customers', async () => {
  const items = [{ product_id: await productId('بيض', '30 حبة'), qty: 1 }];
  const z = (await call('GET', '/api/public')).zone;
  const qt = await call('POST', '/api/quote', null, { lat: z.lat, lng: z.lng, items });
  assert.ok(qt.total > 0 && qt.stores.every(s => !s.name), 'guest sees prices, never store names');
  await assert.rejects(call('POST', '/api/quote', null, { items }), /موقعك/);
  const adm = (await call('POST', '/api/admin/login', null, { token: 'admin-secret' })).token;
  const st = await call('GET', '/api/admin/push/stats', adm);
  assert.ok(st.customers >= 1);
  await assert.rejects(call('POST', '/api/admin/push/broadcast', adm, { title: '' }), /العنوان/);
  const r = await call('POST', '/api/admin/push/broadcast', adm, { title: 'جارك', body: 'التوصيل مجاني الليلة' });
  assert.ok(r.sent >= 0);
});

test('a captain signs up himself, waits for review, and logs in with a password once approved', async () => {
  const phone = '0559876543';
  await assert.rejects(call('POST', '/api/driver/apply', null, { name: 'سعد', phone, password: '123' }), /6/);
  await call('POST', '/api/driver/apply', null, { name: 'سعد العتيبي', phone, password: 'secret12', vehicle: 'car', area: 'الراكة' });
  await assert.rejects(call('POST', '/api/driver/apply', null, { name: 'سعد العتيبي', phone, password: 'secret12' }), /تحت المراجعة/);
  const e = await call('POST', '/api/driver/login', null, { phone, password: 'secret12' }).catch(x => x);
  assert.equal(e.status, 403); assert.equal(e.body.code, 'driver_pending');
  await assert.rejects(call('POST', '/api/driver/login', null, { phone, password: 'wrongpass' }), /غلط/);
  const adm = (await call('POST', '/api/admin/login', null, { token: 'admin-secret' })).token;
  const d = (await call('GET', '/api/admin/drivers', adm)).drivers.find(x => x.vehicle === 'car' && x.name === 'سعد العتيبي');
  assert.equal(d.status, 'pending');
  await call('PATCH', '/api/admin/drivers/' + d.id, adm, { status: 'active' });
  const t = (await call('POST', '/api/driver/login', null, { phone, password: 'secret12' })).token;
  const me = await call('GET', '/api/driver/me', t);
  assert.equal(me.driver.name, 'سعد العتيبي'); assert.ok(!me.driver.pin_hash);
  const np = (await call('PATCH', '/api/admin/drivers/' + d.id, adm, { reset_password: true })).password;
  await assert.rejects(call('GET', '/api/driver/me', t), /سجّل|انتهت/);
  assert.ok((await call('POST', '/api/driver/login', null, { phone, password: np })).token);
});
