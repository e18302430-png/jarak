/* جارك: الخريطة الحية (Leaflet). المندوب يتحرك عليها بنعومة، والبقالة والبيت مثبتين */
(function(){
  var J = window.J;
  var DEF_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var leafletP = null;
  function loadLeaflet(){
    if (window.L) return Promise.resolve(window.L);
    if (leafletP) return leafletP;
    leafletP = new Promise(function(res, rej){
      var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css'; document.head.appendChild(css);
      var s = document.createElement('script'); s.src = '/vendor/leaflet/leaflet.js'; s.onload = function(){ res(window.L); }; s.onerror = rej; document.head.appendChild(s);
    });
    return leafletP;
  }
  J.loadLeaflet = loadLeaflet;

  var IMG = { driver: '/img/p/motor_scooter.webp', store: '/img/p/convenience_store.webp', home: '/img/p/house.webp' };
  function pinHtml(kind, opt){
    opt = opt || {};
    if (kind === 'driver') return '<div class="mk mk-drv' + (opt.state ? ' ' + opt.state : '') + '"><span class="ring"></span><span class="b"><img src="' + IMG.driver + '" alt=""></span>' + (opt.label ? '<span class="tag">' + J.esc(opt.label) + '</span>' : '') + '</div>';
    if (kind === 'me') return '<div class="mk mk-me"><span class="ring"></span><span class="dot"></span></div>';
    if (kind === 'home') return '<div class="mk mk-pin home"><span class="b">' + J.icon('home') + '</span>' + (opt.label ? '<span class="tag">' + J.esc(opt.label) + '</span>' : '') + '</div>';
    if (kind === 'order') return '<div class="mk mk-ord ' + (opt.state || '') + '"><span class="b">' + J.esc(opt.label || '') + '</span></div>';
    return '<div class="mk mk-pin store' + (opt.state === 'closed' ? ' off' : '') + '"><span class="b">' + J.icon('store') + '</span>' + (opt.label ? '<span class="tag">' + J.esc(opt.label) + '</span>' : '') + '</div>';
  }
  var SIZE = { driver: [56, 56], me: [28, 28], order: [40, 40] };

  /* J.livemap(el, {zone, center, zoom, interactive}) → ctl
     ctl.mark(key, kind, lat, lng, opt)  ينشئ أو يحرّك (المندوب يتحرك بنعومة)
     ctl.route(points)                    خط الطريق
     ctl.fit()                            يقرّب على كل اللي في الخريطة */
  J.livemap = function(el, o){
    o = o || {};
    el.classList.add('lmap');
    var ctl = { marks: {}, ready: null, _route: null, map: null };
    ctl.ready = loadLeaflet().then(function(L){
      var z = o.zone || (J.pub && J.pub.zone) || { lat: 26.2855, lng: 50.2105, radius_m: 1500 };
      var map = L.map(el, { zoomControl: false, attributionControl: true, dragging: o.interactive !== false, scrollWheelZoom: false, tap: true, zoomSnap: 0.25 }).setView([z.lat, z.lng], o.zoom || 15);
      var url = (J.pub && J.pub.tiles) || DEF_TILES, osm = /tile\.openstreetmap\.org/.test(url);
      var tl = L.tileLayer(url, { referrerPolicy: 'strict-origin-when-cross-origin', subdomains: 'abcd', maxZoom: osm ? 19 : 20, detectRetina: !osm, className: osm ? 'osm-soft' : '', attribution: '© OpenStreetMap' + (/carto/.test(url) ? ' © CARTO' : /maptiler/.test(url) ? ' © MapTiler' : /stadia/.test(url) ? ' © Stadia' : '') }).addTo(map);
      var fails = 0; tl.on('tileerror', function(){ if (++fails > 3) el.classList.add('notiles'); }); tl.on('tileload', function(){ el.classList.remove('notiles'); });
      map.attributionControl.setPrefix(false);
      if (o.showZone !== false) L.circle([z.lat, z.lng], { radius: z.radius_m, color: '#111', weight: 1.5, dashArray: '6 6', fillColor: '#C5F12E', fillOpacity: 0.10, interactive: false }).addTo(map);
      ctl.map = map; ctl.L = L;
      setTimeout(function(){ map.invalidateSize(); }, 60);
      return map;
    }).catch(function(){ el.classList.add('notiles'); });

    ctl.mark = function(key, kind, lat, lng, opt){
      return ctl.ready.then(function(map){
        if (!map || lat == null || lng == null) return;
        var L = ctl.L, m = ctl.marks[key], html = pinHtml(kind, opt), sz = SIZE[kind] || [44, 52];
        var anchor = kind === 'driver' || kind === 'me' || kind === 'order' ? [sz[0] / 2, sz[1] / 2] : [sz[0] / 2, sz[1]];
        if (!m) {
          m = L.marker([lat, lng], { icon: L.divIcon({ className: 'mk-wrap', html: html, iconSize: sz, iconAnchor: anchor }), keyboard: false, zIndexOffset: kind === 'driver' ? 1000 : kind === 'home' ? 500 : 0 }).addTo(map);
          m._html = html; ctl.marks[key] = m; if (opt && opt.onClick) m.on('click', opt.onClick); return;
        }
        if (m._html !== html) { m.setIcon(L.divIcon({ className: 'mk-wrap', html: html, iconSize: sz, iconAnchor: anchor })); m._html = html; }
        glide(m, lat, lng);
      });
    };
    ctl.unmark = function(key){ var m = ctl.marks[key]; if (m) { m.remove(); delete ctl.marks[key]; } };
    ctl.route = function(points){
      return ctl.ready.then(function(map){
        if (!map) return; var L = ctl.L;
        if (ctl._route) { ctl._route.forEach(function(l){ l.remove(); }); ctl._route = null; }
        points = (points || []).filter(function(p){ return p && p.lat != null; });
        if (points.length < 2) return;
        var ll = points.map(function(p){ return [p.lat, p.lng]; });
        ctl._route = [L.polyline(ll, { color: '#fff', weight: 9, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map),
                      L.polyline(ll, { color: '#111', weight: 4.5, opacity: 0.9, lineCap: 'round', lineJoin: 'round', dashArray: '1 9', className: 'route-dash', interactive: false }).addTo(map)];
      });
    };
    ctl.fit = function(pad){
      return ctl.ready.then(function(map){
        if (!map) return; var pts = Object.keys(ctl.marks).map(function(k){ return ctl.marks[k].getLatLng(); });
        if (pts.length === 1) map.setView(pts[0], 16); else if (pts.length) map.fitBounds(ctl.L.latLngBounds(pts), { padding: pad || [50, 50], maxZoom: 17 });
      });
    };
    ctl.destroy = function(){ ctl.ready.then(function(map){ if (map) map.remove(); }); };
    return ctl;
  };
  function glide(m, lat, lng){
    var a = m.getLatLng(), t0 = performance.now(), D = 1600;
    if (Math.abs(a.lat - lat) < 1e-7 && Math.abs(a.lng - lng) < 1e-7) return;
    cancelAnimationFrame(m._raf);
    (function step(t){ var k = Math.min(1, (t - t0) / D), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      m.setLatLng([a.lat + (lat - a.lat) * e, a.lng + (lng - a.lng) * e]); if (k < 1) m._raf = requestAnimationFrame(step); })(t0);
  }

  /* بحث عن أي حي أو مدينة أو شارع في السعودية (OpenStreetMap، مجاني) */
  J.placeSearch = function(input, list, onPick){
    var t = null, seq = 0;
    function run(){
      var v = input.value.trim(); if (v.length < 2) { list.innerHTML = ''; list.hidden = true; return; }
      var ll = J.parseMapLink(v); if (ll) { list.hidden = true; onPick({ lat: ll.lat, lng: ll.lng, name: '' }); return; }
      if (/^https?:\/\//.test(v)) { list.hidden = false; list.innerHTML = '<div class="ps-it muted">نقرأ الرابط…</div>';
        J.api('/api/admin/maplink?u=' + encodeURIComponent(v)).then(function(r){ list.hidden = true; onPick({ lat: r.lat, lng: r.lng, name: '' }); }).catch(function(e){ list.innerHTML = '<div class="ps-it muted">' + J.esc(e.message) + '</div>'; }); return; }
      var my = ++seq; list.hidden = false; list.innerHTML = '<div class="ps-it muted">نبحث…</div>';
      J.api('/api/admin/geo?q=' + encodeURIComponent(v)).then(function(r){
          if (my !== seq) return; var rows = r.results || [];
          if (!rows.length) { list.innerHTML = '<div class="ps-it muted">ما لقينا «' + J.esc(v) + '». اكتب اسم الحي ومعه المدينة، مثل «النور الدمام»، أو اضغط على الخريطة مباشرة</div>'; return; }
          list.innerHTML = rows.map(function(x, i){ return '<button type="button" class="ps-it" data-i="' + i + '"><b>' + J.esc(x.name) + '</b><small>' + J.esc(x.city || '') + '</small></button>'; }).join('');
          list._rows = rows;
        }).catch(function(){ if (my === seq) list.innerHTML = '<div class="ps-it muted">البحث ما اشتغل الحين، حدّد بالضغط على الخريطة</div>'; });
    }
    input.addEventListener('input', function(){ clearTimeout(t); t = setTimeout(run, 700); });
    input.addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); run(); } });
    list.addEventListener('click', function(e){ var b = e.target.closest('[data-i]'); if (!b) return; var x = list._rows[+b.getAttribute('data-i')];
      list.hidden = true; input.value = x.name + (x.city ? '، ' + x.city : ''); onPick({ lat: x.lat, lng: x.lng, name: x.name, city: x.city }); });
    document.addEventListener('click', function(e){ if (!list.contains(e.target) && e.target !== input) list.hidden = true; });
  };
  /* وش اسم الحي في هالنقطة */
  J.whereIs = function(lat, lng){ return J.api('/api/admin/geo/rev?lat=' + lat + '&lng=' + lng); };
  J.parseMapLink = function(v){
    var m = String(v).match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || String(v).match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || String(v).match(/[?&](?:q|query|ll)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/) || String(v).match(/^\s*(-?\d{1,2}\.\d{3,})\s*[,،]\s*(-?\d{1,3}\.\d{3,})\s*$/);
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
  };
  J.myLocation = function(){ return new Promise(function(res, rej){ if (!navigator.geolocation) return rej(new Error('جهازك ما يدعم تحديد الموقع'));
    navigator.geolocation.getCurrentPosition(function(p){ res({ lat: p.coords.latitude, lng: p.coords.longitude }); }, function(){ rej(new Error('اسمح للمتصفح يعرف موقعك')); }, { enableHighAccuracy: true, timeout: 12000 }); }); };
  /* مسافة ووقت تقريبي داخل الحي */
  J.distM = function(a, b){ var R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2); return 2 * R * Math.asin(Math.sqrt(x)); };
  J.etaMin = function(points){ var m = 0; for (var i = 1; i < points.length; i++) m += J.distM(points[i - 1], points[i]) * 1.3; return Math.max(1, Math.round(m / 330)); };
})();
