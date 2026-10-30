import { imageFor } from './images.js';
// بيانات تجريبية: كتالوج سعودي + 6 بقالات في حي العقربية بالخبر + 3 مناديب
import { q, one } from '../src/db.js';
import { STARTER } from './starter.js';
import { hashSecret } from '../src/util.js';

const ICON = { 'ألبان': '🥛', 'مشروبات': '🥤', 'مخبوزات': '🍞', 'أرز وبقوليات': '🍚', 'زيوت': '🫒', 'معلبات': '🥫', 'مجمدات': '🧊', 'سناكات': '🍫', 'خضار وفواكه': '🥬', 'منظفات': '🧴', 'عناية شخصية': '🧼', 'أخرى': '🛒' };
export const CAT_ORDER = ['ألبان', 'مخبوزات', 'مشروبات', 'أرز وبقوليات', 'زيوت', 'معلبات', 'مجمدات', 'خضار وفواكه', 'سناكات', 'منظفات', 'عناية شخصية', 'أخرى'];

export async function seedCatalog() {
  const n = await one('select count(*)::int n from products');
  if (n.n) {
    // قواعد بيانات قديمة: نعطي كل منتج صورته، ونبدّل الأيقونة بالصورة الحقيقية لو توفرت
    // (صور البقالات المعتمدة /img/u ما نلمسها)
    const rows = await q("select id, name_ar, size, category, image from products where image is null or image like '/img/p/%' or image like '/img/off/%'");
    for (const p of rows) { const img = imageFor(p.name_ar, p.category, p.size); if (img !== p.image) await q('update products set image=$2 where id=$1', [p.id, img]); }
    return 0;
  }
  for (const r of STARTER) {
    const [name_ar, size, unit, , category, aliases, en, ur, bn, hi] = r;
    await q('insert into products (name_ar, size, unit, category, aliases, icon, name_en, name_ur, name_bn, name_hi, image) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [name_ar, size, unit, category, aliases, ICON[category] || '🛒', en, ur, bn, hi, imageFor(name_ar, category, size)]);
  }
  return STARTER.length;
}
export const basePrice = (name, size) => { const r = STARTER.find(x => x[0] === name && x[1] === size); return r ? r[3] : null; };

// deterministic pseudo-random so demo data is the same every run
function rng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

export const DEMO_STORES = [
  { name: 'بقالة النور', phone: '0500000001', lat: 26.2860, lng: 50.2080, area: 'العقربية، الخبر', priceFactor: 0.97, coverage: 0.92, self: false },
  { name: 'تموينات الهدى', phone: '0500000002', lat: 26.2838, lng: 50.2121, area: 'العقربية، الخبر', priceFactor: 1.00, coverage: 0.85, self: true },
  { name: 'بقالة الريان', phone: '0500000003', lat: 26.2889, lng: 50.2049, area: 'العقربية، الخبر', priceFactor: 1.04, coverage: 0.95, self: false },
  { name: 'ميني ماركت الفجر', phone: '0500000004', lat: 26.2811, lng: 50.2090, area: 'العقربية، الخبر', priceFactor: 0.95, coverage: 0.70, self: false },
  { name: 'بقالة السلام', phone: '0500000005', lat: 26.2905, lng: 50.2132, area: 'العقربية، الخبر', priceFactor: 1.02, coverage: 0.88, self: false },
  { name: 'مخبز وتموينات الأصيل', phone: '0500000006', lat: 26.2850, lng: 50.2160, area: 'العقربية، الخبر', priceFactor: 0.99, coverage: 0.55, self: false }
];
export const DEMO_DRIVERS = [
  { name: 'سعيد (بوارق)', phone: '0510000001', lat: 26.2850, lng: 50.2100 },
  { name: 'عمر (بوارق)', phone: '0510000002', lat: 26.2880, lng: 50.2070 },
  { name: 'فهد (بوارق)', phone: '0510000003', lat: 26.2820, lng: 50.2140 }
];
const norm = (p) => '966' + p.slice(1);

export async function seedDemo() {
  await seedCatalog();
  const has = await one('select count(*)::int n from stores');
  if (has.n) return;
  const products = await q('select * from products');
  let i = 0;
  for (const s of DEMO_STORES) {
    const st = await one('insert into stores (name, owner_phone, pin_hash, lat, lng, area, self_delivery) values ($1,$2,$3,$4,$5,$6,$7) returning *', [s.name, norm(s.phone), hashSecret('1234'), s.lat, s.lng, s.area, s.self]);
    const r = rng(1000 + i++ * 77);
    for (const p of products) {
      if (r() > s.coverage) continue;
      const base = basePrice(p.name_ar, p.size) || 5;
      const price = Math.max(0.5, Math.round(base * s.priceFactor * (0.96 + r() * 0.08) * 4) / 4);
      await q('insert into store_products (store_id, product_id, price, available) values ($1,$2,$3,$4)', [st.id, p.id, price, r() > 0.04]);
    }
  }
  for (const d of DEMO_DRIVERS) await q('insert into drivers (name, phone, pin_hash, company, lat, lng) values ($1,$2,$3,$4,$5,$6)', [d.name, norm(d.phone), hashSecret('1234'), 'بوارق الشرق', d.lat, d.lng]);
  await q(`insert into promos (code, amount) values ('JARAK10', 10) on conflict do nothing`);
}
