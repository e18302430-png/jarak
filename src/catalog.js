// الأسعار والبقالات القريبة والتسعيرة
import { q, one } from './db.js';
import { cfg } from './config.js';
import { distM, round2 } from './util.js';
import { BUNDLES } from '../seed/bundles.js';

// الزون: نخدم حي واحد بس. العميل والبقالة لازم يكونون داخله
export const zoneOf = (c) => ({ name: c.zone_name, lat: Number(c.zone_lat), lng: Number(c.zone_lng), radius_m: Number(c.zone_radius_m) });
export const inZone = (c, lat, lng, grace = 0) => distM(Number(c.zone_lat), Number(c.zone_lng), lat, lng) <= Number(c.zone_radius_m) + grace;

export async function nearbyStores(lat, lng, radius, { includeClosed = false } = {}) {
  const c = await cfg();
  if (!inZone(c, lat, lng, 50)) return [];
  const rows = await q(`select * from stores where suspended = false ${includeClosed ? '' : 'and is_open = true'}`);
  return rows.filter(s => inZone(c, s.lat, s.lng, 100)).map(s => ({ ...s, dist: distM(lat, lng, s.lat, s.lng) })).filter(s => s.dist <= radius).sort((a, b) => a.dist - b.dist);
}

export const reliability = (s) => {
  const acc = s.offers_n ? s.accepted_n / s.offers_n : 0.8;
  const rating = s.rating_n ? s.rating_sum / s.rating_n / 5 : 0.9;
  return 0.6 * acc + 0.4 * rating;
};

// what each nearby store can supply of these items and at what price
export async function storeCoverage(stores, items) {
  if (!stores.length || !items.length) return [];
  const ids = items.map(i => i.product_id);
  const rows = await q(`select * from store_products where store_id = any($1) and product_id = any($2) and available = true and confidence >= 0.25`, [stores.map(s => s.id), ids]);
  return stores.map(s => {
    const mine = rows.filter(r => r.store_id === s.id);
    const covered = [], missing = [];
    for (const it of items) {
      const sp = mine.find(r => r.product_id === it.product_id);
      if (sp) covered.push({ ...it, price: Number(sp.price), confidence: sp.confidence }); else missing.push(it);
    }
    const total = round2(covered.reduce((a, c) => a + c.price * c.qty, 0));
    return { store: s, covered, missing, total, full: missing.length === 0 };
  });
}

// cheapest sensible plan: one store if possible, else a split between nearby stores
// البقالة الثانية تدخل الطلب بس لو كانت على طريق المندوب من البقالة الأولى لبيت العميل
export const detour = (a, b, home) => distM(a.lat, a.lng, b.lat, b.lng) + distM(b.lat, b.lng, home.lat, home.lng) - distM(a.lat, a.lng, home.lat, home.lng);
export const onTheWay = (a, b, home, c) => detour(a, b, home) <= Number(c.detour_max_m) && distM(a.lat, a.lng, b.lat, b.lng) <= c.split_max_m;
export async function quote(lat, lng, items, opt = {}) {
  const c = await cfg();
  if (!inZone(c, lat, lng, 50)) { const e = new Error('عنوانك برا حي ' + c.zone_name + '، وحالياً نخدم هذا الحي بس'); e.status = 422; e.code = 'outside_zone'; throw e; }
  const stores = await nearbyStores(lat, lng, c.radius_m);
  const cov = await storeCoverage(stores, items);
  const score = (x) => x.total + x.store.dist / 500 * 0.5 - reliability(x.store) * 2;
  const full = cov.filter(x => x.full).sort((a, b) => score(a) - score(b));
  const pref = opt.prefer ? cov.find(x => x.store.id === opt.prefer) : null;
  let plan;
  if (opt.exclusive) plan = pref && pref.covered.length ? [{ store: pref.store, items: pref.covered }] : [];
  else if (pref && pref.full) plan = [{ store: pref.store, items: pref.covered }];
  else if (full.length) plan = [{ store: full[0].store, items: full[0].covered }];
  else {
    plan = []; let left = items.slice();
    const pool = cov.slice();
    while (left.length && plan.length < 3) {
      const anchor = plan[0] && plan[0].store;
      const opts = pool.filter(x => !plan.some(p => p.store.id === x.store.id) && (!anchor || onTheWay(anchor, x.store, { lat, lng }, c)))
        .map(x => ({ x, got: x.covered.filter(i => left.some(l => l.product_id === i.product_id)) })).filter(o => o.got.length)
        .sort((a, b) => b.got.length - a.got.length || score(a.x) - score(b.x));
      if (!opts.length) break;
      plan.push({ store: opts[0].x.store, items: opts[0].got });
      left = left.filter(l => !opts[0].got.some(g => g.product_id === l.product_id));
    }
  }
  const priced = items.map(it => {
    const p = plan.find(pp => pp.items.some(i => i.product_id === it.product_id));
    const hit = p && p.items.find(i => i.product_id === it.product_id);
    return { ...it, quote_price: hit ? hit.price : null, store_id: p ? p.store.id : null };
  });
  const available = priced.filter(i => i.quote_price != null);
  const unavailable = priced.filter(i => i.quote_price == null);
  const subtotal = round2(available.reduce((a, i) => a + i.quote_price * i.qty, 0));
  const delivery = available.length ? (opt.fee != null ? opt.fee : subtotal >= c.free_delivery_over ? 0 : c.delivery_fee) : 0;
  return {
    items: available, unavailable, subtotal, delivery_fee: delivery, total: round2(subtotal + delivery),
    stores: plan.map(p => ({ id: p.store.id, name: p.store.name, dist: Math.round(p.store.dist), count: p.items.length })),
    min_order: opt.min != null ? opt.min : c.min_order, free_delivery_over: c.free_delivery_over, nearby: stores.length
  };
}

// home screen: each product with the lowest nearby price
export async function listing(lat, lng) {
  const c = await cfg();
  const stores = await nearbyStores(lat, lng, c.radius_m);
  const ids = stores.map(s => s.id);
  const rows = await q(`select p.id, p.name_ar, p.size, p.unit, p.category, p.icon, p.image, p.aliases, min(sp.price)::float as min_price, round(avg(sp.price)::numeric, 2)::float as avg_price, count(sp.store_id)::int as stores
     from products p join store_products sp on sp.product_id = p.id
     where p.active and sp.available and sp.confidence >= 0.25 and sp.store_id = any($1)
     group by p.id order by p.category, p.name_ar`, [ids.length ? ids : ['00000000-0000-0000-0000-000000000000']]);
  const byKey = new Map(rows.map(r => [r.name_ar + '|' + (r.size || ''), r]));
  const bundles = BUNDLES.map(b => {
    const items = b.items.map(([n, sz, qty]) => { const p = byKey.get(n + '|' + sz); return p && { product_id: p.id, qty, price: p.min_price }; }).filter(Boolean);
    return { id: b.id, title: b.title, sub: b.sub, image: '/img/p/' + b.image + '.webp', photo: b.photo || null, color: b.color, items: items.map(({ product_id, qty }) => ({ product_id, qty })), total: Math.round(items.reduce((a, i) => a + i.price * i.qty, 0) * 100) / 100, complete: items.length === b.items.length };
  }).filter(b => b.items.length >= 3);
  return { products: rows, bundles, stores: stores.map(s => ({ id: s.id, name: s.name, dist: Math.round(s.dist), area: s.area })) };
}
