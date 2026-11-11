/* スマホで航跡を記録する画面。
 *
 * 記録は端末の中（ブラウザの保存領域）にだけ置き、外部へは一切送信しない。
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
    timer: null
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
    if (!st.wakeSupported || st.wake) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      st.wake = lock;
      logEvent('wake-on');
      lock.addEventListener('release', function () {
        st.wake = null;
        logEvent('wake-off');
        render();
      });
      render();
    }).catch(function (e) { logEvent('wake-fail', e && e.name); });
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
    $('who').textContent = st.meta.sail + '　' + st.meta.name + (st.meta.ops ? '（運営艇）' : '');
    $('opsPanel').hidden = !st.meta.ops;
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
  function addMark(ev) {
    st.meta.marks.push(ev);
    store.set(META, st.meta);
    renderOps();
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
    renderOps();
  }
  function cancelSequence() {
    st.meta.seq = null;
    store.set(META, st.meta);
    logEvent('seq-cancel');
    renderOps();
  }
  /* カウントダウンが0になったら、スタートを自動で記録する。画面が止まっていて遅れても、予定の時刻で記録する。 */
  function tickOps() {
    if (!st.meta || !st.meta.ops || !st.meta.seq || Date.now() < st.meta.seq) return;
    var at = st.meta.seq;
    st.meta.seq = null;
    addMark(snapshot('start', at) || [at, 'start', null, null, null, null]);
  }
  function seqLabel(leftMs) {
    if (leftMs > 240000) return '予告信号（クラス旗 掲揚）';
    if (leftMs > 60000) return '準備信号（P旗 掲揚）';
    return '1分前（P旗 降下）';
  }
  function renderOps() {
    if (!st.meta || !st.meta.ops) return;
    var marks = $('opsMarks');
    marks.textContent = '';
    Object.keys(MARK_NAMES).forEach(function (type) {
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
      li.textContent = '第' + (i + 1) + 'レース　' + clock(m[0]) + ' スタート';
      list.appendChild(li);
    });
    $('btnStartCancel').hidden = starts.length === 0;
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

  function start() {
    var sail = $('sail').value.trim(), name = $('name').value.trim();
    var err = $('setupErr');
    if (!sail || !name) {
      err.textContent = 'セール番号と名前を入力してください。';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    var ops = $('opsMode').checked;
    store.set(PROFILE, { sail: sail, name: name, ops: ops });
    st.meta = {
      sail: sail, name: name, started: Date.now(), chunks: 0, stopped: false, log: [],
      ops: ops,      // 運営艇として記録しているか
      marks: [],     // 運営艇の記録: [時刻ms, 種類, 緯度, 経度, 精度m, 位置の古さms]
      seq: null      // スタート手順の進行中なら、予定しているスタート時刻
    };
    st.fixes = []; st.saved = 0; st.dist = 0; st.storageFull = false;
    beginRecording(false);
  }

  function stop() {
    if (st.watchId !== null) { navigator.geolocation.clearWatch(st.watchId); st.watchId = null; }
    releaseWake();
    clearInterval(st.timer);
    st.recording = false;
    flush(true);
    st.meta.stopped = true;
    st.meta.seq = null;   // 進行中のスタート手順は、記録を終えたら無効にする
    logEvent('stop');
    store.set(META, st.meta);
    leaveDark();
    showDone();
  }

  function showDone() {
    var n = st.fixes.length;
    var dur = n > 1 ? (st.fixes[n - 1][0] - st.fixes[0][0]) / 1000 : 0;
    $('summary').textContent = st.meta.sail + '　' + st.meta.name + ' ／ ' + n + '点 ／ ' +
      fmtDuration(dur) + ' ／ 約' + (st.dist / 1000).toFixed(2) + ' km';
    $('btnShare').hidden = !shareFile();
    $('btnShare').disabled = n === 0;
    $('btnSave').disabled = n === 0;
    showScreen('done');
  }

  function reset() {
    if (st.meta) for (var i = 0; i < st.meta.chunks; i++) store.del(CHUNK + i);
    store.del(META);
    st.meta = null; st.fixes = []; st.saved = 0; st.dist = 0; st.storageFull = false;
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
  }

  // ---------- 航海モード（黒い画面・タッチ無効） ----------
  function enterDark() { $('dark').hidden = false; logEvent('dark-on'); }
  function leaveDark() {
    if ($('dark').hidden) return;
    $('dark').hidden = true;
    logEvent('dark-off');
  }
  function bindDark() {
    var btn = $('btnUnlock'), timer = null;
    function cancel() { clearTimeout(timer); timer = null; btn.classList.remove('holding'); }
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      btn.classList.add('holding');
      timer = setTimeout(function () { cancel(); leaveDark(); }, HOLD_MS);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { btn.addEventListener(ev, cancel); });
    $('dark').addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    $('dark').addEventListener('contextmenu', function (e) { e.preventDefault(); });
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
      mark_columns: ['time_ms', 'type', 'lat', 'lon', 'accuracy_m', 'fix_age_ms'],
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
      if (pendingStart) { st.meta.seq = null; addMark(pendingStart); }
      pendingStart = null;
    }, function () {
      var now = Date.now();
      pendingStart = snapshot('start', now) || [now, 'start', null, null, null, null];
    });
    twoStep($('btnStartCancel'), 'もう一度押すと、直前のスタートを取り消します', function () {
      addMark([Date.now(), 'start-cancel', null, null, null, null]);
    });
    $('btnSeq').addEventListener('click', function () {
      if (st.meta.seq) cancelSequence(); else startSequence();
    });
  }

  // ---------- 起動 ----------
  function loadSaved() {
    var meta = store.get(META);
    if (!meta) return false;
    if (!Array.isArray(meta.marks)) meta.marks = [];   // 運営艇モードができる前の記録
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
    if (prof) { $('sail').value = prof.sail || ''; $('name').value = prof.name || ''; $('opsMode').checked = !!prof.ops; }

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
    });
    $('btnDark').addEventListener('click', enterDark);
    $('btnShare').addEventListener('click', share);
    $('btnSave').addEventListener('click', download);
    twoStep($('btnStop'), 'もう一度押すと終了します', stop);
    twoStep($('btnNew'), 'もう一度押すと記録を消します', reset);
    bindDark();
    bindOps();

    document.addEventListener('visibilitychange', function () {
      if (!st.recording) return;
      logEvent(document.visibilityState);
      if (document.visibilityState === 'visible') acquireWake(); else flush(true);
    });
    window.addEventListener('pagehide', function () { if (st.recording) flush(true); });

    if (loadSaved()) {
      if (st.meta.stopped) {
        showDone();
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
  window.YTTracker = { st: st, buildFile: buildFile, fileBase: fileBase };
})();
