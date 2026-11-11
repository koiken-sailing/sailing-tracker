/* 画面（地図・順位表・再生バー・運営パネル） */
(function () {
  'use strict';
  var G = RT.geo;
  var STORE = 'yacht-tracker-proto-v2';
  var STORE_OLD = 'yacht-tracker-proto-v1';
  var SIM_BOATS = 12;      // シミュレーションの艇数
  var COLORS = ['#e6194b', '#2e9e44', '#4363d8', '#f58231', '#911eb4', '#008080',
    '#e032c8', '#9a6324', '#800000', '#000075', '#6b7a00', '#c79200'];
  function color(i) { return COLORS[i % COLORS.length]; }
  var NAMES = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田'];
  var SAILS = ['211034', '208517', '214460', '199823', '216002', '205371',
    '212789', '203645', '217190', '209958', '201276', '215533'];
  var SIGNALS = [
    { t: -300, name: '予告信号', label: '予告信号（クラス旗 掲揚）' },
    { t: -240, name: '準備信号', label: '準備信号（P旗 掲揚）' },
    { t: -60, name: '1分前の信号', label: 'スタート1分前（P旗 降下）' },
    { t: 0, name: 'スタート', label: 'レース中' }
  ];
  var MARK_LABEL = { m1: '上マーク', m4: '下マーク', fin: 'フィニッシュ' };
  var BEARING_SIGN = -1;   // 回転プラグインは「地図を時計回りに回す角度」で指定するので、上にしたい方位の逆符号を渡す

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, f) { return a + (b - a) * f; }

  // ---------- 状態 ----------
  function load() {
    try {
      var cur = JSON.parse(localStorage.getItem(STORE));
      if (cur) return cur;
      // 旧版の保存内容からは、書き換えた名前だけを引き継ぐ（位置や表示設定は新しい初期値にする）
      var old = JSON.parse(localStorage.getItem(STORE_OLD));
      return old && old.boats ? { boats: old.boats } : {};
    } catch (e) { return {}; }
  }
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        params: state.params, overrides: state.overrides, boats: state.boats,
        label: state.label, labelV: 2, tail: state.tail, base: state.base, orient: state.orient
      }));
    } catch (e) { /* 保存できなくても動作は続ける */ }
  }
  function defaultBoats() {
    return NAMES.map(function (nm, i) { return { sail: SAILS[i], name: nm }; });
  }
  var saved = load();
  if (saved.overrides) delete saved.overrides.pin;   // アウターは下マークと兼用にしたので、古い保存値は捨てる
  var state = {
    params: Object.assign({}, RT.course.DEFAULTS, saved.params || {}),
    overrides: saved.overrides || {},
    boats: (saved.boats && saved.boats.length === SIM_BOATS) ? saved.boats : defaultBoats(),
    label: saved.labelV === 2 && saved.label ? saved.label : 'namespd',
    tail: saved.tail || 'all',
    base: saved.base || 'pale',
    orient: saved.orient || 'wind',   // 地図の向き: wind = 風上を上 / north = 北を上
    sound: false,
    selected: [],     // 航跡を強調する艇（複数可）
    tab: 'watch',
    anaLeg: 0,        // 分析タブで見ている区間（0 = スタート、1 以降 = 各レグ）
    anaTrailOnly: true
  };

  var course, sim, gates, events, ll, legDefs, legStats;
  var t = 0, playing = false, speed = 10;
  var dirty = true, lastK = -1;

  // いま表示している艇団。シミュレーションなら state.boats、読み込みならファイルの内容。
  var N = 0, fleet = [], fleetKey = '';
  // 読み込んだ航跡。null ならシミュレーションを表示する。ブラウザには保存しない（位置情報を残さないため）。
  //   { tracks: [...], startMs: スタート信号の時刻, relocate: {lat, lon} | null, overrides: {} }
  var imported = null;

  /* 読み込んだ航跡がコースから遠いとき（陸上での試し撮りなど）は、保存してあるコース位置を
   * 書き換えず、表示している間だけ本部船を航跡の場所へ移す。 */
  function curParams() {
    return imported && imported.relocate ? Object.assign({}, state.params, imported.relocate) : state.params;
  }
  function curOverrides() { return imported && imported.relocate ? imported.overrides : state.overrides; }
  function setCb(lat, lon) {
    if (imported && imported.relocate) imported.relocate = { lat: lat, lon: lon };
    else { state.params.lat = lat; state.params.lon = lon; }
  }
  function clearOverrides() {
    if (imported && imported.relocate) imported.overrides = {}; else state.overrides = {};
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clockOfDay(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function toLocalInput(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + clockOfDay(ms);
  }

  // ---------- 地図 ----------
  // 回転は leaflet-rotate プラグインによる。向きはアプリ側で決めるので、手動回転の操作は切っておく。
  var map = L.map('map', {
    preferCanvas: true, zoomSnap: 0.25,
    rotate: true, bearing: 0, rotateControl: false,
    shiftKeyRotate: false, pitchDrag: false, touchRotate: false, touchPitch: false
  });
  /* 画面の上に来る方位（真方位）。風上を上にするときは風軸、そうでなければ北。 */
  function upBearing() { return state.orient === 'wind' && course ? course.windTrue : 0; }
  function applyOrientation() {
    if (map.setBearing) map.setBearing(BEARING_SIGN * upBearing());
    var up = upBearing();
    var arrow = document.getElementById('windArrow');
    if (arrow && course) arrow.setAttribute('transform', 'rotate(' + (course.windTrue - up).toFixed(1) + ' 23 23)');
    var north = document.getElementById('northMark');
    if (north) north.setAttribute('transform', 'rotate(' + (-up).toFixed(1) + ' 23 23)');
    dirty = true;
  }
  var canvas = L.canvas({ padding: 0.5 });
  var GSI = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
  var bases = {
    pale: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
      { maxZoom: 20, maxNativeZoom: 18, attribution: GSI }),
    photo: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
      { maxZoom: 20, maxNativeZoom: 18, attribution: GSI })
  };
  var baseNow = null;
  function setBase(key) {
    if (baseNow) map.removeLayer(baseNow);
    baseNow = bases[key] || bases.pale;
    baseNow.addTo(map);
  }
  var courseGroup = L.layerGroup().addTo(map);
  var trails = [], markers = [];

  var WindCtl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      var d = L.DomUtil.create('div', 'wind');
      d.innerHTML =
        '<svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">' +
        '<circle cx="23" cy="23" r="21" fill="#fff" stroke="#c5ced8" stroke-width="1.5"/>' +
        '<g id="northMark"><path d="M23 0.5 L19.5 6.5 L26.5 6.5 Z" fill="#d92d20"/></g>' +
        '<g id="windArrow"><path d="M23 9 L23 30" stroke="#0c2340" stroke-width="3.5" stroke-linecap="round"/>' +
        '<path d="M23 39 L16.5 27.5 L29.5 27.5 Z" fill="#0c2340"/></g></svg>' +
        '<div class="wind-deg" id="windDeg"></div><div class="wind-cap">風軸（コンパス）</div>' +
        '<div class="wind-cap"><span class="north-dot"></span>が北</div>';
      return d;
    }
  });
  map.addControl(new WindCtl());

  var FitCtl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      var b = L.DomUtil.create('button', 'fit-btn');
      b.type = 'button';
      b.title = 'コース全体を表示';
      b.setAttribute('aria-label', 'コース全体を表示');
      b.textContent = '⤢';
      L.DomEvent.disableClickPropagation(b);
      b.addEventListener('click', fitCourse);
      return b;
    }
  });
  map.addControl(new FitCtl());

  function toLL(pt) { var p = course.latLon(pt); return [p.lat, p.lon]; }

  var needsFit = false;
  function fitCourse() {
    var size = map.getSize();
    if (!size.x || !size.y) { needsFit = true; return; }   // 画面がまだ表示されていない
    needsFit = false;
    // 地図を回していても収まるよう、画面の上方向・右方向に沿ってコースの大きさを測る
    var up = G.vec(upBearing()), right = G.vec(upBearing() + 90);
    var minU = Infinity, maxU = -Infinity, minR = Infinity, maxR = -Infinity;
    var pts = [course.cb, course.marks.m1, course.marks.m4, course.marks.pin, course.marks.fin];
    if (imported && sim) {
      // 読み込んだ航跡は、コースの外まで広がっていることがあるので、航跡も収まるようにする
      sim.boats.forEach(function (b) {
        for (var k = b.from; k <= b.to; k += 10) pts.push({ x: b.x[k], y: b.y[k] });
        pts.push({ x: b.x[b.to], y: b.y[b.to] });
      });
    }
    pts.forEach(function (p) {
      var pu = G.dot(p, up), pr = G.dot(p, right);
      minU = Math.min(minU, pu); maxU = Math.max(maxU, pu);
      minR = Math.min(minR, pr); maxR = Math.max(maxR, pr);
    });
    var mpp = Math.max((maxR - minR) / (size.x * 0.6), (maxU - minU) / (size.y * 0.66), 0.2);
    var zoom = Math.log(156543.03392 * Math.cos(course.proj.lat0 * G.D2R) / mpp) / Math.LN2;
    zoom = clamp(Math.floor(zoom * 4) / 4, 10, 19);
    var cu = (minU + maxU) / 2, cr = (minR + maxR) / 2;
    map.setView(toLL({ x: up.x * cu + right.x * cr, y: up.y * cu + right.y * cr }), zoom, { animate: false });
  }
  map.on('resize', function () { if (needsFit) fitCourse(); });

  function markIcon(short, name, isCb, labelLeft) {
    var wrap = el('div', 'mark' + (isCb ? ' is-cb' : '') + (labelLeft ? ' label-left' : ''));
    wrap.appendChild(el('div', 'mark-dot', short));
    wrap.appendChild(el('div', 'mark-name', name));
    return L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: wrap.outerHTML });
  }

  function drawCourse() {
    courseGroup.clearLayers();
    var M = course.marks;
    var faint = { renderer: canvas, color: '#5b6b7a', weight: 1, opacity: 0.6, dashArray: '4 6', interactive: false };
    L.polyline([toLL(M.m4), toLL(M.m1)], faint).addTo(courseGroup);
    L.polyline([toLL(M.m4), toLL(course.finMid)], faint).addTo(courseGroup);
    L.polyline([toLL(course.cb), toLL(M.pin)],
      { renderer: canvas, color: '#17212b', weight: 2.5, dashArray: '7 6', interactive: false }).addTo(courseGroup);
    L.polyline([toLL(course.cb), toLL(M.fin)],
      { renderer: canvas, color: '#0b6bd3', weight: 3.5, interactive: false }).addTo(courseGroup);

    // 運営艇の記録から来たコースには「設計上の目標位置」が無いので、目標とのずれは描かない
    var showTargets = !(imported && imported.fromOps);
    RT.course.MARKS.forEach(function (m) {
      if (showTargets && course.moved[m.key] != null) {
        L.polyline([toLL(course.targets[m.key]), toLL(M[m.key])],
          { renderer: canvas, color: '#f26a1b', weight: 1.5, dashArray: '3 4', interactive: false }).addTo(courseGroup);
        L.marker(toLL(course.targets[m.key]), {
          interactive: false, keyboard: false,
          icon: L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8], html: '<div class="ghost"></div>' })
        }).addTo(courseGroup);
      }
      var mk = L.marker(toLL(M[m.key]), {
        // 風上を上にしているとき、下マークは本部船の左隣に来るので、名前は左側に出して重なりを避ける
        draggable: true, zIndexOffset: 500, title: m.name,
        icon: markIcon(m.short, MARK_LABEL[m.key], false, m.key === 'm4' && state.orient === 'wind')
      }).addTo(courseGroup);
      mk.on('dragend', function () {
        var p = mk.getLatLng();
        curOverrides()[m.key] = { lat: p.lat, lon: p.lng };
        save(); rebuild(true);
      });
    });

    var cbm = L.marker(toLL(course.cb), {
      draggable: true, icon: markIcon('本', '本部船', true), zIndexOffset: 600, title: '本部船'
    }).addTo(courseGroup);
    cbm.on('dragend', function () {
      var p = cbm.getLatLng();
      setCb(p.lat, p.lng);
      save(); rebuild(true);
    });

    $('windDeg').textContent = G.fmtDeg(curParams().windMag);
    applyOrientation();
  }

  /* 艇のマーカーと航跡の線を、いまの艇数ぶん作り直す */
  function makeBoats() {
    trails.forEach(function (tr) { map.removeLayer(tr); });
    markers.forEach(function (m) { map.removeLayer(m.marker); });
    trails = []; markers = [];
    for (var i = 0; i < N; i++) {
      trails.push(L.polyline([], { renderer: canvas, color: color(i), weight: 2, opacity: 0.85, interactive: false }).addTo(map));
    }
    for (i = 0; i < N; i++) {
      var html = '<div class="boat"><svg viewBox="0 0 22 22" aria-hidden="true">' +
        '<path d="M11 1.5 C15 6.5 15.5 13 14 20 L8 20 C6.5 13 7 6.5 11 1.5 Z" fill="' + color(i) +
        '" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><div class="boat-label"></div></div>';
      var mk = L.marker([0, 0], {
        icon: L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: html }),
        zIndexOffset: 1000, keyboard: false
      }).addTo(map);
      (function (idx) { mk.on('click', function () { toggleSelect(idx); }); })(i);
      var root = mk.getElement();
      markers.push({ marker: mk, shown: true, boat: root.querySelector('.boat'), svg: root.querySelector('svg'), label: root.querySelector('.boat-label') });
    }
    refreshLabels();
  }

  /* 艇団が入れ替わったとき（シミュレーション ⇔ 読み込み、艇数の変化）に、艇ごとの表示を作り直す */
  function resetFleetDom() {
    makeBoats();
    boardRows = [];
    $('board').querySelector('tbody').textContent = '';
    anaRows = [];
    $('anaTable').querySelector('tbody').textContent = '';
    state.selected = [];
    applySelection();
  }

  function fmtKt(mps) { return (mps / RT.perf.KN).toFixed(1); }

  /* 艇のラベル。「名前と艇速」のときは艇速が変わるたびに書き換える。 */
  function refreshLabels() {
    markers.forEach(function (m, i) {
      var b = fleet[i], text = '';
      if (!b) return;
      if (state.label === 'name') text = b.name;
      else if (state.label === 'sail') text = b.sail;
      else if (state.label === 'namespd') text = b.name + ' ' + (sim ? fmtKt(boatAt(i, t).spd) : '–') + 'kt';
      if (m.label.textContent !== text) m.label.textContent = text;
      m.label.style.display = text ? '' : 'none';
    });
  }

  /* 艇の選択（複数可）。選んだ艇の航跡を太くし、ほかを薄くして見比べやすくする。 */
  function isSel(i) { return state.selected.indexOf(i) !== -1; }
  function toggleSelect(i) {
    var at = state.selected.indexOf(i);
    if (at === -1) state.selected.push(i); else state.selected.splice(at, 1);
    applySelection();
  }
  function clearSelection() { state.selected = []; applySelection(); }
  function applySelection() {
    var any = state.selected.length > 0;
    markers.forEach(function (m, k) {
      var on = isSel(k);
      m.boat.classList.toggle('is-selected', on);
      m.boat.classList.toggle('is-dim', any && !on);
      m.marker.setZIndexOffset(on ? 2000 : 1000);
      trails[k].setStyle({ weight: on ? 3.5 : any ? 1.5 : 2, opacity: on ? 1 : any ? 0.2 : 0.85 });
    });
    state.selected.forEach(function (k) { trails[k].bringToFront(); });
    $('btnClearSel').hidden = !any;
    buildCards();
    dirty = true;
  }

  // ---------- 計算のやり直し ----------
  function rebuild(keepTime) {
    course = RT.course.build(curParams(), curOverrides());
    if (imported) {
      sim = RT.importer.build(imported.racers, course, imported.startMs);
      fleet = imported.racers.map(function (tr) {
        return { sail: tr.sail || '—', name: tr.name || tr.sail || '名前なし' };
      });
    } else {
      sim = RT.sim.run(course, { n: SIM_BOATS, seed: 11 });
      fleet = state.boats;
    }
    N = sim.boats.length;
    var key = (imported ? 'import:' + imported.serial + ':' : 'sim:') + N;
    if (key !== fleetKey) { fleetKey = key; resetFleetDom(); }
    gates = RT.race.gates(course);
    events = RT.race.analyze(gates, sim.boats);
    ll = sim.boats.map(function (b) {
      var arr = new Array(sim.n);
      for (var k = 0; k < sim.n; k++) {
        var p = course.proj.toLatLon({ x: b.x[k], y: b.y[k] });
        arr[k] = [p.lat, p.lon];
      }
      return arr;
    });
    var seek = $('seek');
    seek.min = sim.t0; seek.max = sim.tEnd;
    // 読み込んだ航跡は、最初に全体が見えるよう最後の時刻を表示する（再生を押すと最初から流れる）
    t = keepTime ? clamp(t, sim.t0, sim.tEnd) : imported ? sim.tEnd : Math.min(300, sim.tEnd);
    drawCourse();
    renderOps();
    cards.forEach(function (c) { c.shown = -1; });

    // スタートとコース取りの分析。区間 0 はスタート、1 以降は各レグ
    legDefs = RT.analysis.legs(gates);
    legStats = RT.analysis.all(gates, sim.boats, events);
    var sel = $('anaLeg');
    state.anaLeg = clamp(state.anaLeg, 0, gates.length - 1);
    sel.textContent = '';
    var opt0 = el('option', null, 'スタート');
    opt0.value = 0;
    sel.appendChild(opt0);
    for (var j = 1; j < gates.length; j++) {
      var opt = el('option', null, legDefs[j].name + '（' + gates[j - 1].doneLabel + ' → ' + gates[j].doneLabel + '）');
      opt.value = j;
      sel.appendChild(opt);
    }
    sel.value = state.anaLeg;
    dirty = true;
  }

  function boatAt(i, tt) {
    var b = sim.boats[i];
    var s = clamp(tt - sim.t0, 0, sim.n - 1);
    var k = Math.min(sim.n - 2, Math.floor(s));
    var f = s - k;
    return {
      k: k, f: f,
      x: lerp(b.x[k], b.x[k + 1], f),
      y: lerp(b.y[k], b.y[k + 1], f),
      hdg: G.norm360(b.hdg[k] + G.norm180(b.hdg[k + 1] - b.hdg[k]) * f),
      spd: lerp(b.spd[k], b.spd[k + 1], f)
    };
  }

  // ---------- 描画 ----------
  var boardRows = [], lastBoard = 0;

  function drawBoats() {
    var kNow = -1, up = upBearing();
    var legOnly = state.tab === 'analysis' && state.anaTrailOnly;
    for (var i = 0; i < N; i++) {
      var s = boatAt(i, t);
      kNow = s.k;
      var a = ll[i][s.k], b = ll[i][s.k + 1];
      var pos = [lerp(a[0], b[0], s.f), lerp(a[1], b[1], s.f)];
      // 読み込んだ航跡は、艇ごとに記録のある範囲（kLo〜kHi）が違う。範囲の外ではマーカーを隠す。
      var bt = sim.boats[i];
      var kLo = bt.from === undefined ? 0 : bt.from, kHi = bt.to === undefined ? sim.n - 1 : bt.to;
      var has = s.k >= kLo && s.k <= kHi;
      if (markers[i].shown !== has) { markers[i].shown = has; markers[i].marker.setOpacity(has ? 1 : 0); }
      markers[i].marker.setLatLng(pos);
      markers[i].svg.style.transform = 'rotate(' + (s.hdg - up).toFixed(1) + 'deg)';
      if (dirty || s.k !== lastK) {
        var a0, b0;   // 航跡として描く範囲（1秒ごとの点の番号）
        if (legOnly) {
          // 分析タブ: 選んだ区間だけ（その艇がレグに入ってから出るまで）
          var ev = events[i], j = state.anaLeg;
          if (j === 0) {
            // スタート: 信号の60秒前から40秒後まで
            a0 = -60 - sim.t0; b0 = Math.min(s.k, 40 - sim.t0);
          } else if (ev[j - 1] === undefined || ev[j - 1] > t) {
            a0 = 1; b0 = 0;
          } else {
            a0 = Math.floor(ev[j - 1] - sim.t0);
            b0 = ev[j] !== undefined && ev[j] <= t ? Math.ceil(ev[j] - sim.t0) : s.k;
          }
        } else {
          // 「すべて」はスタート30秒前からの全航跡。スタート前のうろうろは直近2分だけ見せる。
          a0 = state.tail === 'all' ? Math.min(s.k - 120, -30 - sim.t0) : s.k - parseInt(state.tail, 10);
          b0 = s.k;
        }
        a0 = Math.max(a0, kLo, 0);
        b0 = Math.min(b0, kHi);
        var pts = b0 >= a0 ? ll[i].slice(a0, b0 + 1) : [];
        if (pts.length && b0 === s.k && has) pts.push(pos);
        trails[i].setLatLngs(pts);
      }
    }
    if (state.label === 'namespd' && (dirty || kNow !== lastK)) refreshLabels();
    lastK = kNow;
  }

  function signalLabel() {
    if (t < SIGNALS[0].t) return '予告信号まで ' + G.fmtClock(SIGNALS[0].t - t);
    var lab = SIGNALS[0].label;
    for (var i = 0; i < SIGNALS.length; i++) if (t >= SIGNALS[i].t) lab = SIGNALS[i].label;
    return lab;
  }

  function drawClock() {
    $('clockMain').textContent = (t < 0 ? 'スタートまで ' : '') + G.fmtClock(t < 0 ? Math.ceil(-t) : Math.floor(t));
    var nFin = 0;
    events.forEach(function (ev) { if (ev.length === gates.length && ev[gates.length - 1] <= t) nFin++; });
    var sub = signalLabel();
    if (t >= 0 && nFin === N) sub = '全艇フィニッシュ';
    else if (t >= 0 && nFin > 0) sub = 'レース中・フィニッシュ ' + nFin + '/' + N + '艇';
    else if (t >= 0 && imported) sub = '記録の再生';
    // 読み込んだ航跡は、実際の時刻も添える
    if (imported) sub = clockOfDay(imported.startMs + t * 1000) + '　' + sub;
    $('clockSub').textContent = sub;
    $('seek').value = Math.round(t);
    $('raceStatus').textContent = (imported ? '読み込んだ航跡・' : '') + (t < 0 ? 'スタート前（' + signalLabel() + '）' :
      nFin === N ? 'レース終了' : nFin === 0 && imported ? 'スタート後' : 'レース中');
  }

  function ensureBoardRows() {
    if (boardRows.length) return;
    var tbody = $('board').querySelector('tbody');
    for (var i = 0; i < N; i++) {
      var tr = el('tr');
      tr.dataset.i = i;
      var rank = el('td', 'rank');
      var sail = el('td', 'sail');
      var dot = el('span', 'dot');
      dot.style.background = color(i);
      var sailText = el('span');
      sail.appendChild(dot); sail.appendChild(sailText);
      var name = el('td', 'name'), st = el('td', 'st'), spd = el('td', 'spd'), gap = el('td', 'gap');
      [rank, sail, name, st, spd, gap].forEach(function (c) { tr.appendChild(c); });
      tbody.appendChild(tr);
      boardRows.push({ tr: tr, rank: rank, sail: sailText, name: name, st: st, spd: spd, gap: gap });
    }
  }

  function drawBoard() {
    ensureBoardRows();
    var rows = RT.race.standings(gates, events, t, boatAt);
    var tbody = $('board').querySelector('tbody');
    var winner = rows[0].finished ? rows[0] : null;
    var lead = null;
    rows.forEach(function (r) { if (!lead && r.started && !r.finished) lead = r; });
    rows.forEach(function (r) {
      var br = boardRows[r.i], b = fleet[r.i];
      br.rank.textContent = r.rank === null ? '–' : r.rank;
      br.sail.textContent = b.sail;
      br.name.textContent = b.name;
      br.st.textContent = r.status;
      br.spd.textContent = fmtKt(boatAt(r.i, t).spd);
      var gap = '';
      if (r.finished) {
        var behind = r.finishTime - winner.finishTime;
        gap = r === winner ? G.fmtClock(r.finishTime) :
          behind < 10 ? '+' + behind.toFixed(1) + '秒' : '+' + G.fmtClock(behind);
      }
      else if (r.started) {
        if (winner) gap = 'あと' + Math.round(r.togo) + 'm';
        else gap = r === lead ? '先頭' : '+' + Math.round(r.togo - lead.togo) + 'm';
      }
      br.gap.textContent = gap;
      br.tr.classList.toggle('is-selected', isSel(r.i));
      tbody.appendChild(br.tr);
    });
    updateCards(rows);
  }

  /* 選んだ艇のカード。枠は選択が変わったときだけ作り、数値だけを毎回書き換える
   * （作り直し続けると、×ボタンのクリックを取りこぼすため）。 */
  var cards = [];
  function buildCards() {
    var box = $('boatCards');
    box.textContent = '';
    cards = state.selected.map(function (i) {
      var card = el('div', 'card');
      var head = el('div', 'card-head');
      var title = el('div', 'card-title');
      var dot = el('span', 'dot');
      dot.style.background = color(i);
      var titleText = el('span');
      title.appendChild(dot); title.appendChild(titleText);
      var close = el('button', 'card-close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'この艇の選択を解除');
      close.addEventListener('click', function () { toggleSelect(i); });
      head.appendChild(title); head.appendChild(close);
      card.appendChild(head);
      var stats = el('div', 'stats'), vals = {};
      [['spd', '艇速'], ['hdg', '針路'], ['rank', '順位']].forEach(function (p) {
        var st = el('div', 'stat');
        st.appendChild(el('div', 'stat-label', p[1]));
        vals[p[0]] = el('div', 'stat-value');
        st.appendChild(vals[p[0]]);
        stats.appendChild(st);
      });
      card.appendChild(stats);
      var list = el('ul', 'events');
      card.appendChild(list);
      var legs = el('ul', 'legsum');
      card.appendChild(legs);
      box.appendChild(card);
      return { i: i, title: titleText, vals: vals, list: list, legs: legs, shown: -1 };
    });
  }
  function updateCards(rows) {
    cards.forEach(function (c) {
      var b = fleet[c.i], s = boatAt(c.i, t), row = null;
      rows.forEach(function (r) { if (r.i === c.i) row = r; });
      c.title.textContent = b.sail + '　' + b.name;
      c.vals.spd.textContent = fmtKt(s.spd) + ' kt';
      c.vals.hdg.textContent = G.fmtDeg(course.toMag(s.hdg));
      c.vals.rank.textContent = row && row.rank !== null ? row.rank + ' 位' : '–';
      var n = 0;
      events[c.i].forEach(function (tc) { if (tc <= t) n++; });
      if (n === c.shown) return;
      c.shown = n;
      c.list.textContent = '';
      events[c.i].slice(0, n).forEach(function (tc, g) {
        var li = el('li');
        li.appendChild(el('b', null, gates[g].doneLabel));
        li.appendChild(document.createTextNode(' ' + G.fmtClock(tc)));
        c.list.appendChild(li);
      });
      // スタートと、走り終えたレグのコース取り
      c.legs.textContent = '';
      var ss = legStats[c.i][0];
      if (n >= 1 && ss) {
        var sl = el('li');
        sl.appendChild(el('b', null, 'スタート'));
        sl.appendChild(document.createTextNode(' ' + fmtDelay(ss.time) + '・本部船から' + Math.round(ss.fromCb) +
          'm（' + ss.zone + '）・' + fmtKt(ss.speed) + 'kt'));
        c.legs.appendChild(sl);
      }
      for (var j = 1; j < n; j++) {
        var ls = legStats[c.i][j], def = legDefs[j];
        if (!ls || def.kind === 'reach') continue;
        var line = el('li');
        line.appendChild(el('b', null, def.name));
        line.appendChild(document.createTextNode(' ' + ls.side +
          (ls.tacks !== null ? '・タック' + ls.tacks + '回' : '') + '・' + Math.round(ls.dist) + 'm'));
        c.legs.appendChild(line);
      }
    });
  }

  // ---------- 分析（レグごとのコース取り） ----------
  var anaRows = [];
  function ensureAnaRows() {
    if (anaRows.length) return;
    var tbody = $('anaTable').querySelector('tbody');
    for (var i = 0; i < N; i++) {
      var tr = el('tr');
      tr.dataset.i = i;
      var rank = el('td', 'rank');
      var name = el('td', 'name');
      var dot = el('span', 'dot');
      dot.style.background = color(i);
      var nameText = el('span');
      name.appendChild(dot); name.appendChild(nameText);
      var side = el('td', 'side');
      var bar = el('div', 'sidebar');
      var range = el('div', 'sidebar-range');
      range.style.background = color(i);
      var mean = el('div', 'sidebar-mean');
      bar.appendChild(range); bar.appendChild(mean);
      var sideText = el('div', 'side-text');
      side.appendChild(bar); side.appendChild(sideText);
      var tacks = el('td', 'num'), time = el('td', 'num'), dist = el('td', 'num');
      [rank, name, side, tacks, time, dist].forEach(function (c) { tr.appendChild(c); });
      tbody.appendChild(tr);
      anaRows.push({ tr: tr, rank: rank, name: nameText, bar: bar, range: range, mean: mean, sideText: sideText, tacks: tacks, time: time, dist: dist });
    }
  }

  /* スタート信号からの秒数。「+2.5秒」は信号の2.5秒後にラインを切ったという意味。 */
  function fmtDelay(sec) { return (sec >= 0 ? '+' : '−') + Math.abs(sec).toFixed(1) + '秒'; }

  function setAnaMode(isStart) {
    $('anaHL').textContent = isStart ? '下マーク' : '左';
    $('anaHR').textContent = isStart ? '本部船' : '右';
    $('anaH1').textContent = isStart ? '遅れ' : 'タック';
    $('anaH2').textContent = isStart ? '艇速' : '所要';
    $('anaH3').textContent = isStart ? '信号時' : '距離';
    $('anaHintLeg').hidden = isStart;
    $('anaHintStart').hidden = !isStart;
    var info = $('anaInfo');
    info.hidden = !isStart;
    if (isStart) {
      var bias = RT.analysis.lineBias(course);
      info.textContent = 'ラインの有利不利: ' + (Math.abs(bias) < 1 ? 'ほぼなし' :
        (bias > 0 ? '下マーク側' : '本部船側') + 'が約' + Math.abs(bias).toFixed(0) + 'm 風上で有利');
    }
  }

  /* スタートの表。ラインを切った順に並べる。 */
  function drawStartTable(tbody) {
    var list = [];
    for (var i = 0; i < N; i++) {
      var s = legStats[i][0];
      list.push({ i: i, s: s && events[i][0] <= t ? s : null });
    }
    list.sort(function (a, b) {
      if (!!a.s !== !!b.s) return a.s ? -1 : 1;
      return a.s ? a.s.time - b.s.time : a.i - b.i;
    });
    list.forEach(function (r, k) {
      var row = anaRows[r.i], s = r.s;
      row.rank.textContent = s ? k + 1 : '–';
      row.name.textContent = fleet[r.i].name;
      row.bar.style.visibility = s ? 'visible' : 'hidden';
      row.range.style.width = '0';
      row.sideText.textContent = s ? '本部船から' + Math.round(s.fromCb) + 'm' : (t < 0 ? 'スタート前' : '');
      if (s) {
        // 風上に向かって見た並び: 左端が下マーク、右端が本部船
        row.mean.style.left = clamp(100 * (1 - s.frac), 0, 100).toFixed(1) + '%';
        row.bar.title = s.zone + '・' + s.tack + 'タック';
      }
      row.tacks.textContent = s ? fmtDelay(s.time) : '–';
      row.time.textContent = s ? fmtKt(s.speed) + 'kt' : '–';
      row.dist.textContent = s ? (s.gapAtGun >= 0 ? '' : '−') + Math.abs(s.gapAtGun).toFixed(0) + 'm' : '–';
      row.tr.classList.toggle('is-selected', isSel(r.i));
      tbody.appendChild(row.tr);
    });
  }

  function drawAnalysis() {
    ensureAnaRows();
    var j = state.anaLeg, def = legDefs[j];
    var tbody = $('anaTable').querySelector('tbody');
    setAnaMode(j === 0);
    if (j === 0) { drawStartTable(tbody); return; }
    // 帯の目盛りは、このレグで一番大きく左右に出た艇に合わせる
    var scale = 1;
    legStats.forEach(function (L) {
      if (L[j]) scale = Math.max(scale, Math.abs(L[j].latMin), Math.abs(L[j].latMax));
    });
    var list = [];
    for (var i = 0; i < N; i++) {
      var s = legStats[i][j];
      list.push({ i: i, s: s && events[i][j] <= t ? s : null });   // 再生時刻までに走り終えたレグだけ
    }
    list.sort(function (a, b) {
      if (!!a.s !== !!b.s) return a.s ? -1 : 1;
      return a.s ? a.s.time - b.s.time : a.i - b.i;
    });
    list.forEach(function (r, k) {
      var row = anaRows[r.i], s = r.s;
      var showSide = !!s && def.kind !== 'reach';
      row.rank.textContent = s ? k + 1 : '–';
      row.name.textContent = fleet[r.i].name;
      row.bar.style.visibility = showSide ? 'visible' : 'hidden';
      row.sideText.textContent = showSide ? s.side : (s ? '' : '走行中');
      if (showSide) {
        var lo = 50 + 50 * s.latMin / scale, hi = 50 + 50 * s.latMax / scale;
        row.range.style.left = lo.toFixed(1) + '%';
        row.range.style.width = Math.max(2, hi - lo).toFixed(1) + '%';
        row.mean.style.left = (50 + 50 * s.latMean / scale).toFixed(1) + '%';
        row.bar.title = '左 ' + Math.round(Math.max(0, -s.latMin)) + 'm 〜 右 ' + Math.round(Math.max(0, s.latMax)) + 'm';
      }
      row.tacks.textContent = s && s.tacks !== null ? s.tacks : '–';
      row.time.textContent = s ? G.fmtClock(s.time) : '–';
      row.dist.textContent = s ? Math.round(s.dist) + 'm' : '–';
      row.tr.classList.toggle('is-selected', isSel(r.i));
      tbody.appendChild(row.tr);
    });
  }

  // ---------- 運営パネル ----------
  var FIELDS = [
    ['pWind', 'windMag'], ['pD14', 'd14'], ['pStartLen', 'startLen'],
    ['pFinLen', 'finLen'], ['pLaps', 'laps'], ['pWindKn', 'windKn']
  ];

  function fillInputs() {
    var p = curParams();
    FIELDS.forEach(function (f) { $(f[0]).value = p[f[1]]; });
    $('pWindRange').value = p.windMag;
  }
  /* 設定値の書き込み先。読み込んだ記録が風軸を決めている間は、風軸だけはその場かぎりの値を書き換える。 */
  function setParam(key, v) {
    if (imported && imported.relocate && imported.relocate[key] !== undefined) imported.relocate[key] = v;
    else state.params[key] = v;
  }

  function markRow(name, pt, extra, right) {
    var tr = el('tr');
    tr.appendChild(el('td', null, name));
    var mid = el('td', 'pos');
    var p = course.latLon(pt);
    mid.appendChild(el('div', null, G.fmtLat(p.lat)));
    mid.appendChild(el('div', null, G.fmtLon(p.lon)));
    if (extra) mid.appendChild(el('div', 'moved', extra));
    tr.appendChild(mid);
    tr.appendChild(el('td', null, right));
    return tr;
  }
  function brgDist(a, b) {
    return G.fmtDeg(course.toMag(G.bearing(a, b))) + ' ' + Math.round(G.dist(a, b)) + 'm';
  }

  function renderOps() {
    var M = course.marks;
    $('declNote').textContent = '真方位 ' + G.fmtDeg(course.windTrue) + '（偏差 西偏' + course.decl.toFixed(1) + '°で換算）';
    var est = RT.perf.estimate(course);
    var e = $('estimate');
    e.textContent = '';
    e.appendChild(document.createTextNode('先頭艇の所要時間の目安 '));
    e.appendChild(el('b', null, '約' + Math.round(est / 60) + '分'));
    e.appendChild(document.createTextNode('（全長 ' + (course.length / 1000).toFixed(2) + ' km）'));

    var tb = $('markTable').querySelector('tbody');
    tb.textContent = '';
    tb.appendChild(markRow('本部船', course.cb, null, '基準'));
    RT.course.MARKS.forEach(function (m) {
      var mv = imported && imported.fromOps ? null : course.moved[m.key];
      tb.appendChild(markRow(m.name, M[m.key],
        mv != null ? '目標から ' + Math.round(mv) + 'm' : (imported && imported.fromOps && curOverrides()[m.key] ? '運営艇の記録' : null),
        '本部船から ' + brgDist(course.cb, M[m.key])));
    });

    var lt = $('legTable').querySelector('tbody');
    lt.textContent = '';
    [['スタートライン（本部船→下マーク）', brgDist(course.cb, M.pin)],
      ['下マーク→上マーク', brgDist(M.m4, M.m1)],
      ['下マーク→フィニッシュ', brgDist(M.m4, course.finMid)],
      ['フィニッシュライン', Math.round(G.dist(course.cb, M.fin)) + 'm']].forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', null, r[0]));
      tr.appendChild(el('td', null, r[1]));
      lt.appendChild(tr);
    });
    $('btnResetMarks').hidden = Object.keys(curOverrides()).length === 0;
  }

  var rebuildTimer = null;
  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(function () { save(); rebuild(true); }, 120);
  }

  function bindOps() {
    FIELDS.forEach(function (f) {
      var input = $(f[0]);
      input.addEventListener('input', function () {
        var v = parseFloat(input.value);
        if (!isFinite(v)) return;
        v = clamp(v, parseFloat(input.min), parseFloat(input.max));
        if (f[1] === 'laps') v = Math.round(v);
        if (f[1] === 'windMag') { v = G.norm360(v); $('pWindRange').value = v; }
        setParam(f[1], v);
        scheduleRebuild();
      });
      input.addEventListener('change', function () { input.value = curParams()[f[1]]; });
    });
    $('pWindRange').addEventListener('input', function () {
      setParam('windMag', parseFloat(this.value));
      $('pWind').value = curParams().windMag;
      scheduleRebuild();
    });
    $('btnCbCenter').addEventListener('click', function () {
      var c = map.getCenter();
      setCb(c.lat, c.lng);
      clearOverrides();
      save(); rebuild(true); fitCourse();
    });
    $('btnCbHere').addEventListener('click', function () {
      if (!navigator.geolocation) { toast('この端末では現在地を取得できません。'); return; }
      toast('現在地を取得しています…');
      navigator.geolocation.getCurrentPosition(function (pos) {
        setCb(pos.coords.latitude, pos.coords.longitude);
        clearOverrides();
        save(); rebuild(true); fitCourse();
        toast('本部船を現在地に置きました（精度 約' + Math.round(pos.coords.accuracy) + 'm）。');
      }, function () {
        toast('現在地を取得できませんでした。位置情報の許可を確認してください。');
      }, { enableHighAccuracy: true, timeout: 15000 });
    });
    $('btnResetMarks').addEventListener('click', function () {
      clearOverrides();
      save(); rebuild(true);
    });
    $('btnResetAll').addEventListener('click', function () {
      state.params = Object.assign({}, RT.course.DEFAULTS);
      state.overrides = {};
      state.boats = defaultBoats();
      save(); fillInputs(); renderCrew(); refreshLabels(); rebuild(false); fitCourse();
      toast('初期値に戻しました。');
    });
    $('btnSequence').addEventListener('click', function () {
      t = -310;
      $('speed').value = '1'; speed = 1;
      setPlaying(true);
      dirty = true;
      toast('予告信号の10秒前から等速で再生します。');
    });
    $('optSound').addEventListener('change', function () {
      state.sound = this.checked;
      if (state.sound) beep(120, 880);
    });
  }

  // ---------- 選手 ----------
  function renderCrew() {
    var tb = $('crewTable').querySelector('tbody');
    tb.textContent = '';
    state.boats.forEach(function (b, i) {
      var tr = el('tr');
      var c0 = el('td');
      var dot = el('span', 'dot');
      dot.style.background = color(i);
      c0.appendChild(dot);
      tr.appendChild(c0);
      [['sail', 8, 'セール番号'], ['name', 12, '名前']].forEach(function (f) {
        var td = el('td');
        var input = el('input');
        input.type = 'text';
        input.maxLength = f[1];
        input.value = b[f[0]];
        input.setAttribute('aria-label', (i + 1) + '艇目の' + f[2]);
        input.addEventListener('input', function () {
          b[f[0]] = input.value.trim();
          save(); refreshLabels(); dirty = true;
        });
        td.appendChild(input);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
  }

  // ---------- 航跡ファイルの読み込み ----------
  var importSerial = 0;

  /* items = [{ name: ファイル名, text: 中身 }]。読めたファイルだけを使う。 */
  function importTexts(items) {
    var tracks = [], errors = [];
    items.forEach(function (it) {
      try { tracks.push(RT.importer.parse(it.text, it.name)); }
      catch (e) { errors.push((it.name || 'ファイル') + ': ' + e.message); }
    });
    if (!tracks.length) { toast(errors[0] || '読み込めるファイルがありませんでした。'); return false; }
    tracks.sort(function (a, b) { return a.sail < b.sail ? -1 : a.sail > b.sail ? 1 : 0; });
    var first = Infinity;
    tracks.forEach(function (tr) { first = Math.min(first, tr.first); });
    var next = {
      tracks: tracks,
      startMs: Math.floor(first / 1000) * 1000,   // とりあえず記録の先頭をスタート時刻にしておく
      relocate: null, overrides: {}, serial: ++importSerial
    };
    // 運営艇の記録は順位表に入れない（運営艇の記録しか無いときは、それを表示する）
    next.racers = tracks.filter(function (tr) { return !tr.ops; });
    if (!next.racers.length) next.racers = tracks;
    // 運営艇がスタート信号とマークの位置を記録していれば、それでスタート時刻とコースを決める
    next.starts = RT.importer.starts(tracks);
    if (next.starts.length) next.startMs = next.starts[0];
    var oc = RT.importer.opsCourse(tracks, next.startMs);
    if (oc) {
      next.relocate = oc.relocate; next.overrides = oc.overrides; next.fromOps = true;
    } else {
      // いつものコースから5km以上離れた記録（陸上での試し撮りなど）は、表示の間だけ本部船を航跡の出発点に置く
      var home = RT.course.build(state.params, state.overrides);
      var f0 = next.racers[0].fixes[0];
      var p0 = home.proj.toXY(f0.lat, f0.lon);
      if (Math.hypot(p0.x, p0.y) > 5000) next.relocate = { lat: f0.lat, lon: f0.lon };
    }

    var prev = imported;
    imported = next;
    try {
      rebuild(false);
    } catch (e) {
      imported = prev; fleetKey = '';
      rebuild(false);
      toast(e.message);
      return false;
    }
    if (next.starts.length) { t = clamp(0, sim.t0, sim.tEnd); dirty = true; }   // スタートの瞬間を表示する
    setPlaying(false);
    fillInputs();
    renderData();
    fitCourse();
    toast(tracks.length + '件の航跡を読み込みました。' +
      (next.fromOps ? '運営艇の記録からコースを設定しました。' : '') +
      (errors.length ? '読めなかったファイルが' + errors.length + '件あります。' : ''));
    return true;
  }

  function clearImport() {
    imported = null;
    setPlaying(false);
    rebuild(false);
    fillInputs();
    renderData();
    fitCourse();
  }

  /* 1日に複数レースある記録で、見るレースを切り替える */
  function chooseRace(idx) {
    if (!imported || imported.starts[idx] === undefined) return;
    imported.startMs = imported.starts[idx];
    var oc = RT.importer.opsCourse(imported.tracks, imported.startMs);
    if (oc) { imported.relocate = oc.relocate; imported.overrides = oc.overrides; }
    rebuild(false);
    t = clamp(0, sim.t0, sim.tEnd);
    dirty = true;
    setPlaying(false);
    fillInputs();
    renderData();
    fitCourse();
  }

  /* 選手タブの「航跡データ」欄。いま何を表示しているかと、読み込んだ航跡の一覧。 */
  function renderData() {
    var on = !!imported;
    $('modeBadge').textContent = on ? '読み込んだ航跡' : '試作・シミュレーション';
    $('importBox').hidden = !on;
    $('crewSection').hidden = on;
    $('dataInfo').textContent = !on ? 'いまはシミュレーションの艇団を表示しています。' :
      imported.racers.length + '艇の航跡を表示しています。' +
      (imported.fromOps ? '運営艇の記録から、コースとスタート時刻を設定しました。保存してあるコースは変わりません。' :
        imported.relocate ? 'いつものコースから離れた場所の記録なので、本部船とマークを航跡の近くに仮置きしています。保存してあるコースは変わりません。' : '');
    if (!on) return;
    $('startTime').value = toLocalInput(imported.startMs);

    // レースの選択（運営艇がスタート信号を記録しているとき）
    var raceSel = $('raceSel');
    $('raceRow').hidden = imported.starts.length === 0;
    raceSel.textContent = '';
    imported.starts.forEach(function (ms, i) {
      var opt = el('option', null, '第' + (i + 1) + 'レース（' + clockOfDay(ms) + ' スタート）');
      opt.value = i;
      raceSel.appendChild(opt);
    });
    var cur = imported.starts.indexOf(imported.startMs);
    if (cur >= 0) raceSel.value = cur;

    var tb = $('trackTable').querySelector('tbody');
    tb.textContent = '';
    imported.tracks.forEach(function (tr) {
      var idx = imported.racers.indexOf(tr);        // 順位表に出ている艇なら、その色
      var row = el('tr');
      var c0 = el('td');
      var dot = el('span', 'dot');
      dot.style.background = idx >= 0 ? color(idx) : '#0c2340';
      if (idx < 0) dot.style.borderRadius = '2px';
      c0.appendChild(dot);
      c0.appendChild(document.createTextNode((tr.sail || '—') + '　' + (tr.name || '') + (tr.ops ? '（運営艇）' : '')));
      row.appendChild(c0);
      var c1 = el('td', 'pos');
      c1.appendChild(el('div', null, clockOfDay(tr.first) + ' 〜 ' + clockOfDay(tr.last)));
      c1.appendChild(el('div', null, tr.fixes.length + '点' + (tr.dropped ? '（精度の悪い' + tr.dropped + '点を除外）' : '')));
      if (tr.ops) {
        var nMark = tr.marks.filter(function (m) { return m.type === 'm1' || m.type === 'm4' || m.type === 'fin'; }).length;
        c1.appendChild(el('div', null, 'マークの記録 ' + nMark + '件・スタート ' + RT.importer.starts([tr]).length + '件'));
      }
      row.appendChild(c1);
      row.appendChild(el('td', null, tr.medAcc === null ? '' : '精度 ±' + Math.round(tr.medAcc) + 'm'));
      tb.appendChild(row);
    });
  }

  // ---------- 音 ----------
  var actx = null;
  function beep(ms, freq) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = freq;
      o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.25, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + ms / 1000);
      o.start(); o.stop(actx.currentTime + ms / 1000);
    } catch (e) { /* 音が出せない環境では黙って続ける */ }
  }
  function speak(text) {
    try {
      if (!window.speechSynthesis) return;
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP'; u.rate = 1.1;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 同上 */ }
  }
  function cues(prev, now) {
    if (!state.sound || speed !== 1) return;
    for (var s = Math.floor(prev) + 1; s <= Math.floor(now); s++) {
      for (var i = 0; i < SIGNALS.length; i++) {
        var d = SIGNALS[i].t - s;
        if (d === 30 || d === 20 || d === 10) speak(SIGNALS[i].name + 'まで' + d + '秒');
        else if (d >= 1 && d <= 5) beep(120, 880);
        else if (d === 0) { beep(900, 660); speak(SIGNALS[i].name); }
      }
    }
  }

  // ---------- 再生 ----------
  function setPlaying(on) {
    playing = on;
    $('btnPlay').textContent = on ? '❚❚' : '▶';
    $('btnPlay').setAttribute('aria-label', on ? '一時停止' : '再生');
  }

  var toastTimer = null, toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = el('div');
      toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:1200;' +
        'max-width:80%;padding:8px 14px;border-radius:8px;background:rgba(12,35,64,.94);color:#fff;font-size:13px;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.3);';
      $('stage').appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 3500);
  }

  var lastTs = null;
  function frame(ts) {
    if (playing && lastTs !== null) {
      var d = Math.min(0.25, (ts - lastTs) / 1000);
      var prev = t;
      t = Math.min(sim.tEnd, t + d * speed);
      cues(prev, t);
      if (t >= sim.tEnd) setPlaying(false);
    }
    lastTs = ts;
    drawBoats();
    drawClock();
    if (dirty || ts - lastBoard > 200) {
      drawBoard();
      if (state.tab === 'analysis') drawAnalysis();
      lastBoard = ts;
    }
    dirty = false;
    requestAnimationFrame(frame);
  }

  function bindUi() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (x) {
          var on = x === tab;
          x.classList.toggle('is-active', on);
          x.setAttribute('aria-selected', on ? 'true' : 'false');
          $('tab-' + x.dataset.tab).hidden = !on;
        });
        state.tab = tab.dataset.tab;
        dirty = true;
      });
    });
    $('optOrient').value = state.orient;
    $('optOrient').addEventListener('change', function () {
      state.orient = this.value;
      save(); drawCourse(); fitCourse();
    });
    $('anaLeg').addEventListener('change', function () { state.anaLeg = parseInt(this.value, 10); dirty = true; });
    $('anaTrailOnly').addEventListener('change', function () { state.anaTrailOnly = this.checked; dirty = true; });
    $('btnPlay').addEventListener('click', function () {
      if (!playing && t >= sim.tEnd) t = sim.t0;
      setPlaying(!playing);
    });
    $('seek').addEventListener('input', function () { t = parseFloat(this.value); dirty = true; });
    $('speed').addEventListener('change', function () { speed = parseFloat(this.value); });
    $('optLabel').value = state.label;
    $('optLabel').addEventListener('change', function () { state.label = this.value; save(); refreshLabels(); });
    $('optTail').value = state.tail;
    $('optTail').addEventListener('change', function () { state.tail = this.value; save(); dirty = true; });
    $('btnClearSel').addEventListener('click', clearSelection);
    // 順位表と分析表: 行をクリックしたら、その艇の選択を切り替える
    ['board', 'anaTable'].forEach(function (id) {
      $(id).querySelector('tbody').addEventListener('click', function (e) {
        var tr = e.target.closest('tr');
        if (tr) toggleSelect(parseInt(tr.dataset.i, 10));
      });
    });
    // 航跡ファイルの読み込み
    $('btnLoadTracks').addEventListener('click', function () { $('fileTracks').click(); });
    $('fileTracks').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = '';
      if (!files.length) return;
      Promise.all(files.map(function (f) {
        return f.text().then(function (text) { return { name: f.name, text: text }; });
      })).then(importTexts).catch(function () { toast('ファイルを読み込めませんでした。'); });
    });
    $('btnUseSim').addEventListener('click', clearImport);
    $('raceSel').addEventListener('change', function () { chooseRace(parseInt(this.value, 10)); });
    $('startTime').addEventListener('change', function () {
      if (!imported) return;
      var ms = new Date(this.value).getTime();
      if (!isFinite(ms)) { this.value = toLocalInput(imported.startMs); return; }
      var prev = imported.startMs;
      imported.startMs = ms;
      try {
        rebuild(false);
        t = clamp(0, sim.t0, sim.tEnd);   // スタートの瞬間を表示する
        dirty = true;
      } catch (e) {
        imported.startMs = prev;
        rebuild(false);
        this.value = toLocalInput(prev);
        toast(e.message);
      }
    });
    $('optBase').value = state.base;
    $('optBase').addEventListener('change', function () { state.base = this.value; save(); setBase(state.base); });
    $('panelToggle').addEventListener('click', function () { $('app').classList.toggle('panel-open'); });
    map.on('click', function () { $('app').classList.remove('panel-open'); });
    document.addEventListener('keydown', function (e) {
      if (e.code !== 'Space') return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'button' || tag === 'textarea') return;
      e.preventDefault();
      $('btnPlay').click();
    });
  }

  // ---------- 起動 ----------
  setBase(state.base);
  fillInputs();
  bindUi();
  bindOps();
  renderCrew();
  renderData();
  course = RT.course.build(state.params, state.overrides);
  map.setView([state.params.lat, state.params.lon], 15);
  rebuild(false);
  fitCourse();
  requestAnimationFrame(frame);

  // 動作確認用
  window.RTApp = {
    state: state,
    map: map,
    importTexts: importTexts,
    clearImport: clearImport,
    imported: function () { return imported; },
    sim: function () { return sim; },
    info: function () { return { t: t, playing: playing, speed: speed, tEnd: sim.tEnd, gates: gates.length, events: events.map(function (e) { return e.length; }) }; },
    seek: function (v) { t = clamp(v, sim.t0, sim.tEnd); dirty = true; }
  };
})();
