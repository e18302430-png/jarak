// جارك: السيرفر
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initDb, q, one, dbKind } from './db.js';
import { sse, emit } from './events.js';
import { cfg, setCfg, DEFAULTS, TEXT_DEFAULTS } from './config.js';
import { startOtp, verifyOtp, adminLogin, requireRole } from './auth.js';
import { listing, quote, inZone, zoneOf } from './catalog.js';
import { respondOffer, respondDriver, sweep, clearTimers } from './dispatch.js';
import * as O from './orders.js';
import { parseBasket, aiEnabled, testAi } from './ai.js';
import { distM } from './util.js';
import { geoSearch, geoReverse } from './geo.js';
import { initPush, subscribe, pushKey, pushTo } from './push.js';
import { sendSms, smsProvider } from './sms.js';
import * as H from './hood.js';
import { pushDriverPos, markRealGps, simTick, liveBoard } from './live.js';
import { paymentMode } from './payments.js';
import { seedDemo, seedCatalog, basePrice, CAT_ORDER } from '../seed/demo.js';
import { CAT_IMG } from '../seed/images.js';
import { normPhone, validSaudiMobile, hashSecret, round2, bad, HttpError, localPhone } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS = process.env.UPLOADS_DIR || path.join(here, '..', 'public', 'img', 'u');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const num = (v) => { const n = Number(String(v ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))); return Number.isFinite(n) ? n : NaN; };
const dataUrl = (s) => { const m = /^data:([\w/+.-]+)(?:;[^,]*)?;base64,(.+)$/.exec(s || ''); return m ? { mime: m[1], b64: m[2] } : null; };
const baseUrl = (req) => process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'));

export async function createApp() {
  await initDb();
  if (process.env.DEMO === '1') await seedDemo(); else await seedCatalog();
  await initPush();
  await cfg();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '8mb' }));
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'strict-origin-when-cross-origin'); next(); });

  // ---------- public ----------
  app.get('/health', (_q, res) => res.json({ ok: true, db: dbKind(), ai: aiEnabled(), payments: paymentMode(), sms: process.env.SMS_PROVIDER || 'dev' }));
  app.post('/api/auth/otp', wrap(async (req, res) => res.json(await startOtp(req.body.phone, req.ip))));
  app.post('/api/auth/verify', wrap(async (req, res) => { const r = await verifyOtp(req.body.phone, req.body.code); res.json({ token: r.token, customer: r.customer, isNew: r.isNew }); }));
  // البقالة والمندوب يدخلون برمز يوصلهم SMS على الجوال المسجّل في الإدارة
  app.post('/api/store/otp', wrap(async (req, res) => res.json(await startOtp(req.body.phone, req.ip, 'store'))));
  app.post('/api/store/verify', wrap(async (req, res) => res.json({ token: (await verifyOtp(req.body.phone, req.body.code, 'store')).token })));
  app.post('/api/driver/otp', wrap(async (req, res) => res.json(await startOtp(req.body.phone, req.ip, 'driver'))));
  app.post('/api/driver/verify', wrap(async (req, res) => res.json({ token: (await verifyOtp(req.body.phone, req.body.code, 'driver')).token })));
  app.post('/api/admin/login', wrap(async (req, res) => res.json({ token: await adminLogin(req.body.token) })));
  app.post('/api/payments/moyasar/webhook', wrap(async (req, res) => { await O.moyasarWebhook(req.body); res.json({ ok: true }); }));
  app.get('/api/catalog', wrap(async (req, res) => {
    const lat = num(req.query.lat), lng = num(req.query.lng);
    if (req.query.lat == null || req.query.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) throw bad('حدد موقعك');
    const c = await cfg();
    res.json({ ...(await listing(lat, lng)), categories: CAT_ORDER, category_images: CAT_IMG, delivery_fee: c.delivery_fee, free_delivery_over: c.free_delivery_over, min_order: c.min_order, zone: zoneOf(c), in_zone: inZone(c, lat, lng, 50) });
  }));
  // للصفحات الترحيبية: الحي وبقالاته وأرقام الشراكة (بدون أي بيانات خاصة)
  // تسعير للزائر قبل ما يسجّل: يتصفح ويعبّي السلة، ويسجّل بس وقت الطلب
  app.post('/api/quote', wrap(async (req, res) => {
    const lat = num(req.body.lat), lng = num(req.body.lng);
    if (req.body.lat == null || req.body.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) throw bad('حدد موقعك');
    const prods = await q('select * from products where id = any($1)', [(req.body.items || []).slice(0, 60).map(i => i.product_id)]);
    const items = (req.body.items || []).map(i => { const p = prods.find(x => x.id === i.product_id); return p && { product_id: p.id, name_ar: p.name_ar, size: p.size, unit: p.unit, icon: p.icon, image: p.image, qty: Math.min(99, Math.max(1, Math.round(num(i.qty) || 1))) }; }).filter(Boolean);
    const qt = await quote(lat, lng, items);
    res.json({ ...qt, stores: qt.stores.map(x => ({ id: x.id, dist: x.dist, count: x.count })) });
  }));
  app.get('/api/push/key', (_req, res) => res.json({ key: pushKey() }));
  app.get('/api/public', wrap(async (_req, res) => {
    const c = await cfg(); const z = zoneOf(c);
    const stores = (await q(`select name, lat, lng, is_open from stores where suspended = false`)).filter(s => inZone(c, s.lat, s.lng, 100));
    const drivers = await one(`select count(*)::int n from drivers where online and seen_at > now() - interval '10 minutes'`);
    res.json({ zone: z, stores: stores.map(s => ({ name: s.name, lat: s.lat, lng: s.lng, open: s.is_open })), drivers_online: drivers.n, tiles: c.map_tiles,
      terms: { commission_pct: c.commission_pct, delivery_fee: c.delivery_fee, free_delivery_over: c.free_delivery_over, min_order: c.min_order, driver_pay: c.driver_pay, driver_pay_extra_pickup: c.driver_pay_extra_pickup, offer_seconds: c.offer_seconds, late_minutes: c.late_minutes, promise_min: c.promise_min }, ai: aiEnabled() });
  }));

  // ---------- customer ----------
  const me = express.Router(); me.use(requireRole('customer'));
  me.post('/push', wrap(async (req, res) => res.json(await subscribe('customer', req.customer.id, req.body))));
  me.get('/', wrap(async (req, res) => {
    const addresses = await q('select * from addresses where customer_id=$1 order by created_at desc', [req.customer.id]);
    const c = await cfg();
    res.json({ customer: req.customer, addresses: addresses.map(a => ({ ...a, in_zone: inZone(c, a.lat, a.lng, 50) })), tabs: await H.myTabs(req.customer.id), payments: paymentMode(), pay: { online: !!process.env.MOYASAR_SECRET_KEY, cod: !!Number(c.cod_enabled), cod_max: Number(c.cod_max) }, ai: aiEnabled(), zone: zoneOf(c) });
  }));
  me.patch('/', wrap(async (req, res) => {
    if ('home_store_id' in req.body) await H.setHomeStore(req.customer, req.body.home_store_id);
    if ('name' in req.body) await q('update customers set name=$2 where id=$1', [req.customer.id, String(req.body.name || '').slice(0, 60) || null]);
    res.json({ customer: await one('select * from customers where id=$1', [req.customer.id]) });
  }));
  // شاشة الحي: بقالتك، والمعتاد، ومشاوير الجيران الطالعة لشارعك، وبقالات الحي
  me.get('/hood', wrap(async (req, res) => {
    const a = await one('select * from addresses where id=$1 and customer_id=$2', [req.query.address_id, req.customer.id]);
    if (!a) throw bad('اختر عنوان التوصيل');
    const c = await cfg();
    const stores = (await q('select id, name, area, lat, lng, is_open, rating_sum, rating_n, self_delivery from stores where suspended=false')).filter(s => inZone(c, s.lat, s.lng, 100))
      .map(s => ({ id: s.id, name: s.name, area: s.area, is_open: s.is_open, dist: Math.round(distM(a.lat, a.lng, s.lat, s.lng)), rating: s.rating_n ? round2(s.rating_sum / s.rating_n) : null })).sort((x, y) => x.dist - y.dist);
    res.json({ home: await H.homeStore(req.customer, a.lat, a.lng), usual: await H.usualBasket(req.customer.id), trips: await H.openTrips(req.customer.id, a.lat, a.lng), stores, tabs: await H.myTabs(req.customer.id) });
  }));
  me.post('/tabs', wrap(async (req, res) => res.json({ tab: await H.requestTab(req.customer, req.body.store_id || req.customer.home_store_id) })));
  me.post('/addresses', wrap(async (req, res) => {
    const lat = num(req.body.lat), lng = num(req.body.lng);
    if (!(lat > 16 && lat < 33 && lng > 34 && lng < 56)) throw bad('الموقع لازم يكون داخل السعودية');
    const c = await cfg();
    if (!inZone(c, lat, lng, 50)) {
      // نسجّله في قائمة الانتظار: هذي بيانات الطلب على الأحياء الثانية (وين نتوسع بعدين)
      await q(`insert into waitlist (customer_id, lat, lng, details) values ($1,$2,$3,$4) on conflict (customer_id) do update set lat=excluded.lat, lng=excluded.lng, details=excluded.details, created_at=now()`, [req.customer.id, lat, lng, String(req.body.details || '').slice(0, 200)]);
      const e = new HttpError(422, 'حالياً نخدم حي ' + c.zone_name + ' بس'); e.code = 'outside_zone'; e.extra = { zone: zoneOf(c), dist_m: Math.round(distM(c.zone_lat, c.zone_lng, lat, lng)) }; throw e;
    }
    res.json({ address: await one('insert into addresses (customer_id, label, lat, lng, details) values ($1,$2,$3,$4,$5) returning *', [req.customer.id, String(req.body.label || 'البيت').slice(0, 30), lat, lng, String(req.body.details || '').slice(0, 200)]) });
  }));
  me.delete('/addresses/:id', wrap(async (req, res) => { await q('delete from addresses where id=$1 and customer_id=$2', [req.params.id, req.customer.id]); res.json({ ok: true }); }));
  me.post('/quote', wrap(async (req, res) => {
    const a = await one('select * from addresses where id=$1 and customer_id=$2', [req.body.address_id, req.customer.id]);
    if (!a) throw bad('اختر عنوان التوصيل');
    const prods = await q('select * from products where id = any($1)', [(req.body.items || []).map(i => i.product_id)]);
    const items = (req.body.items || []).map(i => { const p = prods.find(x => x.id === i.product_id); return p && { product_id: p.id, name_ar: p.name_ar, size: p.size, unit: p.unit, icon: p.icon, image: p.image, qty: Math.min(99, Math.max(1, Math.round(num(i.qty) || 1))) }; }).filter(Boolean);
    let opt = { prefer: req.customer.home_store_id || null };
    if (req.body.join) { const t = await H.tripFor(req.customer.id, a.lat, a.lng, req.body.join); opt = { prefer: t.store_id, exclusive: true, fee: t.fee, min: t.min_order }; }
    else if (req.body.payment === 'tab') opt.exclusive = true;
    const qt = await quote(a.lat, a.lng, items, opt);
    res.json({ ...qt, stores: qt.stores.map(x => ({ id: x.id, dist: x.dist, count: x.count })) }); // العميل يشوف جارك بس
  }));
  me.post('/orders', wrap(async (req, res) => res.json(await O.createOrder(req.customer, req.body, baseUrl(req)))));
  if (process.env.JARAK_NO_TIMERS === '1' || process.env.ALLOW_TEST_PAY === '1') me.post('/orders/:id/pay-test', wrap(async (req, res) => res.json({ order: await O.payTest(req.customer, req.params.id) })));
  me.post('/orders/:id/cancel', wrap(async (req, res) => res.json({ order: await O.cancelByCustomer(req.customer, req.params.id) })));
  me.get('/orders', wrap(async (req, res) => res.json({ orders: await q(`select id, number, status, quote_total, final_total, refunded_amount, items, created_at, delivered_at, rating_store from orders where customer_id=$1 and status <> 'pending_payment' order by created_at desc limit 30`, [req.customer.id]) })));
  me.get('/orders/:id', wrap(async (req, res) => {
    const o = await one('select * from orders where id=$1 and customer_id=$2', [req.params.id, req.customer.id]);
    if (!o) throw new HttpError(404, 'الطلب غير موجود');
    const parts = await q(`select p.id, p.status, p.items, s.name as store_name, s.area, s.lat, s.lng from order_parts p join stores s on s.id=p.store_id where p.order_id=$1 order by p.created_at`, [o.id]);
    const subs = await q(`select s.*, p.items from substitutions s join order_parts p on p.id=s.part_id where s.order_id=$1 and s.status='pending'`, [o.id]);
    const driver = o.driver_id ? await one('select name, phone, lat, lng from drivers where id=$1', [o.driver_id]) : null;
    const ids = [...new Set([...o.items, ...parts.flatMap(p => p.items)].map(i => i.product_id))];
    const imgs = new Map((await q('select id, image from products where id = any($1)', [ids])).map(r => [r.id, r.image]));
    o.items = o.items.map(i => ({ ...i, image: i.image || imgs.get(i.product_id) }));
    const safeParts = parts.map(p => ({ ...p, store_name: 'جارك', area: null, items: p.items.map(({ price, ...i }) => ({ ...i, image: imgs.get(i.product_id), sub: i.sub ? { name_ar: i.sub.name_ar, customer_price: i.sub.customer_price } : undefined })) }));
    res.json({ order: o, parts: safeParts, driver: driver && { name: driver.name, phone: localPhone(driver.phone), lat: driver.lat, lng: driver.lng },
      substitutions: subs.map(s => { const it = s.items[s.item_index]; return { id: s.id, original: it.name_ar, name: s.name_ar, qty: it.qty, price: Math.min(Number(s.price), it.customer_price), original_price: it.customer_price, expires_at: s.expires_at }; }) });
  }));
  me.get('/orders/:id/stream', wrap(async (req, res) => {
    const o = await one('select id from orders where id=$1 and customer_id=$2', [req.params.id, req.customer.id]);
    if (!o) throw new HttpError(404, 'الطلب غير موجود');
    sse(req, res, 'order:' + o.id);
  }));
  me.post('/substitutions/:id', wrap(async (req, res) => res.json(await O.answerSubstitution(req.customer, req.params.id, !!req.body.approve))));
  me.post('/orders/:id/rate', wrap(async (req, res) => res.json(await O.rate(req.customer, req.params.id, req.body.store, req.body.driver, req.body.note))));
  me.post('/orders/:id/complaints', wrap(async (req, res) => res.json(await O.complain(req.customer, req.params.id, req.body.part_id, Number(req.body.index), req.body.kind, req.body.note, req.body.photo))));
  me.post('/ai/parse', wrap(async (req, res) => {
    const audio = req.body.audio ? dataUrl(req.body.audio) : null, image = req.body.image ? dataUrl(req.body.image) : null;
    if (!req.body.text && !audio && !image) throw bad('قول أو اكتب طلبك');
    res.json(await parseBasket({ text: req.body.text ? String(req.body.text).slice(0, 1000) : null, audio, image }));
  }));
  // ذكاء العميل: كم وفّر معنا، ووش غالباً خلص عنده (من عادة طلباته)
  me.get('/insights', wrap(async (req, res) => {
    const orders = await q(`select items, delivered_at, refunded_amount, discount from orders where customer_id=$1 and status='delivered' order by delivered_at`, [req.customer.id]);
    const saved = round2(orders.reduce((a, o) => a + Number(o.refunded_amount || 0) + Number(o.discount || 0), 0));
    const GAP = { 'ألبان': 3, 'مخبوزات': 2, 'مشروبات': 7, 'خضار وفواكه': 4 };
    const hist = new Map();
    for (const o of orders) for (const i of o.items) { const h = hist.get(i.product_id) || { n: 0, dates: [], qty: i.qty }; h.n++; h.dates.push(new Date(o.delivered_at)); h.qty = i.qty; hist.set(i.product_id, h); }
    const prods = hist.size ? await q('select id, category from products where id = any($1)', [[...hist.keys()]]) : [];
    const now = Date.now(), day = 864e5, restock = [];
    for (const p of prods) {
      const h = hist.get(p.id), last = h.dates[h.dates.length - 1];
      const gaps = h.dates.slice(1).map((d, k) => (d - h.dates[k]) / day).filter(g => g > 0.5);
      const every = gaps.length ? gaps.reduce((a, g) => a + g, 0) / gaps.length : (GAP[p.category] || 10);
      const since = (now - last) / day;
      if (since >= every * 0.8) restock.push({ product_id: p.id, qty: h.qty, every: Math.round(every), since: Math.floor(since), times: h.n });
    }
    restock.sort((a, b) => b.since / b.every - a.since / a.every);
    res.json({ orders: orders.length, saved, restock: restock.slice(0, 12) });
  }));
  me.get('/last-order', wrap(async (req, res) => res.json({ order: await one(`select id, items from orders where customer_id=$1 and status='delivered' order by delivered_at desc limit 1`, [req.customer.id]) })));
  app.use('/api/me', me);

  // ---------- store ----------
  const st = express.Router(); st.use(requireRole('store'));
  st.get('/tabs', wrap(async (req, res) => res.json({ tabs: await H.storeTabs(req.store.id) })));
  st.post('/tabs/:id', wrap(async (req, res) => res.json({ tab: await H.storeTabAction(req.store.id, req.params.id, req.body) })));
  st.post('/push', wrap(async (req, res) => res.json(await subscribe('store', req.store.id, req.body))));
  st.get('/me', wrap(async (req, res) => {
    const s = req.store; const { pin_hash, ...pub } = s;
    const today = await one(`select count(*)::int n, coalesce(sum(subtotal),0)::float sales from order_parts where store_id=$1 and status <> 'cancelled' and created_at::date = now()::date`, [s.id]);
    const due = await one(`select coalesce(sum(amount),0)::float due from ledger where store_id=$1 and settled=false and kind in ('store_earning','store_penalty')`, [s.id]);
    res.json({ store: pub, today, due: due.due, avg_response_s: s.respond_n ? Math.round(s.respond_ms_sum / s.respond_n / 1000) : null, rating: s.rating_n ? round2(s.rating_sum / s.rating_n) : null, accept_rate: s.offers_n ? Math.round(s.accepted_n / s.offers_n * 100) : null, cfg: { commission_pct: s.commission_pct ?? (await cfg()).commission_pct, offer_seconds: (await cfg()).offer_seconds } });
  }));
  st.patch('/me', wrap(async (req, res) => {
    const b = req.body;
    await q(`update stores set is_open=coalesce($2,is_open), worker_lang=coalesce($3,worker_lang), self_delivery=coalesce($4,self_delivery) where id=$1`, [req.store.id, typeof b.is_open === 'boolean' ? b.is_open : null, ['ar', 'ur', 'bn', 'hi', 'ml', 'en'].includes(b.worker_lang) ? b.worker_lang : null, typeof b.self_delivery === 'boolean' ? b.self_delivery : null]);
    res.json({ ok: true });
  }));
  st.get('/offers', wrap(async (req, res) => res.json({ offers: await q(`select o.*, extract(epoch from (o.expires_at - now()))::int as seconds_left, r.payment_method, r.join_of is not null as joined, (c.home_store_id = o.store_id) as regular, c.name as customer_name from offers o join orders r on r.id=o.order_id join customers c on c.id=r.customer_id where o.store_id=$1 and o.status='pending' and o.expires_at > now() order by o.created_at`, [req.store.id]) })));
  st.post('/offers/:id', wrap(async (req, res) => res.json(await respondOffer(req.store.id, req.params.id, ['accept', 'partial', 'decline'].includes(req.body.action) ? req.body.action : 'decline', Array.isArray(req.body.missing) ? req.body.missing : []))));
  st.get('/parts', wrap(async (req, res) => {
    const scope = req.query.scope === 'today' ? `p.created_at::date = now()::date` : `(p.status in ('preparing','ready') or (p.status='picked' and o.status='delivering' and o.driver_id is null))`;
    const rows = await q(`select p.*, o.number, o.status as order_status, o.note, o.driver_id, o.delivery_code is not null as has_code, d.name as driver_name,
       (select count(*) from order_parts x where x.order_id=p.order_id and x.status <> 'cancelled')::int as parts_n
       from order_parts p join orders o on o.id=p.order_id left join drivers d on d.id=o.driver_id where p.store_id=$1 and ${scope} order by p.created_at desc limit 100`, [req.store.id]);
    const subs = await q(`select * from substitutions where part_id = any($1) and status='pending'`, [rows.map(r => r.id)]);
    res.json({ parts: rows.map(r => ({ ...r, pending_subs: subs.filter(s => s.part_id === r.id).map(s => s.item_index) })) });
  }));
  st.post('/parts/:id/ready', wrap(async (req, res) => res.json(await O.storePartReady(req.store, req.params.id))));
  st.post('/parts/:id/missing', wrap(async (req, res) => res.json(await O.storeItemMissing(req.store, req.params.id, Number(req.body.index)))));
  st.post('/parts/:id/substitute', wrap(async (req, res) => res.json(await O.proposeSubstitution(req.store, req.params.id, Number(req.body.index), req.body.product_id))));
  st.post('/parts/:id/self', wrap(async (req, res) => res.json(await O.storeSelfDeliver(req.store, req.params.id, req.body.action, req.body.code))));
  st.get('/products', wrap(async (req, res) => {
    const rows = await q(`select p.id, p.name_ar, p.size, p.unit, p.category, p.icon, p.image, p.name_ur, p.name_bn, p.name_hi, p.name_en, sp.price::float as price, sp.available, sp.confidence,
       (select round(avg(x.price)::numeric, 2)::float from store_products x where x.product_id=p.id) as market_avg
       from products p left join store_products sp on sp.product_id=p.id and sp.store_id=$1 where p.active order by p.category, p.name_ar`, [req.store.id]);
    res.json({ products: rows, categories: CAT_ORDER });
  }));
  st.put('/products/:pid', wrap(async (req, res) => {
    const price = num(req.body.price);
    if (!(price > 0 && price < 10000)) throw bad('اكتب سعر صحيح');
    const p = await one('select id from products where id=$1', [req.params.pid]);
    if (!p) throw new HttpError(404, 'المنتج غير موجود');
    const r = await one(`insert into store_products (store_id, product_id, price, available, confidence) values ($1,$2,$3,$4,0.9)
      on conflict (store_id, product_id) do update set price=excluded.price, available=excluded.available, confidence=greatest(store_products.confidence, case when excluded.available then 0.9 else 0 end), updated_at=now() returning *`, [req.store.id, p.id, price, req.body.available !== false]);
    res.json({ item: r });
  }));
  // صاحب البقالة يصوّر المنتج ويرفعه، والصورة تنعرض للعملاء بعد موافقة الإدارة
  st.post('/products/:pid/photo', wrap(async (req, res) => {
    const img = dataUrl(req.body.photo);
    if (!img || !/^image\/(jpeg|png|webp)$/.test(img.mime)) throw bad('أرسل صورة (JPG أو PNG)');
    const buf = Buffer.from(img.b64, 'base64');
    if (buf.length > 3 * 1024 * 1024) throw bad('الصورة كبيرة، صوّرها مرة ثانية');
    const p = await one('select id from products where id=$1', [req.params.pid]);
    if (!p) throw new HttpError(404, 'المنتج غير موجود');
    const name = crypto.randomUUID() + (img.mime === 'image/png' ? '.png' : img.mime === 'image/webp' ? '.webp' : '.jpg');
    if (process.env.UPLOADS_DIR) { fs.mkdirSync(UPLOADS, { recursive: true }); fs.writeFileSync(path.join(UPLOADS, name), buf); }
    res.json({ photo: await one('insert into product_photos (product_id, store_id, path, data, mime) values ($1,$2,$3,$4,$5) returning id, status', [p.id, req.store.id, '/img/u/' + name, buf, img.mime]) });
  }));
  st.delete('/products/:pid', wrap(async (req, res) => { await q('delete from store_products where store_id=$1 and product_id=$2', [req.store.id, req.params.pid]); res.json({ ok: true }); }));
  st.get('/earnings', wrap(async (req, res) => res.json({
    ledger: await q(`select l.kind, l.amount::float, l.settled, l.created_at, o.number from ledger l left join orders o on o.id=l.order_id where l.store_id=$1 order by l.created_at desc limit 100`, [req.store.id]),
    settlements: await q(`select * from settlements where party='store' and party_id=$1 order by created_at desc limit 20`, [req.store.id])
  })));
  st.get('/stream', (req, res) => sse(req, res, 'store:' + req.store.id));
  app.use('/api/store', st);

  // ---------- driver ----------
  const dr = express.Router(); dr.use(requireRole('driver'));
  dr.post('/push', wrap(async (req, res) => res.json(await subscribe('driver', req.driver.id, req.body))));
  dr.get('/me', wrap(async (req, res) => {
    const d = req.driver; const { pin_hash, ...pub } = d;
    const today = await one(`select count(*)::int n, coalesce(sum(driver_pay),0)::float pay from orders where driver_id=$1 and status='delivered' and delivered_at::date = now()::date`, [d.id]);
    const due = await one(`select coalesce(sum(amount),0)::float due from ledger where driver_id=$1 and settled=false and kind in ('driver_pay','driver_cash')`, [d.id]);
    res.json({ driver: pub, today, due: due.due });
  }));
  dr.post('/status', wrap(async (req, res) => {
    const lat = num(req.body.lat), lng = num(req.body.lng);
    await q(`update drivers set online=coalesce($2, online), lat=coalesce($3, lat), lng=coalesce($4, lng), seen_at=now() where id=$1`, [req.driver.id, typeof req.body.online === 'boolean' ? req.body.online : null, Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) { markRealGps(req.driver.id); await pushDriverPos(req.driver.id); }
    else if (typeof req.body.online === 'boolean') emit('admin', { type: 'driver', id: req.driver.id, online: req.body.online });
    if (req.body.online) await sweep();
    res.json({ ok: true });
  }));
  dr.get('/offers', wrap(async (req, res) => {
    const rows = await q(`select d.*, extract(epoch from (d.expires_at - now()))::int as seconds_left, o.number, o.lat, o.lng,
       (select json_agg(json_build_object('name', s.name, 'lat', s.lat, 'lng', s.lng)) from order_parts p join stores s on s.id=p.store_id where p.order_id=o.id and p.status <> 'cancelled') as stores
       from driver_offers d join orders o on o.id=d.order_id where d.driver_id=$1 and d.status='pending' and d.expires_at > now()`, [req.driver.id]);
    res.json({ offers: rows });
  }));
  dr.post('/offers/:id', wrap(async (req, res) => res.json(await respondDriver(req.driver.id, req.params.id, !!req.body.accept))));
  dr.get('/jobs', wrap(async (req, res) => {
    const orders = await q(`select o.id, o.number, o.status, o.lat, o.lng, o.address_details, o.note, o.driver_pay, o.payment_method, o.join_of is not null as joined, (o.paid_amount - o.refunded_amount)::float as collect, c.name as customer_name, c.phone as customer_phone from orders o join customers c on c.id=o.customer_id where o.driver_id=$1 and o.status in ('preparing','ready','delivering') order by o.created_at`, [req.driver.id]);
    const parts = await q(`select p.id, p.order_id, p.status, p.items, s.name as store_name, s.lat, s.lng, s.area from order_parts p join stores s on s.id=p.store_id where p.order_id = any($1) and p.status <> 'cancelled'`, [orders.map(o => o.id)]);
    res.json({ jobs: orders.map(o => ({ ...o, customer_phone: localPhone(o.customer_phone), parts: parts.filter(p => p.order_id === o.id).map(p => ({ ...p, count: p.items.filter(i => ['ok', 'sub'].includes(i.status)).reduce((a, i) => a + i.qty, 0) })) })) });
  }));
  dr.post('/parts/:id/pickup', wrap(async (req, res) => res.json(await O.driverPickup(req.driver, req.params.id))));
  dr.post('/orders/:id/deliver', wrap(async (req, res) => res.json(await O.driverDeliver(req.driver, req.params.id, req.body.code))));
  dr.get('/earnings', wrap(async (req, res) => res.json({
    week: await q(`select delivered_at::date as day, count(*)::int n, sum(driver_pay)::float pay from orders where driver_id=$1 and status='delivered' and delivered_at > now() - interval '7 days' group by 1 order by 1 desc`, [req.driver.id]),
    settlements: await q(`select * from settlements where party='driver' and party_id=$1 order by created_at desc limit 20`, [req.driver.id])
  })));
  dr.get('/stream', (req, res) => sse(req, res, 'driver:' + req.driver.id));
  app.use('/api/driver', dr);

  // ---------- admin ----------
  const ad = express.Router(); ad.use(requireRole('admin'));
  ad.post('/push', wrap(async (req, res) => res.json(await subscribe('admin', null, req.body))));
  // إشعار لكل العملاء (عرض، خصم، إعلان)
  ad.get('/push/stats', wrap(async (_req, res) => res.json(await one(`select count(*) filter (where role='customer')::int as customers, count(*) filter (where role='store')::int as stores, count(*) filter (where role='driver')::int as drivers from push_subs`))));
  ad.post('/push/broadcast', wrap(async (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 60), body = String(req.body.body || '').trim().slice(0, 180);
    if (!title || !body) throw bad('اكتب العنوان والرسالة');
    res.json({ sent: await pushTo('customer', null, { title, body, url: '/', tag: 'promo-' + Date.now() }) });
  }));
  ad.get('/readiness', wrap(async (_req, res) => {
    const c = await cfg(), sp = smsProvider();
    const n = await one(`select (select count(*)::int from stores where suspended=false) s, (select count(*)::int from drivers where suspended=false) d`);
    res.json({ checks: [
      { title: 'رسائل رمز الدخول (SMS)', ok: sp !== 'dev', note: sp !== 'dev' ? 'شغّال عن طريق ' + sp : 'ما فيه مزوّد. سجّل في تقنيات أو يونيفونك أو مسجات وحط بياناته في السيرفر' },
      { title: 'الدفع الإلكتروني (مدى وApple Pay)', ok: !!process.env.MOYASAR_SECRET_KEY, warn: !process.env.MOYASAR_SECRET_KEY && !!Number(c.cod_enabled), note: process.env.MOYASAR_SECRET_KEY ? 'ميسّر مربوط' : 'مو مربوط. العملاء يقدرون يدفعون عند الاستلام لين تربط ميسّر' },
      { title: 'الدفع عند الاستلام', ok: !!Number(c.cod_enabled), warn: true, note: Number(c.cod_enabled) ? 'شغّال لحد ' + c.cod_max + ' ريال للطلب' : 'مقفل' },
      { title: 'قاعدة البيانات', ok: dbKind() === 'postgres', note: dbKind() === 'postgres' ? 'Postgres' : 'محلية (PGlite). في الاستضافة لازم DATABASE_URL' },
      { title: 'وضع التجربة', ok: process.env.DEMO !== '1', note: process.env.DEMO === '1' ? 'شغّال: فيه بقالات ومناديب وهميين. خلّه DEMO=0' : 'مقفل، كل البيانات حقيقية' },
      { title: 'البقالات', ok: n.s >= 3, warn: n.s > 0 && n.s < 3, note: n.s + ' بقالة مسجّلة' + (n.s < 3 ? '، الأفضل 3 أو أكثر قبل الفتح' : '') },
      { title: 'المناديب', ok: n.d >= 2, warn: n.d === 1, note: n.d + ' مندوب مسجّل' + (n.d < 2 ? '، الأفضل 2 أو أكثر' : '') },
      { title: 'الإشعارات والتنبيهات', ok: !!pushKey(), note: 'رنّة الطلبات شغّالة، والإشعارات توصل والتطبيق مقفول' },
      { title: 'كلمة سر الإدارة', ok: String(process.env.ADMIN_TOKEN || '').length >= 20, note: String(process.env.ADMIN_TOKEN || '').length >= 20 ? 'قوية' : 'قصيرة، خلها 20 حرف أو أكثر' },
      { title: 'صور البقالات', ok: true, note: 'تنحفظ في قاعدة البيانات، ما تضيع مع التحديثات' }
    ] });
  }));
  ad.get('/live', wrap(async (_req, res) => res.json(await liveBoard())));
  ad.get('/overview', wrap(async (_req, res) => res.json(await overview())));
  ad.get('/orders', wrap(async (req, res) => res.json({ orders: await q(`select o.id, o.number, o.status, o.quote_total, o.final_total, o.refunded_amount, o.created_at, o.delivered_at, o.dispatch_round, c.phone, d.name as driver_name,
     (select string_agg(s.name, '، ') from order_parts p join stores s on s.id=p.store_id where p.order_id=o.id and p.status <> 'cancelled') as stores
     from orders o join customers c on c.id=o.customer_id left join drivers d on d.id=o.driver_id ${req.query.status ? 'where o.status=$1' : ''} order by o.created_at desc limit 200`, req.query.status ? [req.query.status] : []) })));
  ad.get('/stores', wrap(async (_req, res) => res.json({ stores: await q(`select s.id, s.name, s.owner_phone, s.area, s.lat, s.lng, s.is_open, s.self_delivery, s.suspended, s.commission_pct, s.offers_n, s.accepted_n, s.respond_n, s.respond_ms_sum, s.rating_sum, s.rating_n, (select count(*)::int from store_products sp where sp.store_id=s.id and sp.available) as products from stores s order by s.created_at`) })));
  ad.get('/geo', wrap(async (req, res) => res.json({ results: await geoSearch(req.query.q) })));
  ad.get('/geo/rev', wrap(async (req, res) => {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw bad('موقع غير صحيح');
    res.json(await geoReverse(lat, lng));
  }));
  // رابط قوقل ماب مختصر (maps.app.goo.gl): نفتحه من السيرفر ونطلع الإحداثيات منه
  ad.get('/maplink', wrap(async (req, res) => {
    const u = String(req.query.u || '').trim();
    if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/.test(u)) throw bad('الصق رابط من قوقل ماب');
    let text = u;
    try {
      const r = await fetch(u, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ar' }, signal: AbortSignal.timeout(8000) });
      text = r.url + ' ' + (await r.text()).slice(0, 200000);
    } catch { /* نحاول من الرابط نفسه */ }
    const m = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || text.match(/[?&](?:q|query|ll|center)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/) || text.match(/\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/);
    if (!m) throw bad('ما قدرنا نقرأ الموقع من الرابط. حدده على الخريطة');
    res.json({ lat: Number(m[1]), lng: Number(m[2]) });
  }));
  ad.post('/stores', wrap(async (req, res) => {
    const b = req.body, phone = normPhone(b.owner_phone), lat = num(b.lat), lng = num(b.lng);
    if (!b.name || !validSaudiMobile(phone)) throw bad('اسم البقالة وجوال صاحبها مطلوبين');
    if (!(lat > 16 && lat < 33 && lng > 34 && lng < 56)) throw bad('حدد موقع البقالة');
    if (!inZone(await cfg(), lat, lng, 100)) throw bad('البقالة برا حدود الحي اللي نخدمه. وسّع الحي من صفحة «الحي» أو اختر بقالة داخله');
    const dup = await one('select name from stores where owner_phone=$1', [phone]);
    if (dup) throw bad(`الرقم هذا مسجّل لبقالة «${dup.name}». تأكد من الرقم، أو شوف البقالة في الجدول فوق`);
    const s = await one('insert into stores (name, owner_phone, pin_hash, lat, lng, area, self_delivery) values ($1,$2,$3,$4,$5,$6,$7) returning id, name', [b.name, phone, hashSecret(crypto.randomBytes(16).toString('hex')), lat, lng, b.area || null, !!b.self_delivery]);
    if (b.starter_prices) {
      const prods = (await q('select id, name_ar, size from products where active')).map(p => ({ id: p.id, price: basePrice(p.name_ar, p.size) })).filter(p => p.price);
      // دفعة وحدة بدل استعلام لكل منتج (أسرع بكثير لما القاعدة بعيدة)
      for (let i = 0; i < prods.length; i += 200) {
        const part = prods.slice(i, i + 200), vals = part.map((_, k) => `($1,$${k * 2 + 2},$${k * 2 + 3},true,0.6)`).join(',');
        await q(`insert into store_products (store_id, product_id, price, available, confidence) values ${vals} on conflict do nothing`, [s.id, ...part.flatMap(p => [p.id, p.price])]);
      }
    }
    sendSms(phone, `هلا! ${b.name} صارت في جارك. ادخل تطبيقك من ${baseUrl(req)}/store/ برقم جوالك هذا، ويوصلك رمز الدخول.`).catch(e => console.error('[sms]', e.message));
    res.json({ store: s });
  }));
  ad.patch('/stores/:id', wrap(async (req, res) => {
    const b = req.body;
    await q('update stores set suspended=coalesce($2,suspended), commission_pct=$3 where id=$1', [req.params.id, typeof b.suspended === 'boolean' ? b.suspended : null, b.commission_pct === '' || b.commission_pct == null ? null : num(b.commission_pct)]);
    res.json({ ok: true });
  }));
  ad.get('/drivers', wrap(async (_req, res) => res.json({ drivers: await q(`select id, name, phone, company, online, seen_at, rating_sum, rating_n, (select count(*)::int from orders o where o.driver_id=d.id and o.status='delivered') as delivered from drivers d order by created_at`) })));
  ad.post('/drivers', wrap(async (req, res) => {
    const phone = normPhone(req.body.phone);
    if (!req.body.name || !validSaudiMobile(phone)) throw bad('اسم المندوب وجواله مطلوبين');
    const dupD = await one('select name from drivers where phone=$1', [phone]);
    if (dupD) throw bad(`الرقم هذا مسجّل للمندوب «${dupD.name}»`);
    const d = await one('insert into drivers (name, phone, pin_hash, company) values ($1,$2,$3,$4) returning id, name', [req.body.name, phone, hashSecret(crypto.randomBytes(16).toString('hex')), req.body.company || null]);
    sendSms(phone, `هلا ${req.body.name}! صرت كابتن في جارك. ادخل من ${baseUrl(req)}/driver/ برقم جوالك هذا، ويوصلك رمز الدخول.`).catch(e => console.error('[sms]', e.message));
    res.json({ driver: d });
  }));
  ad.patch('/drivers/:id', wrap(async (req, res) => { await q('update drivers set suspended=$2, online=case when $2 then false else online end where id=$1', [req.params.id, !!req.body.suspended]); res.json({ ok: true }); }));
  const pubCfg = (c) => { const { gemini_api_key, ...rest } = c; return { ...rest, gemini_key_set: !!gemini_api_key || !!process.env.GEMINI_API_KEY, gemini_key_hint: gemini_api_key ? '••••' + gemini_api_key.slice(-4) : process.env.GEMINI_API_KEY ? 'من متغيرات السيرفر' : '' }; };
  ad.get('/config', wrap(async (_req, res) => res.json({ config: pubCfg(await cfg()), defaults: DEFAULTS })));
  ad.patch('/config', wrap(async (req, res) => res.json({ config: pubCfg(await setCfg(req.body || {})) })));
  ad.post('/ai/test', wrap(async (req, res) => {
    try { const r = await testAi(String(req.body.text || 'ابي ثنين حليب المراعي وكرتون موية وخبز')); res.json({ ok: true, mode: r.mode, items: r.items, reply: r.reply }); }
    catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  }));
  ad.get('/zone', wrap(async (_req, res) => {
    const c = await cfg();
    res.json({ zone: zoneOf(c), stores: (await q('select id, name, lat, lng, is_open, suspended from stores')).map(s => ({ ...s, in_zone: inZone(c, s.lat, s.lng, 100) })),
      waitlist: await q(`select w.lat, w.lng, w.details, w.created_at, c.phone from waitlist w join customers c on c.id=w.customer_id order by w.created_at desc limit 500`) });
  }));
  ad.post('/settlements/run', wrap(async (_req, res) => res.json({ created: await O.createSettlements() })));
  ad.get('/settlements', wrap(async (_req, res) => res.json({ settlements: await q(`select x.*, coalesce(s.name, d.name) as party_name from settlements x left join stores s on x.party='store' and s.id=x.party_id left join drivers d on x.party='driver' and d.id=x.party_id order by x.created_at desc limit 200`) })));
  ad.post('/settlements/:id/paid', wrap(async (req, res) => res.json({ settlement: await one(`update settlements set status='paid', paid_at=now() where id=$1 returning *`, [req.params.id]) })));
  ad.get('/photos', wrap(async (_req, res) => res.json({ photos: await q(`select ph.id, ph.path, ph.status, ph.created_at, p.name_ar, p.size, p.image as current, s.name as store_name from product_photos ph join products p on p.id=ph.product_id left join stores s on s.id=ph.store_id where ph.status='pending' order by ph.created_at desc limit 100`) })));
  ad.post('/photos/:id', wrap(async (req, res) => {
    const ph = await one(`update product_photos set status=$2 where id=$1 and status='pending' returning *`, [req.params.id, req.body.approve ? 'approved' : 'rejected']);
    if (!ph) throw new HttpError(404, 'الصورة غير موجودة');
    if (req.body.approve) await q('update products set image=$2 where id=$1', [ph.product_id, ph.path]);
    res.json({ ok: true });
  }));
  ad.get('/complaints', wrap(async (_req, res) => res.json({ complaints: await q(`select c.id, c.kind, c.note, c.refund, c.created_at, o.number, s.name as store_name, c.photo is not null as has_photo from complaints c join orders o on o.id=c.order_id left join order_parts p on p.id=c.part_id left join stores s on s.id=p.store_id order by c.created_at desc limit 100`) })));
  ad.get('/stream', (req, res) => sse(req, res, 'admin'));
  app.use('/api/admin', ad);

  // ---------- errors ----------
  app.use('/api', (_req, res) => res.status(404).json({ error: 'غير موجود' }));
  app.use((err, _req, res, _next) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.extra || {}), ...(err.quote ? { quote: err.quote } : {}) });
    console.error('[error]', _req.method, _req.originalUrl, err);
    const forAdmin = String(_req.originalUrl || '').startsWith('/api/admin');
    res.status(500).json({ error: 'صار خطأ عندنا، جرّب مرة ثانية' + (forAdmin ? ' (التفاصيل: ' + String(err.message || err).slice(0, 160) + ')' : '') });
  });

  app.use('/img/u', express.static(UPLOADS, { maxAge: '30d' }));
  app.get('/img/u/:name', wrap(async (req, res, next) => {
    const r = await one('select data, mime from product_photos where path=$1 and data is not null', ['/img/u/' + String(req.params.name).slice(0, 80)]);
    if (!r) return next();
    res.set('Content-Type', r.mime || 'image/jpeg').set('Cache-Control', 'public, max-age=2592000').send(Buffer.from(r.data));
  }));
  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));
  if (!process.env.JARAK_NO_TIMERS) { const t = setInterval(() => sweep().catch(e => console.error('[sweep]', e)), 5000); t.unref?.(); }
  if (!process.env.JARAK_NO_TIMERS && process.env.DEMO === '1') { const t2 = setInterval(() => simTick(2).catch(e => console.error('[sim]', e)), 2000); t2.unref?.(); }
  return app;
}

// the 8 numbers from the plan
export async function overview() {
  const daily = await q(`select created_at::date as day, count(*)::int n from orders where status='delivered' and created_at > now() - interval '30 days' group by 1 order by 1`);
  const t = await one(`select
     count(*) filter (where status='delivered' and delivered_at::date = now()::date)::int as delivered_today,
     count(*) filter (where status in ('searching','preparing','ready','delivering'))::int as live,
     avg(extract(epoch from (delivered_at - paid_at))/60) filter (where status='delivered' and delivered_at > now() - interval '30 days')::float as avg_delivery_min,
     avg(final_total) filter (where status='delivered' and delivered_at > now() - interval '30 days')::float as aov,
     count(*) filter (where status='delivered' and delivered_at > now() - interval '30 days')::int as delivered_30,
     count(*) filter (where status='cancelled' and created_at > now() - interval '30 days')::int as cancelled_30,
     sum(final_total) filter (where status='delivered' and delivered_at > now() - interval '30 days')::float as gmv_30
     from orders`);
  const resp = await one(`select sum(respond_ms_sum)::float / nullif(sum(respond_n),0) / 1000 as avg_s, sum(rating_sum)::float / nullif(sum(rating_n),0) as rating from stores`);
  const comp = await one(`select count(*)::int n from complaints where created_at > now() - interval '30 days'`);
  const rep = await one(`select count(*) filter (where n >= 2)::int as repeat, count(*)::int as total from (select customer_id, count(*) n from orders where status='delivered' and delivered_at > now() - interval '30 days' group by 1) x`);
  const money = await one(`select
     coalesce(sum(amount) filter (where kind='commission'),0)::float as commission,
     coalesce(sum(amount) filter (where kind='delivery_fee'),0)::float as delivery_fee,
     coalesce(sum(amount) filter (where kind='driver_pay'),0)::float as driver_pay,
     coalesce(sum(amount) filter (where kind='price_gap'),0)::float as price_gap,
     coalesce(sum(amount) filter (where kind='promo'),0)::float as promo
     from ledger where created_at > now() - interval '30 days'`);
  const margin = money.commission + money.delivery_fee - money.driver_pay + money.price_gap + money.promo;
  return {
    daily, ...t,
    store_response_s: resp.avg_s, store_rating: resp.rating,
    complaint_rate: t.delivered_30 ? comp.n / t.delivered_30 : null,
    repeat_rate: rep.total ? rep.repeat / rep.total : null,
    money, margin_30: round2(margin), margin_per_order: t.delivered_30 ? round2(margin / t.delivered_30) : null
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`جارك شغّال على http://localhost:${port}  (db: ${dbKind()}, ai: ${aiEnabled() ? 'Gemini' : 'تجريبي'}, دفع: ${paymentMode()})`));
}
export { clearTimers };
