/* リアルタイムの地図。記録ページの「リアルタイムモード」と、岸から見るページ（live.html）の両方で使う。
 *
 * 数秒おきに全艇の「いまの位置」を読み（js/cloud.js の liveRead）、艇・航跡・マークを描く。
 * 途中から見始めたときは、直近15分の航跡を最初に1回だけ読み足す。
 * 上マークと下マークがそろっていれば、風上（上マーク）が上になるように地図を回す。
 * 地図の部品（Leaflet）は、この地図を初めて開くときに読み込む。記録するだけなら読み込まない。 */
(function (root) {
  'use strict';
  var RT = root.RT = root.RT || {};

  var POLL_MS = 5000;              // いまの位置を読む間隔
  var TRAIL_MS = 15 * 60 * 1000;   // 航跡として残す長さ
  var STALE_MS = 60 * 1000;        // これ以上更新がなければ「止まっている」として薄く描く
  var HIDE_MS = 30 * 60 * 1000;    // これ以上更新がなければ描かない
  var REFIT_MS = 30 * 1000;        // 少なくともこの間隔で、全体が見えるように合わせ直す
  var KN = 0.514444;
  var COLORS = ['#e6194b', '#2e9e44', '#4363d8', '#f58231', '#911eb4', '#008080',
    '#e032c8', '#9a6324', '#800000', '#000075', '#6b7a00', '#c79200'];
  var MARK_INFO = { m1: ['上', '上マーク'], m4: ['下', '下マーク'], fin: ['F', 'フィニッシュ'] };
  var LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  var LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  var ROTATE_JS = 'https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate.js';

  // ---------- 地図の部品の読み込み ----------
  var loading = null;
  function addScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('地図の部品を読み込めませんでした')); };
      document.head.appendChild(s);
    });
  }
  function loadLeaflet() {
    if (root.L && root.L.map) return Promise.resolve();
    if (loading) return loading;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = LEAFLET_CSS;
    document.head.appendChild(link);
    loading = addScript(LEAFLET_JS).then(function () { return addScript(ROTATE_JS); })
      .catch(function (e) { loading = null; throw e; });
    return loading;
  }

  // ---------- 小さな道具 ----------
  function colorOf(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 9973;
    return COLORS[h % COLORS.length];
  }
  /* 位置の列を時刻順にまとめる（同じ時刻は1つにし、古すぎるものは捨てる） */
  function mergeFixes(a, b, cutMs) {
    var all = a.concat(b).filter(function (f) { return f[0] >= cutMs; });
    all.sort(function (x, y) { return x[0] - y[0]; });
    var out = [];
    all.forEach(function (f) { if (!out.length || f[0] > out[out.length - 1][0]) out.push(f); });
    return out;
  }
  /* 最後の数秒の動きから、艇速（m/s）と進んでいる方位を出す */
  function motion(fixes, proj, G) {
    var n = fixes.length;
    if (n < 2) return { spd: null, hdg: null };
    var b = fixes[n - 1], a = fixes[n - 2];
    for (var i = n - 2; i >= 0 && b[0] - fixes[i][0] <= 6000; i--) a = fixes[i];
    var dt = (b[0] - a[0]) / 1000;
    if (dt <= 0) return { spd: null, hdg: null };
    var pa = proj.toXY(a[1], a[2]), pb = proj.toXY(b[1], b[2]);
    var d = G.dist(pa, pb);
    return { spd: d / dt, hdg: d > 1.5 ? G.bearing(pa, pb) : null };
  }

  /* 地図を作る。el は地図を入れる要素。
   * opts = { day: 日付（省略すると今日）, selfId: 自分の記録ID, interactive: 指で動かせるか, onStatus: 状態を受け取る関数 } */
  function create(el, opts) {
    opts = opts || {};
    var L = root.L, G = RT.geo, cloud = RT.cloud;
    var day = opts.day || cloud.dayOf(Date.now());
    var area = (RT.config && RT.config.area) || [[34.70, 135.30], [34.66, 135.35]];
    var lat0 = 0, lon0 = 0;
    area.forEach(function (p) { lat0 += p[0] / area.length; lon0 += p[1] / area.length; });
    var proj = G.projection(lat0, lon0);

    var free = !!opts.interactive;
    var map = L.map(el, {
      preferCanvas: true, zoomSnap: 0.25, zoomControl: free, attributionControl: true,
      dragging: free, touchZoom: free, scrollWheelZoom: free, doubleClickZoom: free, boxZoom: free, keyboard: free,
      rotate: true, bearing: 0, rotateControl: false,
      shiftKeyRotate: false, pitchDrag: false, touchRotate: false, touchPitch: false
    });
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
      maxZoom: 20, maxNativeZoom: 18,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>'
    }).addTo(map);
    map.setView([lat0, lon0], 14);
    var canvas = L.canvas({ padding: 0.5 });

    var boats = {};          // 記録ID → { id, sail, nick, ops, fixes, lastT, marker, trail, parts }
    var marks = {};          // 種類 → { lat, lon, t }
    var markLayers = {};
    var selfFixes = [];      // 自分の位置（このスマホの GPS から直接。通信を待たずに動かすため）
    var up = 0;              // 画面の上に来る方位
    var autoFit = true, lastFit = 0, timer = null, running = false, busy = false, gotHistory = {};
    var fitting = false;     // 自分で地図を動かしている最中か（指で動かしたのと区別するため）
    var startPos = null;     // 最後に記録されたスタートの位置（本部船の位置）
    var guides = {};         // 距離の線とラベル（axis: 上下のマークの間、line: スタートライン）
    var dists = { ud: null, line: null };
    var lastError = '';

    if (free) {
      // 指で動かしたら、勝手に合わせ直すのをやめる（refit() を呼ぶと再開）
      map.on('dragstart zoomstart', function () { if (!fitting) autoFit = false; });
    }

    function boatIcon(b, isSelf) {
      var wrap = document.createElement('div');
      wrap.className = 'lv-boat' + (isSelf ? ' is-self' : '');
      var size = isSelf ? 28 : 22;
      wrap.innerHTML = '<svg viewBox="0 0 22 22" width="' + size + '" height="' + size + '" aria-hidden="true">' +
        '<path d="M11 1.5 C15 6.5 15.5 13 14 20 L8 20 C6.5 13 7 6.5 11 1.5 Z" fill="' + b.color +
        '" stroke="' + (isSelf ? '#0c2340' : '#fff') + '" stroke-width="' + (isSelf ? 2.2 : 1.5) + '" stroke-linejoin="round"/></svg>' +
        '<div class="lv-label"></div>';
      return L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: wrap.outerHTML });
    }
    function ensureBoat(id, info) {
      var b = boats[id];
      if (!b) {
        b = boats[id] = { id: id, fixes: [], lastT: 0, color: colorOf(id), marker: null, trail: null };
      }
      if (info) { b.sail = info.sail; b.nick = info.nick; b.ops = info.ops; }
      return b;
    }
    function dropLayers(b) {
      if (b.marker) { map.removeLayer(b.marker); b.marker = null; }
      if (b.trail) { map.removeLayer(b.trail); b.trail = null; }
    }

    function drawBoat(b, now) {
      var isSelf = !!opts.selfId && b.id === opts.selfId;
      var fixes = b.fixes;
      if (!fixes.length || now - b.lastT > HIDE_MS) { dropLayers(b); return; }
      var last = fixes[fixes.length - 1], pos = [last[1], last[2]];
      if (!b.trail) {
        b.trail = L.polyline([], { renderer: canvas, color: b.color, weight: isSelf ? 3.5 : 2, opacity: 0.85, interactive: false }).addTo(map);
      }
      b.trail.setLatLngs(fixes.map(function (f) { return [f[1], f[2]]; }));
      if (!b.marker) {
        b.marker = L.marker(pos, { icon: boatIcon(b, isSelf), interactive: false, keyboard: false, zIndexOffset: isSelf ? 2000 : 1000 }).addTo(map);
        var rootEl = b.marker.getElement();
        b.parts = { box: rootEl.querySelector('.lv-boat'), svg: rootEl.querySelector('svg'), label: rootEl.querySelector('.lv-label') };
      }
      b.marker.setLatLng(pos);
      var m = motion(fixes, proj, G);
      if (m.hdg !== null) b.hdg = m.hdg;
      b.parts.svg.style.transform = 'rotate(' + ((b.hdg || 0) - up).toFixed(1) + 'deg)';
      var name = isSelf ? '自分' : (b.nick || b.sail || '');
      b.parts.label.textContent = name + (m.spd === null ? '' : ' ' + (m.spd / KN).toFixed(1) + 'kt');
      b.parts.box.classList.toggle('is-stale', now - b.lastT > STALE_MS);
    }

    function drawMarks() {
      Object.keys(MARK_INFO).forEach(function (key) {
        var m = marks[key];
        if (!m) { if (markLayers[key]) { map.removeLayer(markLayers[key]); delete markLayers[key]; } return; }
        if (!markLayers[key]) {
          var wrap = document.createElement('div');
          wrap.className = 'lv-mark';
          var dot = document.createElement('div'); dot.className = 'lv-mark-dot'; dot.textContent = MARK_INFO[key][0];
          var name = document.createElement('div'); name.className = 'lv-mark-name'; name.textContent = MARK_INFO[key][1];
          wrap.appendChild(dot); wrap.appendChild(name);
          markLayers[key] = L.marker([m.lat, m.lon], {
            interactive: false, keyboard: false, zIndexOffset: 500,
            icon: L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: wrap.outerHTML })
          }).addTo(map);
        }
        markLayers[key].setLatLng([m.lat, m.lon]);
      });
      // 上マークが上になるように地図を回す
      var want = 0;
      if (marks.m1 && marks.m4) want = G.bearing(proj.toXY(marks.m4.lat, marks.m4.lon), proj.toXY(marks.m1.lat, marks.m1.lon));
      if (Math.abs(G.norm180(want - up)) > 0.5) {
        up = want;
        fitting = true;
        if (map.setBearing) map.setBearing(-up);
        fitting = false;
        lastFit = 0;
      }
    }

    /* 2点の間に線を引き、まんなかに距離を書く。a か b が無ければ消す。 */
    function drawGuide(key, a, b, style, prefix) {
      var g = guides[key];
      if (!a || !b) {
        if (g) { map.removeLayer(g.line); map.removeLayer(g.label); delete guides[key]; }
        return null;
      }
      var d = G.dist(proj.toXY(a.lat, a.lon), proj.toXY(b.lat, b.lon));
      var mid = [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2];
      if (!g) {
        g = guides[key] = {
          line: L.polyline([], Object.assign({ renderer: canvas, interactive: false }, style)).addTo(map),
          label: L.marker(mid, {
            interactive: false, keyboard: false, zIndexOffset: 400,
            icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="lv-dist"></div>' })
          }).addTo(map)
        };
        g.text = g.label.getElement().querySelector('.lv-dist');
      }
      g.line.setLatLngs([[a.lat, a.lon], [b.lat, b.lon]]);
      g.label.setLatLng(mid);
      g.text.textContent = prefix + Math.round(d) + 'm';
      return d;
    }
    /* 上下のマークの距離と、スタートラインの長さを描く。
     * 本部船の位置は、動いている運営艇がいればその位置（ラインを合わせている最中でも見られるように）、
     * いなければ最後に記録されたスタートの位置。 */
    function drawGuides(now) {
      dists.ud = drawGuide('axis', marks.m1, marks.m4, { color: '#5b6b7a', weight: 1.5, opacity: 0.8, dashArray: '4 6' }, '');
      var cb = null;
      Object.keys(boats).forEach(function (id) {
        var b = boats[id];
        if (!b.ops || !b.fixes.length || now - b.lastT > STALE_MS) return;
        var f = b.fixes[b.fixes.length - 1];
        cb = { lat: f[1], lon: f[2] };
      });
      if (!cb && startPos) cb = startPos;
      dists.line = drawGuide('line', cb, marks.m4, { color: '#17212b', weight: 2.5, dashArray: '7 6' }, 'ライン ');
    }

    /* マークと、動いている艇が収まるように地図を合わせる（回した地図でも収まるよう、画面の上・右の向きで測る） */
    function fit(force) {
      var now = Date.now(), size = map.getSize();
      if (!size.x || !size.y) return;
      var pts = [];
      Object.keys(marks).forEach(function (k) { pts.push(proj.toXY(marks[k].lat, marks[k].lon)); });
      Object.keys(boats).forEach(function (id) {
        var b = boats[id];
        if (!b.fixes.length || now - b.lastT > STALE_MS * 3) return;
        var f = b.fixes[b.fixes.length - 1];
        pts.push(proj.toXY(f[1], f[2]));
      });
      if (!pts.length) return;
      var u = G.vec(up), r = G.vec(up + 90);
      var minU = Infinity, maxU = -Infinity, minR = Infinity, maxR = -Infinity;
      pts.forEach(function (p) {
        var pu = G.dot(p, u), pr = G.dot(p, r);
        minU = Math.min(minU, pu); maxU = Math.max(maxU, pu);
        minR = Math.min(minR, pr); maxR = Math.max(maxR, pr);
      });
      if (!force && now - lastFit < REFIT_MS) {
        // まだ合わせ直す時間でなければ、はみ出した艇がいるときだけ合わせ直す
        var inside = pts.every(function (p) {
          var q = proj.toLatLon(p), c = map.latLngToContainerPoint([q.lat, q.lon]);
          return c.x > size.x * 0.06 && c.x < size.x * 0.94 && c.y > size.y * 0.1 && c.y < size.y * 0.9;
        });
        if (inside) return;
      }
      lastFit = now;
      var mpp = Math.max((maxR - minR) / (size.x * 0.62), (maxU - minU) / (size.y * 0.6), 0.5);
      var zoom = Math.log(156543.03392 * Math.cos(lat0 * G.D2R) / mpp) / Math.LN2;
      zoom = Math.max(11, Math.min(18, Math.floor(zoom * 4) / 4));
      var cu = (minU + maxU) / 2, cr = (minR + maxR) / 2;
      var c = proj.toLatLon({ x: u.x * cu + r.x * cr, y: u.y * cu + r.y * cr });
      fitting = true;
      map.setView([c.lat, c.lon], zoom, { animate: false });
      fitting = false;
    }

    function redraw() {
      var now = Date.now();
      drawMarks();
      Object.keys(boats).forEach(function (id) { drawBoat(boats[id], now); });
      drawGuides(now);
      if (autoFit) fit(false);
      report();
    }
    function report() {
      if (!opts.onStatus) return;
      var now = Date.now(), n = 0, moving = 0;
      Object.keys(boats).forEach(function (id) {
        var b = boats[id];
        if (!b.fixes.length || now - b.lastT > HIDE_MS) return;
        n++;
        if (now - b.lastT <= STALE_MS) moving++;
      });
      opts.onStatus({ boats: n, moving: moving, marks: Object.keys(marks).length, error: lastError, day: day, ud: dists.ud, line: dists.line });
    }

    /* 読んだ「いまの位置」を取り込む */
    function absorb(list) {
      var cut = Date.now() - TRAIL_MS, latest = {}, lastStart = null;
      list.forEach(function (v) {
        var b = ensureBoat(v.id, v);
        var isSelf = !!opts.selfId && v.id === opts.selfId && selfFixes.length;
        if (!isSelf) {
          b.fixes = mergeFixes(b.fixes, v.fixes, cut);
          b.lastT = Math.max(b.lastT, v.t);
        }
        // マークは、種類ごとに、いちばん新しく打たれた位置を使う
        v.marks.forEach(function (m) {
          if (m[1] === 'start' && m[2] !== null && m[3] !== null && (!lastStart || m[0] > lastStart.t)) {
            lastStart = { lat: m[2], lon: m[3], t: m[0] };
          }
          if (!MARK_INFO[m[1]] || m[2] === null || m[3] === null) return;
          if (!latest[m[1]] || m[0] > latest[m[1]].t) latest[m[1]] = { lat: m[2], lon: m[3], t: m[0] };
        });
        // 途中から見始めたときのために、この艇の少し前までの航跡を1回だけ読み足す
        if (!gotHistory[v.id]) {
          gotHistory[v.id] = true;
          cloud.liveTrail(day, v.id, Date.now() - TRAIL_MS).then(function (old) {
            if (!old.length) return;
            b.fixes = mergeFixes(b.fixes, old, Date.now() - TRAIL_MS);
            redraw();
          }).catch(function () { gotHistory[v.id] = false; });
        }
      });
      marks = latest;
      startPos = lastStart;
    }

    function poll() {
      if (busy || !running) return;
      busy = true;
      cloud.liveRead(day).then(function (list) {
        lastError = '';
        absorb(list);
        redraw();
      }).catch(function (e) {
        lastError = e && e.code === 'net' ? '電波が届いていません' : e && e.code === 'denied' ? 'リアルタイムの準備ができていません' : '読み込めませんでした';
        report();
      }).then(function () { busy = false; });
    }

    function start() {
      if (running) return;
      running = true;
      map.invalidateSize();
      poll();
      timer = setInterval(function () { if (document.visibilityState !== 'hidden') poll(); }, POLL_MS);
    }
    function stop() {
      running = false;
      clearInterval(timer);
      timer = null;
    }

    return {
      map: map,
      start: start,
      stop: stop,
      /* 自分の位置を1点足す（[時刻, 緯度, 経度]）。通信を待たずに、自分の艇だけすぐ動かす。 */
      setSelf: function (fix) {
        if (!opts.selfId) return;
        selfFixes = mergeFixes(selfFixes, [fix], Date.now() - TRAIL_MS);
        var b = ensureBoat(opts.selfId, null);
        b.fixes = selfFixes;
        b.lastT = fix[0];
        if (running) { drawBoat(b, Date.now()); if (autoFit) fit(false); }
      },
      /* 自分の、これまでの位置をまとめて渡す（リアルタイムモードに入った直後に、それまでの航跡を見せるため） */
      setSelfHistory: function (fixes) {
        if (!opts.selfId) return;
        selfFixes = mergeFixes([], fixes, Date.now() - TRAIL_MS);
        var b = ensureBoat(opts.selfId, null);
        b.fixes = selfFixes;
        if (selfFixes.length) b.lastT = selfFixes[selfFixes.length - 1][0];
      },
      /* 全体が見えるように合わせ直す（指で動かしたあとに、自動の合わせ直しを再開する） */
      refit: function () { autoFit = true; map.invalidateSize(); fit(true); },
      info: function () {
        var out = { day: day, up: Math.round(up), marks: Object.keys(marks), dists: dists, boats: {} };
        Object.keys(boats).forEach(function (id) { out.boats[id] = { n: boats[id].fixes.length, lastT: boats[id].lastT, nick: boats[id].nick, shown: !!boats[id].marker }; });
        return out;
      }
    };
  }

  RT.livemap = { create: create, loadLeaflet: loadLeaflet, POLL_MS: POLL_MS, TRAIL_MS: TRAIL_MS };
})(typeof window !== 'undefined' ? window : globalThis);
