// البحث عن الأحياء والأماكن في السعودية: OpenStreetMap (Nominatim) + Photon، من السيرفر عشان يكون ثابت
const UA = () => 'Jarak/1.0 (' + (process.env.PUBLIC_URL || 'jarak.onrender.com') + ')';
const SA = { minLat: 16, maxLat: 32.3, minLng: 34.4, maxLng: 55.8 };
const cache = new Map();
const inSA = (lat, lng) => lat > SA.minLat && lat < SA.maxLat && lng > SA.minLng && lng < SA.maxLng;

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA(), 'Accept-Language': 'ar,en' }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('geo ' + r.status);
  return r.json();
}
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const noHay = (s) => clean(s).replace(/^(حي|حى|ح\.)\s*/, '');

function fromNominatim(x) {
  const a = x.address || {};
  const name = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.residential || x.name || String(x.display_name).split(',')[0];
  const city = a.city || a.town || a.village || a.county || a.state || '';
  return { name: clean(name), city: clean(city), lat: Number(x.lat), lng: Number(x.lon), kind: x.addresstype || x.type };
}
function fromPhoton(f) {
  const p = f.properties || {}, [lng, lat] = f.geometry.coordinates;
  return { name: clean(p.name || p.district || p.street), city: clean(p.city || p.county || p.state || ''), lat, lng, kind: p.osm_value || p.type };
}

export async function geoSearch(qs) {
  const q = clean(qs).slice(0, 80);
  if (q.length < 2) return [];
  if (cache.has('s:' + q)) return cache.get('s:' + q);
  const base = noHay(q);
  const variants = [...new Set([q, base, 'حي ' + base])];
  const jobs = variants.map(v => getJson('https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=sa&accept-language=ar&addressdetails=1&limit=8&q=' + encodeURIComponent(v)).then(r => r.map(fromNominatim)).catch(() => []));
  jobs.push(getJson(`https://photon.komoot.io/api/?limit=10&bbox=${SA.minLng},${SA.minLat},${SA.maxLng},${SA.maxLat}&q=` + encodeURIComponent(base)).then(r => (r.features || []).map(fromPhoton)).catch(() => []));
  const all = (await Promise.all(jobs)).flat().filter(x => x.name && inSA(x.lat, x.lng));
  // الأحياء أول، وبعدها اللي اسمه يطابق، وبدون تكرار
  const rank = (x) => (/suburb|neighbourhood|quarter|residential|city_district|district/.test(x.kind) ? 0 : 2) + (noHay(x.name).includes(base) ? 0 : 1);
  const seen = new Set(), out = [];
  for (const x of all.sort((a, b) => rank(a) - rank(b))) {
    const k = noHay(x.name) + '|' + x.city + '|' + x.lat.toFixed(2) + x.lng.toFixed(2);
    if (seen.has(k)) continue; seen.add(k); out.push(x);
    if (out.length >= 10) break;
  }
  cache.set('s:' + q, out); if (cache.size > 500) cache.delete(cache.keys().next().value);
  return out;
}

export async function geoReverse(lat, lng) {
  const k = 'r:' + lat.toFixed(4) + ',' + lng.toFixed(4);
  if (cache.has(k)) return cache.get(k);
  let r = null;
  try {
    const x = await getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ar&addressdetails=1&zoom=16&lat=${lat}&lon=${lng}`);
    const a = x.address || {};
    r = { name: clean(a.suburb || a.neighbourhood || a.quarter || a.city_district || a.residential || ''), street: clean(a.road || ''), city: clean(a.city || a.town || a.village || a.state || '') };
  } catch { /* نجرب فوتون */ }
  if (!r || !r.name) {
    try {
      const f = (await getJson(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`)).features?.[0]?.properties || {};
      r = { name: clean(f.district || r?.name || ''), street: clean(f.street || r?.street || ''), city: clean(f.city || r?.city || '') };
    } catch { /* ما فيه */ }
  }
  r = r || { name: '', street: '', city: '' };
  cache.set(k, r);
  return r;
}
