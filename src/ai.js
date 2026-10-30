// فهم الطلب باللهجة السعودية: فويس أو كتابة أو صورة ورقة مقاضي -> سلة
import { q } from './db.js';
import { mockParse } from './mockai.js';
import { cfgSync } from './config.js';

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const aiKey = () => process.env.GEMINI_API_KEY || cfgSync().gemini_api_key || '';
export const aiEnabled = () => !!aiKey();

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: ['order', 'repeat_last', 'other'] },
    transcript: { type: 'STRING' },
    items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { ref: { type: 'STRING' }, qty: { type: 'NUMBER' } }, required: ['ref', 'qty'] } },
    not_found: { type: 'ARRAY', items: { type: 'STRING' } },
    reply: { type: 'STRING' }
  },
  required: ['intent', 'items', 'not_found']
};

const SYSTEM = `أنت مساعد طلبات في تطبيق «جارك» لتوصيل البقالة في السعودية. العميل يقول طلبه باللهجة السعودية (فويس أو كتابة أو صورة ورقة مقاضي).
حوّل كلامه لقائمة منتجات من الكتالوج فقط، وارجع رمز كل منتج في ref.
- افهم اللهجة: موية/ماي = ماء، عيش = رز، صامولي/تميس/خبز، شاهي = شاي، حبتين/ثنتين = 2، درزن = 12، كرتون، باكت، طبق بيض.
- لو قال اسم ماركة (المراعي، نادك، نوفا) اختر منتجها. لو ما حدد الحجم اختر الأشهر.
- لا تخترع منتج. اللي مو في الكتالوج اكتبه في not_found بكلام العميل.
- «نفس طلبي/زي المرة اللي فاتت» = intent repeat_last.
- transcript = كلام العميل كنص عربي.
- reply = جملة قصيرة باللهجة السعودية تأكد فيها وش فهمت.`;

export async function catalogRefs() {
  const rows = await q('select id, name_ar, size, unit, category, aliases from products where active order by category, name_ar');
  rows.forEach((p, i) => { p.ref = 'p' + (i + 1); p.in_stock = true; });
  return rows;
}


async function geminiParse(cat, { text, audio, image }) {
  let r;
  const parts = [{ text: 'الكتالوج (ref | الاسم | الحجم | الوحدة | أسماء دارجة):\n' + cat.map(p => [p.ref, p.name_ar, p.size || '', p.unit, (p.aliases || []).join('/')].join(' | ')).join('\n') }];
  if (text) parts.push({ text: 'كلام العميل: ' + text });
  if (audio) parts.push({ text: 'فويس العميل:' }, { inline_data: { mime_type: audio.mime, data: audio.b64 } });
  if (image) parts.push({ text: 'صورة من العميل:' }, { inline_data: { mime_type: image.mime, data: image.b64 } });
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODEL() + ':generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': aiKey() },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: SCHEMA } })
  });
  if (!res.ok) throw new Error('Gemini ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  r = JSON.parse(j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}');
  r.mode = 'ai';
  return r;
}

export async function parseBasket({ text, audio, image }) {
  const cat = await catalogRefs();
  let r;
  let useAi = aiEnabled();
  if (useAi) {
    try { r = await geminiParse(cat, { text, audio, image }); }
    catch (e) {
      // المفتاح غلط أو الخدمة واقفة: ما نوقف العميل، نكمّل بالفهم الأساسي لو عندنا نص
      console.error('[ai]', e.message);
      if (!text) throw Object.assign(new Error('ما قدرنا نفهم التسجيل الحين، اكتب طلبك أو قوله بالمايك'), { status: 503 });
      useAi = false;
    }
  }
  if (!useAi) {
    if (!text) return { intent: 'other', items: [], not_found: [], reply: 'الصور والتسجيلات تحتاج مفتاح الذكاء الاصطناعي. قول طلبك بالمايك أو اكتبه.', mode: 'offline' };
    r = mockParse({ text, catalog: cat });
    r.reply = r.items.length ? 'تمام، هذي سلتك. راجعها وكمّل.' : 'ما لقيت منتجات واضحة، جرّب تكتبها بطريقة ثانية.';
    r.mode = 'offline';
  }
  const byRef = new Map(cat.map(p => [p.ref, p]));
  const items = [];
  for (const it of r.items || []) {
    const p = byRef.get(String(it.ref)); const qty = Math.round(Number(it.qty));
    if (!p || !(qty > 0)) continue;
    const ex = items.find(x => x.product_id === p.id);
    if (ex) ex.qty += qty; else items.push({ product_id: p.id, name_ar: p.name_ar, size: p.size, qty: Math.min(qty, 99) });
  }
  const notFound = (r.not_found || []).map(x => typeof x === 'string' ? x : x.asked).filter(Boolean);
  return { intent: r.intent || 'order', transcript: r.transcript || text || '', items, not_found: notFound, reply: r.reply || '', mode: r.mode };
}

// للإدارة: يجرّب المفتاح نفسه بدون الرجوع للفهم الأساسي، عشان يبين لو المفتاح غلط
export async function testAi(text) {
  if (!aiEnabled()) return parseBasket({ text });
  const cat = await catalogRefs();
  const r = await geminiParse(cat, { text });
  const byRef = new Map(cat.map(p => [p.ref, p]));
  return { mode: 'ai', reply: r.reply, items: (r.items || []).map(i => byRef.get(String(i.ref)) && { name_ar: byRef.get(String(i.ref)).name_ar, qty: i.qty }).filter(Boolean) };
}
