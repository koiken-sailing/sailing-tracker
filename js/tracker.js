/* スマホで航跡を記録する画面。
 *
 * 記録はまず端末の中（ブラウザの保存領域）に置く。
 * 「観戦ページに公開する」を選んだ記録だけ、記録を終えたあとに送信する（js/cloud.js）。
 * 送るのは公開してよい範囲（海の上）の位置だけで、選ばなければ外部へは一切送信しない。
 * 画面が消えると測位が止まるので、画面を点けたままにする機能（Wake Lock）を使う。
 * 途中でページが閉じても、保存済みの分から続きを記録できる。 */
(function () {
  'use strict';

  var META = 'yt-track-meta';
  var CHUNK = 'yt-track-chunk-';
  var PROFILE = 'yt-track-profile';
  var CHUNK_SIZE = 20;     // この点数がたまるごとに保存する
  var MIN_GAP_MS = 900;    // 記録の最小間隔（およそ1秒に1点）
  // これ以上位置が届かなければ「途切れ」と表示する。
  // iPhone は止まっている間、位置の通知を10秒に1回ほどに間引くので、短くしすぎると誤警報になる。
  var STALE_MS = 30000;
  var HOLD_MS = 1500;      // 航海モードを解除する長押しの時間
  var MAX_LOG = 400;
  var KN = 0.514444;
  var JOIN_WAIT_MS = 8000; // 開始時に合言葉を確かめる通信を待つ長さ（これを過ぎたら記録を先に始める）
  var LIVE_PREV = 'yt-live-prev';   // 前回リアルタイムで送った記録（次に記録を始めたときに、送り先から消す）
  var LIVE_EVERY_MS = 5000;         // いまの位置を送る間隔
  var LIVE_CHUNK_MS = 60000;        // 航跡のかたまりを送る間隔
  var LIVE_STEP_MS = 2000;          // 航跡のかたまりは、2秒に1点に間引く

  // 陸上テスト用の入口（アドレスの末尾に ?test=1）。この入口から始めた記録だけ、海の上でなくても送る。
  var LAND_TEST = /[?&]test=1(&|$)/.test(location.search);

  var cloud = window.RT && window.RT.cloud;
  var cloudOn = !!(cloud && cloud.enabled());   // 送り先が設定されているときだけ、公開の機能を出す

  function $(id) { return document.getElementById(id); }
  function round(v, d) { var p = Math.pow(10, d); return Math.round(v * p) / p; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  var store = {
    get: function (k) {
      try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; }
    },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
    },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* 消せなくても続ける */ } }
  };

  var st = {
    meta: null,          // { sail, name, started, chunks, stopped, log }
    fixes: [],           // [時刻ms, 緯度, 経度, 精度m, 速さm/s, 進行方位°]
    saved: 0,            // 保存済みの点数
    recording: false,
    watchId: null,
    wake: null,
    wakeSupported: 'wakeLock' in navigator,
    beganAt: 0,          // 記録を始めた（再開した）時刻
    lastFixAt: 0,        // 最後に位置を受け取った時刻
    lastAcc: null,
    lastSpeed: null,
    gpsError: 0,
    dist: 0,
    storageFull: false,
    timer: null,
    wakePending: false,
    nav: null,           // コース設定ナビの地図（初めて開いたときに作る）
    navSel: null,        // ナビで案内している目標（null なら、まだ打っていない最初のもの）
    navArrived: null,    // 到着の合図を鳴らした目標
    send: '',            // 送信の状態: ''（未送信または送信済み）/ sending / none / net / passcode / server
    live: { nowAt: 0, chunkFrom: 0, busy: false, joinAt: 0, ok: null, err: '', sent: 0 },   // リアルタイムの送信の状態
    map: null            // リアルタイムモードの地図（初めて開いたときに作る）
  };

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371008.8, r = Math.PI / 180;
    var dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /* 画面が消えた・GPS が切れた等の出来事を残す（あとで記録の抜けを調べるため） */
  function logEvent(type, detail) {
    if (!st.meta || st.meta.log.length >= MAX_LOG) return;
    st.meta.log.push([Date.now(), type, detail || '']);
    store.set(META, st.meta);
  }

  function flush(force) {
    if (!st.meta) return;
    var n = st.fixes.length - st.saved;
    if (n <= 0 || (!force && n < CHUNK_SIZE)) return;
    if (!store.set(CHUNK + st.meta.chunks, st.fixes.slice(st.saved))) { st.storageFull = true; return; }
    st.meta.chunks++;
    st.saved = st.fixes.length;
    store.set(META, st.meta);
  }

  // ---------- 測位 ----------
  function onPosition(pos) {
    var c = pos.coords, now = Date.now();
    var tms = typeof pos.timestamp === 'number' && pos.timestamp > 1e12 ? Math.round(pos.timestamp) : now;
    // 開始直後に、端末が覚えていた古い位置が届くことがある。記録を始める前の時刻のものは捨てる。
    if (tms < st.beganAt - 2000) return;
    st.lastFixAt = now;
    st.gpsError = 0;
    st.lastAcc = c.accuracy;
    var last = st.fixes[st.fixes.length - 1];
    if (last && tms - last[0] < MIN_GAP_MS) return;
    var spd = typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0 ? round(c.speed, 2) : null;
    var hdg = typeof c.heading === 'number' && isFinite(c.heading) ? round(c.heading, 1) : null;
    if (last) {
      var d = haversine(last[1], last[2], c.latitude, c.longitude);
      if (c.accuracy <= 30) st.dist += d;
      if (spd === null && tms > last[0]) st.lastSpeed = d / ((tms - last[0]) / 1000);
    }
    if (spd !== null) st.lastSpeed = spd;
    st.fixes.push([tms, round(c.latitude, 6), round(c.longitude, 6), round(c.accuracy, 1), spd, hdg]);
    if (st.map) st.map.setSelf([tms, c.latitude, c.longitude]);
    if (st.nav) st.nav.setSelf([tms, c.latitude, c.longitude]);
    flush(false);
    render();
  }

  function onError(err) {
    st.gpsError = err && err.code ? err.code : 2;
    logEvent('gps-error', String(st.gpsError));
    render();
  }

  // ---------- 画面を点けたままにする ----------
  function acquireWake() {
    if (!st.wakeSupported || st.wake || st.wakePending) return;
    st.wakePending = true;
    navigator.wakeLock.request('screen').then(function (lock) {
      st.wakePending = false;
      st.wake = lock;
      logEvent('wake-on');
      lock.addEventListener('release', function () {
        st.wake = null;
        logEvent('wake-off');
        render();
      });
      render();
    }).catch(function (e) { st.wakePending = false; logEvent('wake-fail', e && e.name); });
  }
  function releaseWake() {
    if (st.wake) { st.wake.release().catch(function () {}); st.wake = null; }
  }

  // ---------- 記録の開始・終了 ----------
  function showScreen(name) {
    ['setup', 'live', 'done', 'resume'].forEach(function (id) { $(id).hidden = id !== name; });
  }

  function beginRecording(resume) {
    st.meta.stopped = false;
    st.meta.sent = null;   // 続きを記録したら、終了時にもう一度送る
    st.send = '';
    store.set(META, st.meta);
    st.recording = true;
    st.beganAt = Date.now();
    st.gpsError = 0;
    st.lastFixAt = 0;
    st.lastSpeed = null;
    st.watchId = navigator.geolocation.watchPosition(onPosition, onError,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    acquireWake();
    logEvent(resume ? 'resume' : 'start');
    clearInterval(st.timer);
    st.timer = setInterval(render, 1000);
    $('who').textContent = st.meta.sail + '　' + st.meta.name +
      (st.meta.ops ? '（運営艇）' : st.meta.practice ? '（マーク練習）' : '');
    // マーク練習は、上マークと下マークのボタンだけを出す（スタートとフィニッシュは使わない）
    $('opsPanel').hidden = !(st.meta.ops || st.meta.practice);
    $('opsStartBox').hidden = !st.meta.ops;
    $('btnFin').hidden = !st.meta.ops;
    $('sessionNote').hidden = !st.meta.practice;
    renderPlan();
    $('btnLive').hidden = !cloudOn;
    $('liveNote').hidden = !cloudOn;
    st.live = { nowAt: 0, chunkFrom: 0, busy: false, joinAt: 0, ok: null, err: '', sent: 0 };
    renderOps();
    showScreen('live');
    render();
  }

  // ---------- 運営艇の記録（マークの位置とスタート信号） ----------
  var MARK_NAMES = { m1: '上マーク', m4: '下マーク', fin: 'フィニッシュマーク' };
  var SEQ_MS = 5 * 60 * 1000;   // スタート手順は5分前から

  function clock(ms) {
    var d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  /* いまの位置で記録を1件作る。位置がまだ取れていなければ null。 */
  function snapshot(type, atMs) {
    var f = st.fixes[st.fixes.length - 1];
    if (!f) return null;
    return [atMs || Date.now(), type, f[1], f[2], f[3], Math.max(0, Date.now() - f[0])];
  }
  /* スタートの記録を1件作る。位置が取れていなくても、時刻と周回数は残す。 */
  function startMark(atMs) {
    var m = snapshot('start', atMs) || [atMs, 'start', null, null, null, null];
    m[6] = st.meta.laps || 2;
    return m;
  }
  /* ある種類のマークの、最後に打った位置（untilMs を渡すと、その時刻までに打ったもの）。無ければ null。 */
  function markAt(type, untilMs) {
    var last = null;
    st.meta.marks.forEach(function (m) {
      if (m[1] === type && m[2] !== null && m[3] !== null && (untilMs === undefined || m[0] <= untilMs)) last = m;
    });
    return last;
  }
  /* マークを打つ人のための距離の表示。1秒ごとに書き直す。
   *   上下のマークの距離（両方打ってあるとき）
   *   いまの位置から、打ってある各マークまでの距離（次のマークを決めた距離に打つため）
   * 運営艇では、下マークまでの距離がスタートラインの長さ、フィニッシュマークまでの距離がフィニッシュラインの長さになる。 */
  function renderDist() {
    var el = $('opsDist');
    if (!st.meta || !(st.meta.ops || st.meta.practice)) { el.hidden = true; return; }
    var m1 = markAt('m1'), m4 = markAt('m4'), fin = st.meta.ops ? markAt('fin') : null, lines = [];
    function d(a, b) { return Math.round(haversine(a[0], a[1], b[0], b[1])) + 'm'; }
    if (m1 && m4) {
      // 打ち終えたあとの実際のコース: 距離と、下マークから上マークを見た角度（コンパスの読み）
      var ang = axisAngle(m4, m1), txt = '上マーク〜下マーク: ' + d([m1[2], m1[3]], [m4[2], m4[3]]);
      if (ang !== null) {
        var off = Math.round(GEO.norm180(ang - plan().wind));
        txt += '・角度 ' + ang + '°（風軸 ' + plan().wind + '° ' + (off === 0 ? 'のとおり' : 'から ' + (off > 0 ? '+' : '') + off + '°') + '）';
      }
      lines.push(txt);
    }
    var f = st.fixes[st.fixes.length - 1];
    if (f) {
      var here = [f[1], f[2]];
      if (m1) lines.push('いまの位置から上マークまで: ' + d(here, [m1[2], m1[3]]));
      if (m4) lines.push('いまの位置から下マークまで: ' + d(here, [m4[2], m4[3]]) + (st.meta.ops ? '（スタートラインの長さ）' : ''));
      if (fin) lines.push('いまの位置からフィニッシュマークまで: ' + d(here, [fin[2], fin[3]]) + '（フィニッシュラインの長さ）');
    }
    el.textContent = lines.join('\n');
    el.hidden = !lines.length;
  }
  function addMark(ev) {
    st.meta.marks.push(ev);
    store.set(META, st.meta);
    st.navSel = null;      // 打ったら、次の目標を選び直す
    renderOps();
    renderPlan();
  }

  // ---------- コース設定ナビ（最初に打ったマークと、風軸・距離から、残りのマークの目標位置を出す） ----------
  var GEO = window.RT && window.RT.geo;
  var PLAN_DEFAULT = { wind: 200, dist: 600, line: 100 };
  var PLAN_LIMIT = { wind: [0, 359], dist: [50, 3000], line: [10, 500] };
  var FIN_LEN = 50;        // フィニッシュラインの長さの目安 m
  var ARRIVE_M = 10;       // 目標のこの距離以内に入ったら「到着」とする（GPS の誤差が5mほどあるため）
  var TARGET_NAMES = { m1: '上マーク', m4: '下マーク', cb: '本部船の位置', fin: 'フィニッシュマーク' };

  function plan() {
    if (!st.meta.plan) st.meta.plan = Object.assign({}, PLAN_DEFAULT, (store.get(PROFILE) || {}).plan);
    return st.meta.plan;
  }
  function setPlan(key, value) {
    var lim = PLAN_LIMIT[key], v = Math.round(Number(value));
    if (!isFinite(v)) return;
    if (key === 'wind') v = ((v % 360) + 360) % 360;
    v = Math.max(lim[0], Math.min(lim[1], v));
    plan()[key] = v;
    store.set(META, st.meta);
    var prof = store.get(PROFILE) || {};
    prof.plan = st.meta.plan;
    store.set(PROFILE, prof);
    renderPlan();
    renderDist();
  }
  /* 下マークから上マークを見た角度（コンパスの読み、度）。計算の部品が無ければ null。 */
  function axisAngle(from, to) {
    if (!GEO) return null;
    var proj = GEO.projection(from[2], from[3]);
    var brg = GEO.bearing({ x: 0, y: 0 }, proj.toXY(to[2], to[3]));
    return Math.round(GEO.norm360(brg + GEO.declinationWest(from[2], from[3]))) % 360;
  }
  /* 目標位置の計算。基準は下マーク（打ってあれば実際の位置、まだなら上マークから風下へ取った目標）。
   *   上マークの目標 = 下マークから風上へ「上下の距離」
   *   本部船の目標   = 下マークから、風上に向かって右へ「スタートラインの長さ」（運営艇のみ）
   *   フィニッシュマークの目標 = 本部船の風下側（運営艇のみ）
   * 戻り値の targets は [{ key, name, lat, lon, x, y, placed: 打った位置 | null, dev: 目標とのずれ m | null }]。 */
  function planCalc() {
    if (!GEO || !st.meta) return null;
    var m1 = markAt('m1'), m4 = markAt('m4'), fin = st.meta.ops ? markAt('fin') : null;
    var anchor = m4 || m1;
    if (!anchor) return null;
    var pl = plan(), proj = GEO.projection(anchor[2], anchor[3]);
    var decl = GEO.declinationWest(anchor[2], anchor[3]), wt = GEO.norm360(pl.wind - decl);
    function xy(m) { return m ? proj.toXY(m[2], m[3]) : null; }
    var p1 = xy(m1), p4 = xy(m4), targets = [];
    var low = p4 || GEO.offset(p1, wt + 180, pl.dist);          // 下マークの位置（実際、または目標）
    function add(key, p, placed) {
      var q = proj.toLatLon(p), pp = xy(placed);
      targets.push({ key: key, name: TARGET_NAMES[key], lat: q.lat, lon: q.lon, x: p.x, y: p.y,
        placed: placed || null, dev: pp ? GEO.dist(pp, p) : null });
    }
    if (!m4) add('m4', low, null);
    if (m4) add('m1', GEO.offset(low, wt, pl.dist), m1);
    if (st.meta.ops) {
      var cb = GEO.offset(low, wt + 90, pl.line);
      var started = null;
      validStarts().forEach(function (s) { if (s[2] !== null) started = s; });
      add('cb', cb, started);
      var ang = Math.asin(Math.min(1, FIN_LEN / (2 * pl.line))) * 180 / Math.PI;
      add('fin', GEO.offset(cb, wt + 180 + ang, FIN_LEN), fin);
    }
    return { proj: proj, decl: decl, windTrue: wt, targets: targets, m1: m1, m4: m4, fin: fin };
  }
  /* いまの位置から目標までの、距離・方位と、風軸に沿った成分（風上へ何m・右へ何m） */
  function guideTo(calc, t) {
    var f = st.fixes[st.fixes.length - 1];
    if (!f) return null;
    var here = calc.proj.toXY(f[1], f[2]), v = { x: t.x - here.x, y: t.y - here.y };
    var up = GEO.vec(calc.windTrue), right = GEO.vec(calc.windTrue + 90);
    return {
      dist: Math.hypot(v.x, v.y),
      brg: Math.round(GEO.norm360(GEO.bearing(here, t) + calc.decl)) % 360,
      along: v.x * up.x + v.y * up.y,
      cross: v.x * right.x + v.y * right.y
    };
  }
  /* ナビで案内する目標。まだ打っていないもののうち、最初のもの（「次の目標へ」で切り替えられる）。 */
  function navTarget(calc) {
    var open = calc.targets.filter(function (t) { return !t.placed; });
    var list = open.length ? open : calc.targets;
    var sel = null;
    list.forEach(function (t) { if (t.key === st.navSel) sel = t; });
    return sel || list[0] || null;
  }

  /* 設定の欄と、目標までの距離の一覧を書き直す。ナビ画面が開いていれば、そちらも書き直す。 */
  function renderPlan() {
    var on = !!st.meta && (st.meta.ops || st.meta.practice) && !!GEO;
    $('planBox').hidden = !on;
    if (!on) return;
    var pl = plan();
    [['plWind', 'wind'], ['plDist', 'dist'], ['plLine', 'line']].forEach(function (p) {
      if (document.activeElement !== $(p[0])) $(p[0]).value = pl[p[1]];
    });
    $('plLineRow').hidden = !st.meta.ops;
    var calc = planCalc(), info = $('planInfo'), lines = [];
    if (!calc) {
      lines.push('上マークか下マークを打つと、もう一方の目標位置が出ます。');
    } else {
      calc.targets.forEach(function (t) {
        if (t.placed) { lines.push(t.name + ': 目標とのずれ ' + Math.round(t.dev) + 'm'); return; }
        var g = guideTo(calc, t);
        lines.push(t.name + 'の目標まで: ' + (g ? Math.round(g.dist) + 'm・方位 ' + g.brg + '°' : '位置を取得中'));
      });
    }
    info.textContent = lines.join('\n');
    info.hidden = false;
    $('btnNav').disabled = !calc;
    renderNav(calc);
  }

  // ---------- ナビ画面（地図に、目標のマーク位置と自分の位置を出す） ----------
  function latlon(m) { return m ? { lat: m[2], lon: m[3] } : null; }
  function renderNav(calc) {
    if ($('navView').hidden) return;
    if (!calc) { leaveNav(); return; }
    var t = navTarget(calc), g = t ? guideTo(calc, t) : null;
    var top = document.querySelector('.nv-top');
    $('nvName').textContent = t ? '目標: ' + t.name + (t.placed ? '（打ってあります。目標とのずれ ' + Math.round(t.dev) + 'm）' : '') : '';
    $('nvDist').textContent = g ? Math.round(g.dist) + 'm' : '–';
    $('nvBrg').textContent = g ? '方位 ' + g.brg + '°' : '位置を取得中';
    $('nvAlong').textContent = g ? (g.along >= 0 ? '風上へ ' : '風下へ ') + Math.round(Math.abs(g.along)) + 'm' : '';
    $('nvCross').textContent = g ? (g.cross >= 0 ? '右へ ' : '左へ ') + Math.round(Math.abs(g.cross)) + 'm' : '';
    var arrived = !!g && g.dist <= ARRIVE_M;
    top.classList.toggle('arrived', arrived);
    if (arrived && st.navArrived !== t.key) {
      // 到着の合図（短い音を2回）
      st.navArrived = t.key;
      var ctx = soundContext();
      if (ctx) { beepAt(ctx, ctx.currentTime + 0.02, 0.18, 1040); beepAt(ctx, ctx.currentTime + 0.3, 0.18, 1040); }
    } else if (g && g.dist > ARRIVE_M * 2.5 && st.navArrived === (t && t.key)) {
      st.navArrived = null;
    }
    var drop = $('nvDrop'), type = t && t.key !== 'cb' ? t.key : null;
    drop.hidden = !type;
    if (type && !drop.classList.contains('armed')) drop.textContent = TARGET_NAMES[type] + 'を打った';
    $('nvNext').disabled = calc.targets.length < 2;
    if (st.nav) {
      st.nav.setPlan({
        upTrue: calc.windTrue,
        marks: { m1: latlon(calc.m1), m4: latlon(calc.m4), fin: latlon(calc.fin) },
        targets: calc.targets.filter(function (x) { return !x.placed; }).map(function (x) { return { key: x.key, name: x.name + '（目標）', lat: x.lat, lon: x.lon }; }),
        selected: t ? { key: t.key, lat: t.lat, lon: t.lon } : null
      });
    }
  }
  function enterNav() {
    if (!planCalc() || !window.RT || !RT.livemap) return;
    leaveDark();
    leaveLive();
    soundContext();     // 到着の合図を鳴らせるよう、ボタンを押した操作の中で音の準備をしておく
    st.navArrived = null;
    $('navView').hidden = false;
    logEvent('nav-on');
    renderPlan();
    RT.livemap.loadLeaflet().then(function () {
      if ($('navView').hidden) return;
      if (!st.nav) st.nav = RT.livemap.create($('navMap'), { selfId: 'me', interactive: false, local: true });
      st.nav.setSelfHistory(st.fixes.slice(-600).map(function (f) { return [f[0], f[1], f[2]]; }));
      st.nav.start();
      renderPlan();
      st.nav.refit();
    }).catch(function () { /* 地図が出なくても、距離と方位の数字で案内できる */ });
  }
  function leaveNav() {
    if ($('navView').hidden) return;
    $('navView').hidden = true;
    if (st.nav) st.nav.stop();
    logEvent('nav-off');
  }
  function bindPlan() {
    [['plWind', 'wind'], ['plDist', 'dist'], ['plLine', 'line']].forEach(function (p) {
      $(p[0]).addEventListener('change', function () { setPlan(p[1], this.value); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-plan]'), function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-plan');
        setPlan(key, plan()[key] + parseInt(b.getAttribute('data-step'), 10));
      });
    });
    $('plCog').addEventListener('click', function () {
      // 直近5秒ほどの動きから進行方向を出す。5m以上動いていなければ、向きが定まらないので使わない
      var n = st.fixes.length, b = st.fixes[n - 1], a = null;
      for (var i = n - 2; i >= 0 && b[0] - st.fixes[i][0] <= 6000; i--) a = st.fixes[i];
      var s = $('vStatus');
      if (!GEO || !a || haversine(a[1], a[2], b[1], b[2]) < 5) {
        s.textContent = '進行方向が分かりません。風上に向かって走りながら押してください。';
        s.className = 'status bad';
        return;
      }
      var ang = axisAngle([0, '', a[1], a[2]], [0, '', b[1], b[2]]);   // 位置の並びを、マークの記録と同じ形にそろえて渡す
      setPlan('wind', ang);
      s.textContent = '風軸を ' + ang + '° にしました。';
      s.className = 'status good';
    });
    $('btnNav').addEventListener('click', enterNav);
    $('nvClose').addEventListener('click', leaveNav);
    $('nvNext').addEventListener('click', function () {
      var calc = planCalc();
      if (!calc) return;
      var open = calc.targets.filter(function (t) { return !t.placed; });
      var list = open.length ? open : calc.targets, cur = navTarget(calc), i = list.indexOf(cur);
      st.navSel = list[(i + 1) % list.length].key;
      st.navArrived = null;
      renderPlan();
    });
    // ナビ画面からマークを打つ。1回目で位置を覚え、2回目で確定する（ほかのボタンと同じ）
    var pending = null, timer = null, drop = $('nvDrop');
    function disarm() { clearTimeout(timer); drop.classList.remove('armed'); pending = null; }
    drop.addEventListener('click', function () {
      var calc = planCalc(), t = calc && navTarget(calc);
      if (!t || t.key === 'cb') return;
      if (drop.classList.contains('armed') && pending) {
        var ev = pending;
        disarm();
        addMark(ev);
        return;
      }
      pending = snapshot(t.key);
      if (!pending) return;
      drop.classList.add('armed');
      drop.textContent = 'もう一度押すと、この位置で確定します';
      timer = setTimeout(function () { disarm(); renderPlan(); }, 5000);
    });
    $('navView').addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  }
  /* 取り消されていないスタートの一覧 */
  function validStarts() {
    var out = [];
    st.meta.marks.forEach(function (m) {
      if (m[1] === 'start') out.push(m); else if (m[1] === 'start-cancel') out.pop();
    });
    return out;
  }
  function startSequence() {
    st.meta.seq = Date.now() + SEQ_MS;
    store.set(META, st.meta);
    logEvent('seq-start');
    armSound(true);
    renderOps();
  }
  function cancelSequence() {
    st.meta.seq = null;
    store.set(META, st.meta);
    logEvent('seq-cancel');
    clearSound();
    renderOps();
  }

  // ---------- スタート手順の音（4分前・1分前・スタート） ----------
  // 音は、鳴らす時刻をあらかじめ予約しておく。こうすると、画面の表示が一瞬止まっても時刻どおりに鳴る。
  // スマホのブラウザは、画面に触れた操作の中でしか音を出し始められないので、ボタンを押したときに予約する。
  var CUES = [[240, 0.7], [60, 1.2], [0, 1.8]];   // [スタートの何秒前か, 鳴らす長さ（秒）]
  var PRE_COUNT = 5;                              // それぞれの何秒前から、短い音で予告するか
  var snd = { ctx: null, nodes: [], armedFor: null };

  function soundContext() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!snd.ctx) snd.ctx = new AC();
      // iPhone は、消音スイッチが入っていると鳴らない。対応している機種では「再生」の扱いにして鳴るようにする
      if (navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (e) { /* 対応していなければそのまま */ } }
      if (snd.ctx.state === 'suspended') snd.ctx.resume();
      return snd.ctx;
    } catch (e) { return null; }
  }
  function beepAt(ctx, when, dur, freq) {
    var osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'square';            // 屋外でも聞き取りやすい、硬めの音
    osc.frequency.value = freq || 880;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(0.6, when + 0.01);
    gain.gain.setValueAtTime(0.6, when + dur - 0.05);
    gain.gain.linearRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(when); osc.stop(when + dur + 0.02);
    snd.nodes.push(osc);
  }
  function clearSound() {
    snd.nodes.forEach(function (o) { try { o.stop(); } catch (e) { /* 鳴り終わっていれば何もしない */ } });
    snd.nodes = [];
    snd.armedFor = null;
  }
  /* 進行中のスタート手順の音を予約する。confirm が真なら、音が出ることの確認に短い音を1回鳴らす。 */
  function armSound(confirm) {
    clearSound();
    if (!st.meta || !st.meta.seq) return;
    var ctx = soundContext();
    if (!ctx) { logEvent('sound-fail'); return; }
    var left = (st.meta.seq - Date.now()) / 1000;
    if (confirm) beepAt(ctx, ctx.currentTime + 0.02, 0.12);
    CUES.forEach(function (c) {
      var wait = left - c[0];
      if (wait > -0.3) beepAt(ctx, ctx.currentTime + Math.max(0.02, wait), c[1]);
      // 予告: 5・4・3・2・1秒前に、低めの短い音
      for (var s = PRE_COUNT; s >= 1; s--) {
        if (wait - s > 0.05) beepAt(ctx, ctx.currentTime + wait - s, 0.12, 660);
      }
    });
    snd.armedFor = st.meta.seq;
  }
  /* カウントダウンが0になったら、スタートを自動で記録する。画面が止まっていて遅れても、予定の時刻で記録する。 */
  function tickOps() {
    if (!st.meta || !st.meta.ops || !st.meta.seq || Date.now() < st.meta.seq) return;
    var at = st.meta.seq;
    st.meta.seq = null;
    addMark(startMark(at));
  }
  function seqLabel(leftMs) {
    if (leftMs > 240000) return '予告信号（クラス旗 掲揚）';
    if (leftMs > 60000) return '準備信号（P旗 掲揚）';
    return '1分前（P旗 降下）';
  }
  function renderOps() {
    if (!st.meta || !(st.meta.ops || st.meta.practice)) return;
    var marks = $('opsMarks');
    marks.textContent = '';
    Object.keys(MARK_NAMES).forEach(function (type) {
      if (type === 'fin' && !st.meta.ops) return;
      var last = null;
      st.meta.marks.forEach(function (m) { if (m[1] === type) last = m; });
      var li = document.createElement('li');
      if (last) li.textContent = MARK_NAMES[type] + '　' + clock(last[0]) + ' に記録（精度 ±' + Math.round(last[4]) + 'm）';
      else { li.textContent = MARK_NAMES[type] + '　未記録'; li.className = 'none'; }
      marks.appendChild(li);
    });
    var starts = validStarts(), list = $('opsStarts');
    list.textContent = '';
    starts.forEach(function (m, i) {
      var li = document.createElement('li');
      // そのスタートのときのライン長（スタートを記録した位置から、その時点の下マークまで）
      var pin = m[2] !== null ? markAt('m4', m[0]) : null, extra = [];
      if (m[6]) extra.push(m[6] + '周');
      if (pin) extra.push('ライン ' + Math.round(haversine(m[2], m[3], pin[2], pin[3])) + 'm');
      li.textContent = '第' + (i + 1) + 'レース　' + clock(m[0]) + ' スタート' + (extra.length ? '（' + extra.join('・') + '）' : '');
      list.appendChild(li);
    });
    renderDist();
    $('btnStartCancel').hidden = starts.length === 0;
    $('opsLaps').value = String(st.meta.laps || 2);
    var cd = $('opsCountdown'), seq = st.meta.seq;
    cd.hidden = !seq;
    $('btnSeq').textContent = seq ? 'スタート手順を取り消す（延期）' : 'スタート手順を開始（5分前）';
    $('btnSeq').classList.toggle('primary', !seq);
    if (seq) {
      var left = Math.max(0, seq - Date.now()), s = Math.ceil(left / 1000);
      cd.textContent = '';
      var b = document.createElement('b');
      b.textContent = Math.floor(s / 60) + ':' + pad(s % 60);
      var sp = document.createElement('span');
      sp.textContent = seqLabel(left);
      var sp2 = document.createElement('span');
      sp2.textContent = clock(seq) + ' スタート';
      cd.appendChild(b); cd.appendChild(sp); cd.appendChild(sp2);
    }
  }

  function currentMode() {
    var r = document.querySelector('input[name="mode"]:checked');
    return r ? r.value : 'racer';
  }

  function start() {
    var sail = $('sail').value.trim(), name = $('name').value.trim();
    var err = $('setupErr');
    function fail(msg) { err.textContent = msg; err.hidden = false; }
    if (!sail || !name) { fail('セール番号とニックネームを入力してください。'); return; }
    var mode = currentMode();
    var ops = mode === 'ops', practice = mode === 'practice';
    var pub = cloudOn && $('pubMode').checked;
    var pass = $('pass').value.trim();
    var needJoin = pub && !cloud.joined();
    if (needJoin && !pass) { fail('合言葉を入力してください。公開しないときは、チェックを外してください。'); return; }
    err.hidden = true;
    // 周回数とコース設定ナビの値は、前回のものを引き継ぐ
    var keep = store.get(PROFILE) || {};
    store.set(PROFILE, { sail: sail, name: name, mode: mode, pub: pub, laps: keep.laps || 2, plan: keep.plan });

    function go() {
      st.meta = {
        sail: sail, name: name, started: Date.now(), chunks: 0, stopped: false, log: [],
        ops: ops,      // 運営艇として記録しているか
        practice: practice,   // マーク練習（選手が自分でマークを打つ）として記録しているか
        land: LAND_TEST,      // 陸上テスト用の入口から始めた記録か（海の上でなくても送る）
        marks: [],     // 運営艇の記録: [時刻ms, 種類, 緯度, 経度, 精度m, 位置の古さms]
        seq: null,     // スタート手順の進行中なら、予定しているスタート時刻
        laps: (store.get(PROFILE) || {}).laps || 2,   // 次のスタートの周回数（前回の値を引き継ぐ）
        pub: pub,      // 記録を終えたら観戦ページに送るか
        cid: pub ? cloud.newId() : null,   // 送るときの記録ID
        sent: null     // 送り終えたら { day, n, outside, at }
      };
      // 合言葉をまだ確かめられていなければ、送るときに使えるように覚えておく
      if (pub && !cloud.joined()) st.meta.pass = pass;
      st.fixes = []; st.saved = 0; st.dist = 0; st.storageFull = false;
      beginRecording(false);
    }
    if (!needJoin) { go(); return; }

    // 合言葉は、電波のあるうちに確かめておく。違っていたら始めない。つながらなければ、記録を先に始める。
    var btn = $('btnStart'), settled = false;
    btn.disabled = true;
    btn.textContent = '合言葉を確認しています…';
    function settle(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      btn.disabled = false;
      btn.textContent = '記録を開始';
      fn();
    }
    var timer = setTimeout(function () { settle(go); }, JOIN_WAIT_MS);
    cloud.join(pass).then(function () { settle(go); }, function (e) {
      settle(function () {
        if (e && e.code === 'passcode') fail('合言葉が違います。もう一度確かめてください。');
        else go();
      });
    });
  }

  function stop() {
    if (st.watchId !== null) { navigator.geolocation.clearWatch(st.watchId); st.watchId = null; }
    releaseWake();
    clearInterval(st.timer);
    st.recording = false;
    flush(true);
    st.meta.stopped = true;
    st.meta.seq = null;   // 進行中のスタート手順は、記録を終えたら無効にする
    clearSound();
    logEvent('stop');
    store.set(META, st.meta);
    leaveDark();
    leaveLive();
    leaveNav();
    showDone();
    sendNow();
  }

  // ---------- リアルタイムの送信（記録中、5秒ごとにいまの位置を送る） ----------
  // 失敗しても記録には影響させない。記録の全体は、終了時にあらためて送る。
  function liveTick() {
    if (!cloudOn || !st.recording || !st.meta || !st.meta.pub || !st.fixes.length) return;
    var now = Date.now(), lv = st.live;
    if (lv.busy || now - lv.nowAt < LIVE_EVERY_MS) return;
    lv.nowAt = now;
    function done() { lv.busy = false; }
    if (!cloud.joined()) {
      // 開始時に合言葉を確かめられなかったときは、1分おきに確かめ直す
      if (!st.meta.pass || now - lv.joinAt < 60000) return;
      lv.joinAt = now;
      lv.busy = true;
      cloud.join(st.meta.pass).then(done, done);
      return;
    }
    var anywhere = !!st.meta.land, meta = st.meta;
    var lastT = st.fixes[st.fixes.length - 1][0];
    var recent = cloud.livePick(st.fixes, lastT - cloud.LIVE_TAIL_MS, Infinity, 0, anywhere);
    if (!recent.length) return;   // 公開してよい範囲の外にいる
    lv.busy = true;
    var info = { sail: meta.sail, nick: meta.name, ops: meta.ops, marks: meta.marks };
    cloud.liveNow(meta.cid, info, recent, anywhere).then(function (r) {
      lv.sent++;
      if (lv.sent === 1 && r) {
        // 前回の記録のリアルタイム分が送り先に残っていれば消し、今回の分を覚えておく
        var prev = store.get(LIVE_PREV);
        if (prev && prev.cid && prev.cid !== meta.cid) cloud.liveEnd(prev.cid, prev.day).catch(function () {});
        store.set(LIVE_PREV, { cid: meta.cid, day: r.day });
      }
      // 1分ぶんたまったら、航跡のかたまりも送る（途中から見始めた人が、少し前からの航跡を見られるように）
      if (!lv.chunkFrom) lv.chunkFrom = Math.max(st.fixes[0][0] - 1, lastT - 15 * 60000);
      if (lastT - lv.chunkFrom < LIVE_CHUNK_MS) return null;
      var part = cloud.livePick(st.fixes, lv.chunkFrom, lastT, LIVE_STEP_MS, anywhere).slice(-450);
      if (!part.length) { lv.chunkFrom = lastT; return null; }
      return cloud.liveChunk(meta.cid, part).then(function () { lv.chunkFrom = lastT; });
    }).then(function () { lv.ok = true; lv.err = ''; }, function (e) { lv.ok = false; lv.err = (e && e.code) || 'error'; }).then(done);
  }

  // ---------- リアルタイムモード（地図を表示・タッチ無効） ----------
  function enterLive() {
    if (!cloudOn || !window.RT || !RT.livemap) return;
    leaveDark();
    leaveNav();
    $('liveView').hidden = false;
    logEvent('live-on');
    $('lCount').textContent = '地図を読み込んでいます…';
    RT.livemap.loadLeaflet().then(function () {
      if ($('liveView').hidden) return;   // 読み込んでいる間に解除された
      if (!st.map) {
        st.map = RT.livemap.create($('liveMap'), {
          selfId: (st.meta && st.meta.cid) || 'me',
          interactive: false,
          onStatus: function (s) {
            $('lCount').textContent = s.error ? s.error : 'ほか ' + Math.max(0, s.moving - (st.meta && st.meta.pub ? 1 : 0)) + '艇';
            $('lCount').className = s.error ? 'bad' : '';
          }
        });
      }
      // それまでの自分の航跡を渡してから、ほかの艇の読み込みを始める
      st.map.setSelfHistory(st.fixes.slice(-900).map(function (f) { return [f[0], f[1], f[2]]; }));
      st.map.start();
      st.map.refit();
    }).catch(function () {
      $('lCount').textContent = '地図を読み込めませんでした';
      $('lCount').className = 'bad';
    });
  }
  function leaveLive() {
    if ($('liveView').hidden) return;
    $('liveView').hidden = true;
    if (st.map) st.map.stop();
    logEvent('live-off');
  }

  // ---------- 観戦ページへの送信 ----------
  function sendNow() {
    if (!cloudOn || !st.meta || !st.meta.pub || st.send === 'sending') return;
    var packed = cloud.pack(buildFile(), { anywhere: !!st.meta.land });
    if (!packed) { st.send = 'none'; renderSend(); return; }
    if (!st.meta.cid) { st.meta.cid = cloud.newId(); store.set(META, st.meta); }
    st.send = 'sending';
    renderSend();
    var meta = st.meta;
    var pass = $('sendPass').value.trim() || meta.pass || '';
    var ready = cloud.joined() ? Promise.resolve() : cloud.join(pass);
    ready.then(function () { return cloud.upload(meta.cid, packed); }).then(function (r) {
      if (st.meta !== meta) return;   // 送っている間に、記録が消された
      meta.sent = { day: r.day, n: r.n, outside: packed.outside, at: Date.now() };
      delete meta.pass;
      store.set(META, meta);
      st.send = '';
      renderSend();
    }).catch(function (e) {
      if (st.meta !== meta) return;
      st.send = e && e.code === 'passcode' ? 'passcode' : e && e.code === 'net' ? 'net' : 'server';
      renderSend();
    });
  }

  function renderSend() {
    var on = cloudOn && !!st.meta && !!st.meta.pub;
    $('sendBox').hidden = !on;
    if (!on) return;
    var sent = st.meta.sent, text, cls = '', retry = false, askPass = false;
    if (st.send === 'sending') text = '観戦ページに送っています…';
    else if (st.send === 'none') text = '公開する範囲（海の上）での記録が無かったので、送っていません。';
    else if (st.send === 'net') {
      text = '電波が届かず、送れませんでした。つながる場所で、下のボタンを押してください。';
      cls = 'bad'; retry = true;
    } else if (st.send === 'passcode') {
      text = '合言葉が違うか、まだ登録されていません。合言葉を入れて、下のボタンを押してください。';
      cls = 'bad'; retry = true; askPass = true;
    } else if (st.send === 'server') {
      text = '送り先でエラーが起きました。少し待ってから、下のボタンを押してください。';
      cls = 'bad'; retry = true;
    } else if (sent) {
      text = '観戦ページに送りました（' + sent.n + '点）。' +
        (sent.outside ? '範囲の外だった' + sent.outside + '点は送っていません。' : '');
      cls = 'good';
    } else {
      text = 'まだ観戦ページに送っていません。';
      retry = true;
    }
    var msg = $('sendMsg');
    msg.textContent = text;
    msg.className = 'status' + (cls ? ' ' + cls : '');
    $('btnSend').hidden = !retry;
    $('sendPassField').hidden = !askPass;
    var ok = !!sent && st.send === '';
    $('lnkView').hidden = !ok;
    if (ok) $('lnkView').href = 'index.html?day=' + encodeURIComponent(sent.day);
  }

  /* 最初の画面の、公開まわりの表示をいまの状態に合わせる */
  function renderSetup() {
    $('pubBox').hidden = !cloudOn;
    if (!cloudOn) return;
    var pub = $('pubMode').checked;
    $('passField').hidden = !pub || cloud.joined();
    $('landNote').hidden = !(LAND_TEST && pub);
    $('setupNote').textContent = pub ?
      '記録はまずこのスマホの中に保存されます。記録中は5秒ごとにいまの位置を、記録を終了したときに全体を、観戦ページへ送ります。' :
      '記録はこのスマホの中にだけ保存されます。どこにも送信されません。';
  }

  function showDone() {
    var n = st.fixes.length;
    var dur = n > 1 ? (st.fixes[n - 1][0] - st.fixes[0][0]) / 1000 : 0;
    $('summary').textContent = st.meta.sail + '　' + st.meta.name + ' ／ ' + n + '点 ／ ' +
      fmtDuration(dur) + ' ／ 約' + (st.dist / 1000).toFixed(2) + ' km';
    $('btnShare').hidden = !shareFile();
    $('btnShare').disabled = n === 0;
    $('btnSave').disabled = n === 0;
    renderSend();
    showScreen('done');
  }

  function reset() {
    if (st.meta) for (var i = 0; i < st.meta.chunks; i++) store.del(CHUNK + i);
    store.del(META);
    st.meta = null; st.fixes = []; st.saved = 0; st.dist = 0; st.storageFull = false;
    st.send = '';
    $('sendPass').value = '';
    renderSetup();
    showScreen('setup');
  }

  // ---------- 表示 ----------
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 3600) + ':' + pad(Math.floor(sec / 60) % 60) + ':' + pad(sec % 60);
  }

  function statusNow() {
    var now = Date.now();
    if (st.storageFull) return ['保存できる量を超えました。記録を終了して書き出してください。', 'bad'];
    if (st.gpsError === 1) return ['位置情報が許可されていません。ブラウザの設定で許可してください。', 'bad'];
    if (!st.fixes.length || !st.lastFixAt) return ['GPS の電波を探しています…', ''];
    if (now - st.lastFixAt > STALE_MS) {
      return ['GPS が途切れています（最後の受信から' + Math.round((now - st.lastFixAt) / 1000) + '秒）', 'bad'];
    }
    if (!st.wakeSupported) return ['記録中。この端末は画面を点けたままにできないので、自動ロックを「なし」にしてください。', 'bad'];
    return ['記録中です', 'good'];
  }

  function render() {
    if (!st.meta) return;
    if (st.meta.ops && st.recording) { tickOps(); if (st.meta.seq) renderOps(); }
    liveTick();
    if (st.recording && (st.meta.ops || st.meta.practice)) { renderDist(); renderPlan(); }   // 動くと、マークや目標までの距離が変わる
    var elapsed = fmtDuration((Date.now() - st.meta.started) / 1000);
    $('vElapsed').textContent = elapsed;
    $('vCount').textContent = st.fixes.length;
    $('vAcc').textContent = st.lastAcc === null ? '–' : '±' + Math.round(st.lastAcc) + 'm';
    $('vSpd').textContent = st.lastSpeed === null ? '–' : (st.lastSpeed / KN).toFixed(1) + 'kt';
    var s = statusNow();
    var el = $('vStatus');
    el.textContent = s[0];
    el.className = 'status' + (s[1] ? ' ' + s[1] : '');
    $('dElapsed').textContent = elapsed;
    $('dState').textContent = s[1] === 'bad' ? '確認が必要です' : '記録中';
    $('dState').className = s[1] === 'bad' ? 'bad' : '';
    $('lElapsed').textContent = elapsed;
    $('lSpd').textContent = st.lastSpeed === null ? '' : (st.lastSpeed / KN).toFixed(1) + 'kt';
    $('lState').textContent = s[1] === 'bad' ? '確認が必要です' : '記録中';
    $('lState').className = s[1] === 'bad' ? 'bad' : '';
  }

  // ---------- 航海モード（黒い画面・タッチ無効） ----------
  function enterDark() { leaveLive(); leaveNav(); $('dark').hidden = false; logEvent('dark-on'); }
  function leaveDark() {
    if ($('dark').hidden) return;
    $('dark').hidden = true;
    logEvent('dark-off');
  }
  /* 画面全体を覆うモード（航海モード・リアルタイムモード）の、長押しでの解除 */
  function bindHold(btn, cover, leave) {
    var timer = null;
    function cancel() { clearTimeout(timer); timer = null; btn.classList.remove('holding'); }
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      btn.classList.add('holding');
      timer = setTimeout(function () { cancel(); leave(); }, HOLD_MS);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { btn.addEventListener(ev, cancel); });
    cover.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    cover.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  function bindDark() {
    bindHold($('btnUnlock'), $('dark'), leaveDark);
    bindHold($('btnLiveUnlock'), $('liveView'), leaveLive);
  }

  // ---------- 書き出し ----------
  function buildFile() {
    return {
      format: 'yacht-track',
      version: 1,
      sail: st.meta.sail,
      name: st.meta.name,
      started: new Date(st.meta.started).toISOString(),
      exported: new Date().toISOString(),
      device: navigator.userAgent,
      columns: ['time_ms', 'lat', 'lon', 'accuracy_m', 'speed_mps', 'heading_deg'],
      fixes: st.fixes,
      // 運営艇の記録。種類は m1=上マーク, m4=下マーク, fin=フィニッシュマーク, start=スタート信号, start-cancel=直前のスタートの取り消し
      ops: !!st.meta.ops,
      practice: !!st.meta.practice,
      // laps はスタートの記録にだけ入る（そのレースの周回数）
      mark_columns: ['time_ms', 'type', 'lat', 'lon', 'accuracy_m', 'fix_age_ms', 'laps'],
      marks: st.meta.marks || [],
      log: st.meta.log
    };
  }
  function fileBase() {
    var d = new Date(st.meta.started);
    var sail = String(st.meta.sail).replace(/[^0-9A-Za-z_-]/g, '') || 'boat';
    return 'track_' + sail + '_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes());
  }
  /* 共有に使えるファイル。端末によって扱える種類が違うので、JSON が駄目ならテキストとして渡す。 */
  function shareFile() {
    if (!st.meta || !navigator.canShare || typeof File !== 'function') return null;
    var text = JSON.stringify(buildFile());
    var tries = [[fileBase() + '.json', 'application/json'], [fileBase() + '.txt', 'text/plain']];
    for (var i = 0; i < tries.length; i++) {
      try {
        var f = new File([text], tries[i][0], { type: tries[i][1] });
        if (navigator.canShare({ files: [f] })) return f;
      } catch (e) { /* 次の形式を試す */ }
    }
    return null;
  }
  function share() {
    var f = shareFile();
    // 題名を付けると、保存先によっては題名だけの余分なファイルができるので、ファイルだけを渡す
    if (f) navigator.share({ files: [f] }).catch(function () {});
  }
  function download() {
    var blob = new Blob([JSON.stringify(buildFile())], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileBase() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }

  /* 押し間違いを防ぐ: 1回目で確認の文言に変わり、数秒以内の2回目で実行する。
   * onArm を渡すと1回目に呼ぶ（false を返したら何もしない）。位置や時刻を1回目の瞬間に覚えるのに使う。 */
  function twoStep(btn, armedText, action, onArm) {
    var normal = btn.textContent, timer = null;
    btn.addEventListener('click', function () {
      if (btn.classList.contains('armed')) {
        clearTimeout(timer);
        btn.classList.remove('armed');
        btn.textContent = normal;
        action();
        return;
      }
      if (onArm && onArm() === false) return;
      btn.classList.add('armed');
      btn.textContent = armedText;
      timer = setTimeout(function () { btn.classList.remove('armed'); btn.textContent = normal; }, 5000);
    });
  }

  /* 運営艇のボタン。1回目に押した瞬間の位置と時刻を覚え、2回目で確定する。 */
  function bindOps() {
    function needFix() {
      var s = $('vStatus');
      s.textContent = 'まだ位置が取れていません。GPS を受信してから押してください。';
      s.className = 'status bad';
    }
    [['btnM1', 'm1'], ['btnM4', 'm4'], ['btnFin', 'fin']].forEach(function (p) {
      var pending = null;
      twoStep($(p[0]), 'もう一度押すと、この位置で確定します', function () {
        if (pending) addMark(pending);
        pending = null;
      }, function () {
        pending = snapshot(p[1]);
        if (!pending) { needFix(); return false; }
      });
    });
    var pendingStart = null;
    twoStep($('btnStartNow'), 'もう一度押すと、スタートを記録します', function () {
      if (pendingStart) { st.meta.seq = null; clearSound(); addMark(pendingStart); }
      pendingStart = null;
    }, function () {
      pendingStart = startMark(Date.now());
    });
    twoStep($('btnStartCancel'), 'もう一度押すと、直前のスタートを取り消します', function () {
      addMark([Date.now(), 'start-cancel', null, null, null, null]);
    });
    $('btnSeq').addEventListener('click', function () {
      if (st.meta.seq) cancelSequence(); else startSequence();
    });
    $('opsLaps').addEventListener('change', function () {
      var v = parseInt(this.value, 10);
      if (!st.meta || !(v >= 1 && v <= 4)) return;
      st.meta.laps = v;
      store.set(META, st.meta);
      var prof = store.get(PROFILE) || {};
      prof.laps = v;
      store.set(PROFILE, prof);
    });
  }

  // ---------- 起動 ----------
  function loadSaved() {
    var meta = store.get(META);
    if (!meta) return false;
    if (!Array.isArray(meta.marks)) meta.marks = [];   // 運営艇モードができる前の記録
    if (!meta.laps) meta.laps = 2;
    st.meta = meta;
    st.fixes = [];
    for (var i = 0; i < meta.chunks; i++) {
      var part = store.get(CHUNK + i);
      if (part) st.fixes = st.fixes.concat(part);
    }
    st.saved = st.fixes.length;
    st.dist = 0;
    for (var k = 1; k < st.fixes.length; k++) {
      if (st.fixes[k][3] <= 30) st.dist += haversine(st.fixes[k - 1][1], st.fixes[k - 1][2], st.fixes[k][1], st.fixes[k][2]);
    }
    return true;
  }

  function init() {
    var prof = store.get(PROFILE);
    if (prof) {
      $('sail').value = prof.sail || ''; $('name').value = prof.name || '';
      var radio = document.querySelector('input[name="mode"][value="' + (prof.mode || (prof.ops ? 'ops' : 'racer')) + '"]');
      if (radio) radio.checked = true;
      if (prof.pub === false) $('pubMode').checked = false;
    }
    $('pubMode').addEventListener('change', renderSetup);
    renderSetup();

    var problem = '';
    if (!window.isSecureContext) problem = 'このページは https:// で始まるアドレスで開く必要があります。';
    else if (!navigator.geolocation) problem = 'このブラウザは位置情報に対応していません。';
    if (problem) {
      $('blockedMsg').textContent = problem;
      $('blocked').hidden = false;
      $('btnStart').disabled = true;
      $('btnResume').disabled = true;
      $('btnResume2').disabled = true;
    }

    $('btnStart').addEventListener('click', start);
    $('btnResume').addEventListener('click', function () { beginRecording(true); });
    $('btnResume2').addEventListener('click', function () { beginRecording(true); });
    $('btnFinish').addEventListener('click', function () {
      st.meta.stopped = true;
      store.set(META, st.meta);
      showDone();
      sendNow();
    });
    $('btnSend').addEventListener('click', sendNow);
    // 電波が戻ったら、送れなかった記録を送り直す
    window.addEventListener('online', function () {
      if (st.meta && st.meta.stopped && !st.meta.sent && st.send === 'net') sendNow();
    });
    // 画面を点けたままにする機能が働いていなければ、次に画面に触れたときにもう一度頼む
    document.addEventListener('pointerdown', function () {
      if (st.recording && !st.wake) acquireWake();
      // スタート手順の途中でページを開き直したときは、次に画面に触れたときに音を予約し直す
      if (st.recording && st.meta && st.meta.seq && snd.armedFor !== st.meta.seq) armSound(false);
    });
    $('btnDark').addEventListener('click', enterDark);
    $('btnLive').addEventListener('click', enterLive);
    $('btnShare').addEventListener('click', share);
    $('btnSave').addEventListener('click', download);
    twoStep($('btnStop'), 'もう一度押すと終了します', stop);
    twoStep($('btnNew'), 'もう一度押すと記録を消します', reset);
    bindDark();
    bindOps();
    bindPlan();

    document.addEventListener('visibilitychange', function () {
      if (!st.recording) return;
      logEvent(document.visibilityState);
      if (document.visibilityState === 'visible') {
        acquireWake();
        // 画面が隠れている間は音の時計が止まるので、戻ってきたら残り時間で予約し直す
        if (st.meta && st.meta.seq && snd.ctx) armSound(false);
      } else {
        flush(true);
      }
    });
    window.addEventListener('pagehide', function () { if (st.recording) flush(true); });

    if (loadSaved()) {
      if (st.meta.stopped) {
        showDone();
        if (!st.meta.sent) sendNow();   // 前回送れなかった記録を送る
      } else {
        $('resumeMsg').textContent = st.meta.sail + '　' + st.meta.name + ' の記録が ' + st.fixes.length +
          '点あります。記録中にページが閉じられたようです。';
        showScreen('resume');
      }
    } else {
      showScreen('setup');
    }
  }

  init();

  // 動作確認用
  window.YTTracker = { st: st, buildFile: buildFile, fileBase: fileBase, sendNow: sendNow, snd: snd, liveTick: liveTick };
})();
