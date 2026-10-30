// Offline order parser: used in the simulator and tests when no AI key is set.
// It is intentionally simple; production uses Gemini (ai.js).
import { norm, numWord, STOP } from './arabic.js';

function score(seg, p) {
  const words = seg.split(' ').filter(w => w && !STOP.has(w) && numWord(w) === null);
  if (!words.length) return 0;
  const hay = [p.name_ar, p.brand, p.size, ...(p.aliases || [])].filter(Boolean).map(norm);
  let s = 0;
  for (const w of words) {
    const bare = w.replace(/^ال/, '');
    if (hay.some(h => h === w || h.split(' ').includes(w))) s += 3;
    else if (bare.length > 2 && hay.some(h => h.includes(bare))) s += 2;
  }
  for (const a of (p.aliases || [])) if (seg.includes(norm(a))) s += 4;
  return s;
}

export function mockParse({ text, catalog, draft = [], lastOrder = [] }) {
  const t = norm(text);
  if (!t) return { intent: 'other', items: draft.map(d => ({ ref: d.ref, qty: d.qty })), not_found: [], reply: 'ما وصلني شي، اكتب طلبك أو أرسله فويس.' };
  if (/(الغ|كنسل|ما ابي شي|لا خلاص)/.test(t)) return { intent: 'cancel', items: [], not_found: [] };
  if (/(نفس الطلب|نفس طلب|زي المره|نفس المره|كرر|اللي طلبته)/.test(t)) return { intent: 'repeat_last', items: lastOrder.map(d => ({ ref: d.ref, qty: d.qty })), not_found: [] };
  if (/(متى|كم التوصيل|رسوم التوصيل|الدوام|فاتحين|توصلون|اوقات)/.test(t) && !/\d/.test(t)) return { intent: 'question', items: draft.map(d => ({ ref: d.ref, qty: d.qty })), not_found: [], reply: '' };

  const items = new Map(draft.map(d => [d.ref, d.qty]));
  const notFound = [];
  // نقسم النص الأصلي على الفواصل والأسطر قبل التنظيف (التنظيف يشيل الفواصل)
  const segs = String(text).split(/\s*(?:،|,|\n|\+|؛|;|-\s)\s*/).map(norm).flatMap(s => s.split(/ و(?=\S)| وكمان | و /)).map(s => s.trim()).filter(Boolean);
  let matched = 0;
  for (const seg of segs) {
    const remove = /^(شيل|بدون|احذف|امسح|لا تجيب)(\s|$)/.test(seg);
    let qty = null;
    for (const w of seg.split(' ')) { const n = numWord(w); if (n !== null) { qty = n; break; } }
    if (qty === null && /(كرتونين|حبتين|ثنتين|علبتين|كيسين|باكتين|طبقين|قارورتين|شدتين|كيلوين|حزمتين|علبتين)/.test(seg)) qty = 2;
    let best = null, bs = 0;
    for (const p of catalog) { let s = score(seg, p); if (s > 0 && items.has(p.ref)) s += 5; if (s > bs) { bs = s; best = p; } }
    if (!best || bs < 2) {
      const words = seg.split(' ').filter(w => !STOP.has(w) && numWord(w) === null);
      if (words.length && !/^(السلام|هلا|مرحبا|شكرا|الله)/.test(seg)) notFound.push({ asked: words.join(' '), suggestion_refs: [] });
      continue;
    }
    matched++;
    if (remove) { items.delete(best.ref); continue; }
    if (!best.in_stock) { notFound.push({ asked: best.name_ar + ' (خلصان)', suggestion_refs: catalog.filter(p => p.in_stock && p.category === best.category && p.ref !== best.ref).slice(0, 2).map(p => p.ref) }); continue; }
    const add = /^(زد|زيد|ضيف|كمان)(\s|$)/.test(seg);
    items.set(best.ref, add ? (items.get(best.ref) || 0) + (qty || 1) : (qty || items.get(best.ref) || 1));
  }
  if (!matched && !notFound.length && /^(السلام|هلا|مرحبا|الو)/.test(t)) return { intent: 'greeting', items: draft.map(d => ({ ref: d.ref, qty: d.qty })), not_found: [], reply: '' };
  return { intent: 'order', transcript: text, items: [...items].map(([ref, qty]) => ({ ref, qty })), not_found: notFound };
}
