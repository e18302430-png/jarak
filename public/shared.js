// أدوات مشتركة لكل واجهات جارك
(function(){
  'use strict';
  var J = window.J = {};
  J.$ = function(s, r){ return (r || document).querySelector(s); };
  J.$$ = function(s, r){ return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  J.esc = function(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  J.money = function(n){ n = Math.round(Number(n) * 100) / 100; return n % 1 ? n.toFixed(2) : String(n); };
  J.sar = function(n){ return J.money(n) + ' ر.س'; };
  J.store = {
    get: function(k){ try { return localStorage.getItem(k); } catch(e) { return null; } },
    set: function(k, v){ try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch(e) {} }
  };
  J.tokenKey = 'jarak-token';
  J.api = function(path, opt){
    opt = opt || {};
    var t = J.store.get(J.tokenKey);
    return fetch(path, { method: opt.method || 'GET', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: opt.body ? JSON.stringify(opt.body) : undefined })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){
        if (r.status === 401 && J.onUnauthorized) J.onUnauthorized();
        if (!r.ok) { var e = new Error(j.error || 'صار خطأ'); e.status = r.status; e.body = j; throw e; }
        return j;
      }); });
  };
  var tt;
  J.toast = function(text){ var x = J.$('#toast'); if (!x) return; x.textContent = text; x.classList.add('on'); clearTimeout(tt); tt = setTimeout(function(){ x.classList.remove('on'); }, 2600); };
  J.sse = function(path, onMsg){
    var t = J.store.get(J.tokenKey); var es = new EventSource(path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(t || ''));
    es.onmessage = function(ev){ try { onMsg(JSON.parse(ev.data)); } catch(e) {} };
    return es;
  };
  J.ago = function(t){ var m = Math.round((Date.now() - new Date(t)) / 60000); return m < 1 ? 'الحين' : m < 60 ? 'قبل ' + m + ' د' : m < 1440 ? 'قبل ' + Math.round(m / 60) + ' س' : new Date(t).toLocaleDateString('ar-SA-u-nu-latn', { day: 'numeric', month: 'short' }); };
  J.time = function(t){ return new Date(t).toLocaleTimeString('ar-SA-u-nu-latn', { hour: 'numeric', minute: '2-digit' }); };
  J.dist = function(m){ return m < 1000 ? Math.round(m / 10) * 10 + ' م' : (m / 1000).toFixed(1) + ' كم'; };
  /* ---------- الأصوات والتنبيهات ----------
     order: طلب جديد (يتكرر لين يرد التاجر أو المندوب)، chime: تحديث للعميل، success: تم، attention: يحتاج ردك */
  var actx = null, bufs = {}, alarmT = null, alarmUntil = 0, titleT = null, baseTitle = document.title;
  var SOUNDS = ['order', 'chime', 'success', 'attention'];
  function loadBuf(n){ if (bufs[n] || !actx) return; bufs[n] = 'loading'; fetch('/sounds/' + n + '.mp3').then(function(r){ return r.arrayBuffer(); }).then(function(a){ return new Promise(function(res, rej){ actx.decodeAudioData(a, res, rej); }); }).then(function(b){ bufs[n] = b; }).catch(function(){ bufs[n] = null; }); }
  J.soundOn = function(){ try { return J.store.get('jarak-sound') !== 'off'; } catch(e) { return true; } };
  J.unlockSound = function(){ try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); SOUNDS.forEach(loadBuf); } catch(e) {} };
  J.sound = function(n, vol){
    if (!J.soundOn()) return;
    try {
      if (actx && bufs[n] && bufs[n] !== 'loading') { var src = actx.createBufferSource(), g = actx.createGain(); src.buffer = bufs[n]; g.gain.value = vol || 1; src.connect(g); g.connect(actx.destination); src.start(); return; }
      var a = new Audio('/sounds/' + n + '.mp3'); a.volume = Math.min(1, vol || 1); a.play().catch(function(){});
    } catch(e) {}
  };
  J.vibrate = function(p){ try { navigator.vibrate && navigator.vibrate(p); } catch(e) {} };
  /* رنّة طلب جديد: تتكرر كل ثانيتين لين يوقفها J.stopAlarm أو تخلص المهلة */
  J.alarm = function(seconds, text){
    alarmUntil = Date.now() + (seconds || 60) * 1000;
    if (alarmT) return;
    var tick = function(){ if (Date.now() > alarmUntil) { J.stopAlarm(); return; } J.sound('order', 1); J.vibrate([400, 150, 400, 150, 400]); };
    tick(); alarmT = setInterval(tick, 2300);
    var on = false; clearInterval(titleT); titleT = setInterval(function(){ on = !on; document.title = on ? '🔔 ' + (text || 'طلب جديد') : baseTitle; }, 900);
  };
  J.stopAlarm = function(){ clearInterval(alarmT); alarmT = null; clearInterval(titleT); titleT = null; document.title = baseTitle; J.vibrate(0); };
  J.ring = function(loud){ if (loud) J.alarm(45); else { J.sound('chime'); J.vibrate([120, 80, 120]); } };
  /* الشاشة تبقى صاحية وقت استقبال الطلبات */
  var lock = null;
  J.keepAwake = function(on){ try { if (on && 'wakeLock' in navigator) { navigator.wakeLock.request('screen').then(function(l){ lock = l; }).catch(function(){}); } else if (lock) { lock.release(); lock = null; } } catch(e) {} };
  document.addEventListener('visibilitychange', function(){ if (!document.hidden && lock === null && J._awake) J.keepAwake(true); });
  /* إشعارات تصل حتى والتطبيق مقفول (Web Push) */
  function b64u(s){ var p = '='.repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  J.enablePush = function(path, swUrl, scope){
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.Notification) return Promise.resolve(false);
    return Notification.requestPermission().then(function(p){
      if (p !== 'granted') return false;
      return navigator.serviceWorker.register(swUrl, { scope: scope }).then(function(){ return navigator.serviceWorker.ready; }).then(function(reg){
        return J.api('/api/push/key').then(function(k){
          if (!k.key) return false;
          return reg.pushManager.getSubscription().then(function(sub){ return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(k.key) }); })
            .then(function(sub){ return J.api(path, { method: 'POST', body: sub.toJSON() }).then(function(){ return true; }); });
        });
      });
    }).catch(function(){ return false; });
  };
  ['pointerdown', 'keydown'].forEach(function(ev){ document.addEventListener(ev, function u(){ J.unlockSound(); document.removeEventListener(ev, u, true); }, true); });
  /* دخول البقالة والمندوب: الجوال ← رمز SMS ← دخول */
  J.otpLogin = function(base, onToken){
    var f = J.$('#loginForm'), ph = J.$('#lPhone'), cw = J.$('#lCodeWrap'), cd = J.$('#lCode'), btn = f.querySelector('button[type=submit]'), err = J.$('#lErr'), step = 1, t = null;
    function again(){ var n = 45, r = J.$('#lResend'); r.disabled = true; clearInterval(t); t = setInterval(function(){ n--; r.textContent = n > 0 ? 'إعادة الإرسال بعد ' + n + ' ث' : 'أرسل الرمز مرة ثانية'; if (n <= 0) { clearInterval(t); r.disabled = false; } }, 1000); }
    function send(){ err.textContent = ''; btn.disabled = true;
      return J.api(base + '/otp', { method: 'POST', body: { phone: ph.value } }).then(function(){ step = 2; cw.hidden = false; ph.readOnly = true; btn.textContent = 'دخول'; J.$('#lSent').textContent = 'أرسلنا رمز من 4 أرقام لجوالك ' + ph.value + ' (لو الرقم مسجّل عندنا)'; cd.focus(); again(); })
        .catch(function(e){ err.textContent = e.message; }).finally(function(){ btn.disabled = false; }); }
    f.addEventListener('submit', function(e){ e.preventDefault(); J.unlockSound();
      if (step === 1) return send();
      btn.disabled = true; err.textContent = '';
      J.api(base + '/verify', { method: 'POST', body: { phone: ph.value, code: cd.value } }).then(function(r){ onToken(r.token); }).catch(function(e){ err.textContent = e.message; }).finally(function(){ btn.disabled = false; });
    });
    cd.addEventListener('input', function(){ cd.value = cd.value.replace(/[٠-٩]/g, function(d){ return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); }).replace(/\D/g, '').slice(0, 4); if (cd.value.length === 4) f.requestSubmit ? f.requestSubmit() : btn.click(); });
    J.$('#lResend').onclick = send;
    J.$('#lEdit').onclick = function(){ step = 1; cw.hidden = true; ph.readOnly = false; btn.textContent = 'أرسل رمز الدخول'; cd.value = ''; ph.focus(); };
  };
  J.pushState = function(){ return window.Notification ? Notification.permission : 'unsupported'; };
  J.maps = function(lat, lng){ return 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng; };
  J.shrink = function(file, max){
    return new Promise(function(res, rej){
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function(){ var s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', .82)); };
      img.onerror = function(){ rej(new Error('ما قدرنا نقرأ الصورة')); }; img.src = url;
    });
  };

  /* ---------- brand ---------- */
  /* شعار لكل تطبيق: نفس الفكرة (بيتك وبقالة جارك جنبه) بلون مختلف لكل طرف */
  /* الشعار: بيت فيه ساعة ربعها معبّى، يعني جارك يوصلك في ربع ساعة */
  J.MARKS = {
    customer: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><rect width=\"64\" height=\"64\" rx=\"16\" fill=\"#C5F12E\"/><path d=\"M12.5 30.2 30.1 15.1a3 3 0 0 1 3.8 0l17.6 15.1a3 3 0 0 1 1 2.3V49a4 4 0 0 1-4 4H15.5a4 4 0 0 1-4-4V32.5a3 3 0 0 1 1-2.3z\" fill=\"#111111\"/><circle cx=\"32\" cy=\"37.5\" r=\"10.5\" fill=\"#C5F12E\"/><path d=\"M32 37.5V27a10.5 10.5 0 0 1 10.5 10.5z\" fill=\"#111111\"/><circle cx=\"32\" cy=\"37.5\" r=\"2.2\" fill=\"#111111\"/></svg>",
    store: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><rect width=\"64\" height=\"64\" rx=\"16\" fill=\"#111111\"/><path d=\"M12.5 30.2 30.1 15.1a3 3 0 0 1 3.8 0l17.6 15.1a3 3 0 0 1 1 2.3V49a4 4 0 0 1-4 4H15.5a4 4 0 0 1-4-4V32.5a3 3 0 0 1 1-2.3z\" fill=\"#FFFFFF\"/><circle cx=\"32\" cy=\"37.5\" r=\"10.5\" fill=\"#111111\"/><path d=\"M32 37.5V27a10.5 10.5 0 0 1 10.5 10.5z\" fill=\"#C5F12E\"/><circle cx=\"32\" cy=\"37.5\" r=\"2.2\" fill=\"#C5F12E\"/></svg>",
    driver: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><rect width=\"64\" height=\"64\" rx=\"16\" fill=\"#12A150\"/><path d=\"M12.5 30.2 30.1 15.1a3 3 0 0 1 3.8 0l17.6 15.1a3 3 0 0 1 1 2.3V49a4 4 0 0 1-4 4H15.5a4 4 0 0 1-4-4V32.5a3 3 0 0 1 1-2.3z\" fill=\"#FFFFFF\"/><circle cx=\"32\" cy=\"37.5\" r=\"10.5\" fill=\"#12A150\"/><path d=\"M32 37.5V27a10.5 10.5 0 0 1 10.5 10.5z\" fill=\"#C5F12E\"/><circle cx=\"32\" cy=\"37.5\" r=\"2.2\" fill=\"#C5F12E\"/><path d=\"M3.5 24h7M2.5 30h6M4.5 18h5\" stroke=\"#fff\" stroke-width=\"2.4\" stroke-linecap=\"round\" opacity=\".85\"/></svg>",
    admin: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><rect width=\"64\" height=\"64\" rx=\"16\" fill=\"#101828\"/><path d=\"M12.5 30.2 30.1 15.1a3 3 0 0 1 3.8 0l17.6 15.1a3 3 0 0 1 1 2.3V49a4 4 0 0 1-4 4H15.5a4 4 0 0 1-4-4V32.5a3 3 0 0 1 1-2.3z\" fill=\"#C5F12E\"/><circle cx=\"32\" cy=\"37.5\" r=\"10.5\" fill=\"#101828\"/><path d=\"M32 37.5V27a10.5 10.5 0 0 1 10.5 10.5z\" fill=\"#C5F12E\"/><circle cx=\"32\" cy=\"37.5\" r=\"2.2\" fill=\"#C5F12E\"/></svg>"
  };
  J.ROLE = 'customer';
  J.NAMES = { customer: ['جارك', ''], store: ['جارك', 'للأعمال'], driver: ['كابتن', 'جارك'], admin: ['جارك', 'الإدارة'] };
  Object.defineProperty(J, 'MARK', { get: function(){ return J.MARKS[J.ROLE] || J.MARKS.customer; } });
  J.brand = function(sub){ var n = J.NAMES[J.ROLE] || J.NAMES.customer; return '<span class="brand">' + J.MARK + '<span><b>' + n[0] + (n[1] ? ' <em>' + n[1] + '</em>' : '') + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span></span>'; };
  var IC = {
    home: '<path d="M4 11l8-7 8 7v8.5a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19.5z"/>',
    basket: '<path d="M3 10h18l-1.6 8.4A2 2 0 0 1 17.4 20H6.6a2 2 0 0 1-2-1.6z"/><path d="M8 10l3-6M16 10l-3-6M9 14v2M15 14v2M12 14v2"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    down: '<path d="M6 9l6 6 6-6"/>', back: '<path d="M9 6l6 6-6 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
    repeat: '<path d="M4 11V9a3 3 0 0 1 3-3h12l-3-3M20 13v2a3 3 0 0 1-3 3H5l3 3"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    nav: '<path d="M3 11l18-8-8 18-2-8z"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    store: '<path d="M4 10v10h16V10M3 10l1.5-6h15L21 10zM3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M10 20v-5h4v5"/>',
    bike: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l4-7h5l3 7M10 10l-1-3H6M15 10l1-3h3"/>',
    wallet: '<path d="M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h11v3"/><path d="M16 13.5h.01"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
    alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5h.01"/>',
    box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 15c2 .6 3 2.2 3.5 5"/>',
    logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
    gift: '<rect x="3" y="8" width="18" height="5"/><path d="M5 13v8h14v-8M12 8v13M12 8S10.5 3 8 3.8 8.5 8 12 8zM12 8s1.5-5 4-4.2S15.5 8 12 8z"/>'
  };
  J.icon = function(n, cls){ return '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (IC[n] || '') + '</svg>'; };
  J.paintIcons = function(root){ J.$$('[data-icon]', root).forEach(function(el){ el.innerHTML = J.icon(el.getAttribute('data-icon')) + el.innerHTML; el.removeAttribute('data-icon'); }); };

  /* the neighbourhood: a light map with the zone and every baqala pinned */
  J.hood = function(el, pub, opt){
    opt = opt || {};
    if (!pub || !pub.zone) return;
    var z = pub.zone, W = 400, H = 250, R = Math.min(W, H) * 0.42 * (opt.zoom || 1), cx = W / 2, cy = H / 2;
    var k = Math.cos(z.lat * Math.PI / 180);
    var pt = function(lat, lng){ var dx = (lng - z.lng) * 111320 * k, dy = (lat - z.lat) * 110540; return [cx + dx / z.radius_m * R, cy - dy / z.radius_m * R]; };
    var lines = '';
    for (var i = -8; i <= 8; i++) { var o = i * 24; lines += '<line x1="' + (cx + o - 300) + '" y1="' + (cy - 300) + '" x2="' + (cx + o + 300) + '" y2="' + (cy + 300) + '"/><line x1="' + (cx - 300) + '" y1="' + (cy + o + 300) + '" x2="' + (cx + 300) + '" y2="' + (cy + o - 300) + '"/>'; }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="خريطة حي ' + J.esc(z.name) + '"><rect width="' + W + '" height="' + H + '" fill="#EEF1F5"/>' +
      '<g stroke="#fff" stroke-width="5">' + lines + '</g>' +
      '<line x1="' + (cx - 260) + '" y1="' + (cy + 70) + '" x2="' + (cx + 260) + '" y2="' + (cy - 110) + '" stroke="#FFE7A8" stroke-width="10"/><line x1="' + (cx - 40) + '" y1="-20" x2="' + (cx + 70) + '" y2="' + (H + 20) + '" stroke="#fff" stroke-width="11"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="rgba(197,241,46,.22)" stroke="#111" stroke-width="2" stroke-dasharray="6 6"/>';
    var stores = (pub.stores || []).slice(0, 40);
    stores.forEach(function(st, n){ var p = pt(st.lat, st.lng), d = (0.15 + n * 0.12).toFixed(2) + 's', c = st.open === false ? '#A3A3A3' : '#111111';
      s += '<g class="st" style="animation-delay:' + d + ';transform-origin:' + p[0] + 'px ' + p[1] + 'px"><path d="M' + p[0] + ' ' + (p[1] + 2) + ' l-9 -12 a11 11 0 1 1 18 0z" fill="' + c + '" stroke="#fff" stroke-width="2"/><path d="M' + (p[0] - 4.5) + ' ' + (p[1] - 13) + 'h9v6h-9z" fill="#C5F12E"/></g>';
    });
    (opt.marks || []).forEach(function(m){ var q = pt(m.lat, m.lng); q = [Math.max(16, Math.min(W - 16, q[0])), Math.max(16, Math.min(H - 16, q[1]))];
      if (m.kind === 'home') s += '<g><circle cx="' + q[0] + '" cy="' + q[1] + '" r="15" fill="#101828" stroke="#fff" stroke-width="3"/><path d="M' + (q[0] - 6) + ' ' + (q[1] + 5) + 'v-6l6-5 6 5v6z" fill="#fff"/></g>';
      if (m.kind === 'driver') s += '<g class="drv"><circle cx="' + q[0] + '" cy="' + q[1] + '" r="22" fill="rgba(18,161,80,.18)"><animate attributeName="r" values="14;24;14" dur="1.8s" repeatCount="indefinite"/></circle><circle cx="' + q[0] + '" cy="' + q[1] + '" r="13" fill="#12A150" stroke="#fff" stroke-width="3"/><circle cx="' + (q[0] - 4) + '" cy="' + (q[1] + 3) + '" r="2.4" fill="#fff"/><circle cx="' + (q[0] + 4) + '" cy="' + (q[1] + 3) + '" r="2.4" fill="#fff"/><path d="M' + (q[0] - 4) + ' ' + (q[1] + 3) + 'l3-6h3l2 6" stroke="#fff" stroke-width="1.6" fill="none"/></g>';
      if (m.kind === 'route' && m.to) { var t = pt(m.to.lat, m.to.lng); s += '<path d="M' + q[0] + ' ' + q[1] + ' Q ' + ((q[0] + t[0]) / 2 + 24) + ' ' + ((q[1] + t[1]) / 2 - 24) + ' ' + t[0] + ' ' + t[1] + '" fill="none" stroke="#101828" stroke-width="2.5" stroke-dasharray="2 6" stroke-linecap="round"/>'; }
    });
    if (opt.you) { var y = pt(opt.you.lat, opt.you.lng);
      y = [Math.max(14, Math.min(W - 14, y[0])), Math.max(14, Math.min(H - 14, y[1]))];
      s += '<circle cx="' + y[0] + '" cy="' + y[1] + '" r="16" fill="rgba(46,107,230,.18)"/><circle cx="' + y[0] + '" cy="' + y[1] + '" r="7" fill="#2E6BE6" stroke="#fff" stroke-width="3"/>'; }
    s += '</svg>';
    var open = stores.filter(function(x){ return x.open !== false; }).length;
    el.classList.add('hood');
    el.innerHTML = s + '<span class="cap"><span class="dot-live"></span>' + (opt.caption || ('حي ' + J.esc(z.name) + ': ' + open + ' بقالات فاتحة الحين')) + '</span>';
  };
  J.img = function(p, cls){ return '<span class="thumb ' + (/\/img\/(off|u|gen)\//.test(p.image || '') ? 'real ' : '') + (cls || '') + '"><img src="' + J.esc(p.image || '/img/p/shopping_cart.webp') + '" alt="" loading="lazy"></span>'; };
  J.pub = null;
  J.loadPublic = function(){ return J.pub ? Promise.resolve(J.pub) : J.api('/api/public').then(function(p){ J.pub = p; return p; }); };
  J.LANGS = { ar: 'العربي', ur: 'اردو', bn: 'বাংলা', hi: 'हिन्दी', ml: 'മലയാളം', en: 'English' };
  J.nameIn = function(p, l){ return l === 'ar' ? p.name_ar : (p['name_' + l] || p.name_en || p.name_ar); };
})();
