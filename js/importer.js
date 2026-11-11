/* 記録した航跡ファイルを読み込み、観戦画面が扱える形に直す。
 *
 * スマホの記録は間隔がばらばら（動いていれば1秒ごと、止まっていれば10秒ごとなど）なので、
 * 「スタート時刻を0とした、1秒ごとの位置の列」に並べ直す。
 * 出来上がる形はシミュレーションの出力と同じなので、回航判定や分析はそのまま使える。 */
(function (root) {
  'use strict';
  var RT = root.RT = root.RT || {};
  var G = RT.geo;

  var MAX_ACC = 40;          // 精度（端末の自己申告）がこれより悪い点は使わない m
  var MIN_MOVE = 0.4;        // これより遅いときは針路を更新しない m/s
  var MAX_HOURS = 12;
  var MARK_TYPES = { m1: 1, m4: 1, fin: 1, start: 1, 'start-cancel': 1 };
  var PRE_MS = 6 * 60 * 1000;   // レースの表示は、スタートの6分前から（5分前の予告信号が入るように）

  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.floor(s.length / 2)];
  }

  /* ファイルの中身（文字列）を読み取る。形式が違えば、理由を書いたエラーを投げる。 */
  function parse(text, fileName) {
    var d;
    try { d = JSON.parse(text); } catch (e) { throw new Error('ファイルを読み取れません'); }
    if (!d || d.format !== 'yacht-track' || !Array.isArray(d.fixes)) {
      throw new Error('このアプリで記録した航跡ファイルではありません');
    }
    var all = [];
    d.fixes.forEach(function (f) {
      if (!Array.isArray(f) || f.length < 3) return;
      var t = Number(f[0]), lat = Number(f[1]), lon = Number(f[2]);
      var acc = f[3] === null || f[3] === undefined ? null : Number(f[3]);
      if (!isFinite(t) || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      all.push({ t: t, lat: lat, lon: lon, acc: acc });
    });
    all.sort(function (a, b) { return a.t - b.t; });
    var uniq = [];
    all.forEach(function (p) { if (!uniq.length || p.t > uniq[uniq.length - 1].t) uniq.push(p); });
    var good = uniq.filter(function (p) { return p.acc === null || !isFinite(p.acc) || p.acc <= MAX_ACC; });
    var use = good.length >= 2 ? good : uniq;
    if (use.length < 2) throw new Error('位置の記録が足りません');

    // 運営艇の記録（マークを打った位置、スタート信号）
    var marks = [];
    (Array.isArray(d.marks) ? d.marks : []).forEach(function (m) {
      if (!Array.isArray(m) || !MARK_TYPES[m[1]]) return;
      var mt = Number(m[0]);
      if (!isFinite(mt)) return;
      var mlat = m[2] === null || m[2] === undefined ? null : Number(m[2]);
      var mlon = m[3] === null || m[3] === undefined ? null : Number(m[3]);
      if (mlat === null || mlon === null || !isFinite(mlat) || !isFinite(mlon)) { mlat = null; mlon = null; }
      var laps = Number(m[6]);
      if (!(laps >= 1 && laps <= 9 && Math.floor(laps) === laps)) laps = null;
      marks.push({ t: mt, type: m[1], lat: mlat, lon: mlon, laps: m[1] === 'start' ? laps : null });
    });
    marks.sort(function (a, b) { return a.t - b.t; });

    return {
      file: fileName || '',
      sail: String(d.sail === undefined ? '' : d.sail).slice(0, 12),
      name: String(d.name === undefined ? '' : d.name).slice(0, 20),
      ops: !!d.ops || marks.length > 0,   // 運営艇の記録かどうか
      marks: marks,
      fixes: use,
      total: uniq.length,
      dropped: uniq.length - use.length,     // 精度が悪くて捨てた点の数
      first: use[0].t,
      last: use[use.length - 1].t,
      medAcc: median(use.filter(function (p) { return p.acc !== null && isFinite(p.acc); }).map(function (p) { return p.acc; }))
    };
  }

  /* 1艇分を、1秒ごとの位置・針路・艇速に並べ直す。記録の前後は端の位置で止めておく。 */
  function resample(tr, course, startMs, t0, n) {
    var fx = tr.fixes, last = fx.length - 1, j = 0;
    var x = new Array(n), y = new Array(n), hdg = new Array(n), spd = new Array(n);
    for (var k = 0; k < n; k++) {
      var tms = startMs + (t0 + k) * 1000, lat, lon;
      if (tms <= fx[0].t) { lat = fx[0].lat; lon = fx[0].lon; }
      else if (tms >= fx[last].t) { lat = fx[last].lat; lon = fx[last].lon; }
      else {
        while (fx[j + 1].t < tms) j++;
        var a = fx[j], b = fx[j + 1], f = (tms - a.t) / (b.t - a.t);
        lat = a.lat + (b.lat - a.lat) * f;
        lon = a.lon + (b.lon - a.lon) * f;
      }
      var p = course.proj.toXY(lat, lon);
      x[k] = p.x; y[k] = p.y;
    }
    // 艇速と針路は、前後2秒の位置の差から出す（端末が返す値は、止まっていると欠けるため）
    var h = null;
    for (k = 0; k < n; k++) {
      var i0 = Math.max(0, k - 2), i1 = Math.min(n - 1, k + 2);
      var pa = { x: x[i0], y: y[i0] }, pb = { x: x[i1], y: y[i1] };
      var s = i1 > i0 ? G.dist(pa, pb) / (i1 - i0) : 0;
      spd[k] = s;
      if (s > MIN_MOVE) h = G.bearing(pa, pb);
      hdg[k] = h;
    }
    // 動き出す前の針路は、最初に動いたときの向きで埋める
    var firstH = 0;
    for (k = 0; k < n; k++) if (hdg[k] !== null) { firstH = hdg[k]; break; }
    for (k = 0; k < n && hdg[k] === null; k++) hdg[k] = firstH;

    var from = Math.ceil((fx[0].t - startMs) / 1000) - t0;
    var to = Math.floor((fx[last].t - startMs) / 1000) - t0;
    return {
      t0: t0, dt: 1, x: x, y: y, hdg: hdg, spd: spd,
      none: from >= n - 1 || to <= 0,             // この時間帯には、その艇の記録がない（端の1点だけの場合も含む）
      from: Math.max(0, Math.min(n - 1, from)),   // この範囲の外は、その艇の記録がない
      to: Math.max(0, Math.min(n - 1, to))
    };
  }

  /* 読み込んだ航跡（parse の結果の配列）から、観戦画面用のデータを作る。
   * startMs はスタート信号の時刻（1970年からのミリ秒）。
   * win = { fromMs, toMs } を渡すと、その時間帯だけを取り出す（1日に複数レースある日の、1レース分）。 */
  function build(tracks, course, startMs, win) {
    if (!tracks.length) throw new Error('航跡がありません');
    var first = Infinity, last = -Infinity;
    tracks.forEach(function (tr) { first = Math.min(first, tr.first); last = Math.max(last, tr.last); });
    if (win) {
      first = Math.max(first, win.fromMs);
      last = Math.min(last, win.toMs);
      if (!(last > first)) throw new Error('このレースの時間帯に、航跡の記録がありません');
    }
    var t0 = Math.floor((first - startMs) / 1000);
    var tEnd = Math.ceil((last - startMs) / 1000);
    if (tEnd - t0 > MAX_HOURS * 3600) throw new Error('記録の時間幅が長すぎます（' + MAX_HOURS + '時間まで）');
    var n = Math.max(2, tEnd - t0 + 1);
    return {
      t0: t0, dt: 1, n: n, tEnd: t0 + n - 1,
      imported: true,
      startMs: startMs,
      firstMs: first,
      lastMs: last,
      boats: tracks.map(function (tr) { return resample(tr, course, startMs, t0, n); })
    };
  }

  /* 記録の中の、ある時刻の位置（前後の点から補間。範囲の外は端の位置） */
  function positionAt(tr, ms) {
    var fx = tr.fixes, last = fx.length - 1;
    if (ms <= fx[0].t) return { lat: fx[0].lat, lon: fx[0].lon };
    if (ms >= fx[last].t) return { lat: fx[last].lat, lon: fx[last].lon };
    var lo = 0, hi = last;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (fx[mid].t <= ms) lo = mid; else hi = mid; }
    var f = (ms - fx[lo].t) / (fx[hi].t - fx[lo].t);
    return { lat: fx[lo].lat + (fx[hi].lat - fx[lo].lat) * f, lon: fx[lo].lon + (fx[hi].lon - fx[lo].lon) * f };
  }

  function allMarks(tracks) {
    var out = [];
    tracks.forEach(function (tr) { (tr.marks || []).forEach(function (m) { out.push(m); }); });
    return out.sort(function (a, b) { return a.t - b.t; });
  }

  /* 運営艇が記録したスタート信号の時刻の一覧（取り消されたものは除く）。1日に複数レースあれば複数になる。 */
  function starts(tracks) {
    var out = [];
    allMarks(tracks).forEach(function (m) {
      if (m.type === 'start') out.push(m.t);
      else if (m.type === 'start-cancel') out.pop();
    });
    return out;
  }

  /* あるレースとして見せる時間帯。スタートの6分前から、次のレースのスタートの6分前まで。
   * 次のレースが無ければ、記録の最後まで。運営艇が記録したスタートでなければ null（＝全体を見せる）。
   * こうしておくと、途中でやめた艇の「次のレースでの動き」が、前のレースの続きとして数えられない。 */
  function raceWindow(startList, startMs) {
    var i = startList.indexOf(startMs);
    if (i < 0) return null;
    return {
      fromMs: startMs - PRE_MS,
      toMs: i + 1 < startList.length ? startList[i + 1] - PRE_MS : Infinity
    };
  }

  /* そのスタートと一緒に運営艇が記録した周回数。記録が無ければ null。 */
  function lapsAt(tracks, startMs) {
    var laps = null;
    allMarks(tracks).forEach(function (m) { if (m.type === 'start' && m.t === startMs && m.laps) laps = m.laps; });
    return laps;
  }

  /* 運営艇の記録から、あるスタート時刻のレースのコースを組み立てる。運営艇の記録が無ければ null。
   *   各マーク: そのスタート以前で最後に打った位置（無ければ、その後で最初に打った位置）
   *   本部船:   スタート信号を押した位置（無ければ、その時刻の運営艇の位置）
   *   風軸:     下マークから上マークを見た方位（両方あるとき）
   *   周回数:   そのスタートと一緒に記録された値（あるとき）
   * 戻り値の relocate はコース設定への上書き、overrides は実際に打ったマークの位置。 */
  function opsCourse(tracks, startMs) {
    var opsTracks = tracks.filter(function (tr) { return tr.ops; });
    if (!opsTracks.length) return null;
    var marks = allMarks(opsTracks);
    function pick(type) {
      var before = null, after = null;
      marks.forEach(function (m) {
        if (m.type !== type || m.lat === null) return;
        if (m.t <= startMs) before = m; else if (!after) after = m;
      });
      return before || after;
    }
    var cb = null;
    marks.forEach(function (m) {
      if (m.type === 'start' && m.t === startMs && m.lat !== null) cb = { lat: m.lat, lon: m.lon };
    });
    if (!cb) cb = positionAt(opsTracks[0], startMs);

    var relocate = { lat: cb.lat, lon: cb.lon }, overrides = {}, found = {};
    ['m1', 'm4', 'fin'].forEach(function (key) {
      var m = pick(key);
      found[key] = !!m;
      if (m) overrides[key] = { lat: m.lat, lon: m.lon };
    });
    if (found.m1 && found.m4) {
      var proj = G.projection(overrides.m4.lat, overrides.m4.lon);
      var brg = G.bearing({ x: 0, y: 0 }, proj.toXY(overrides.m1.lat, overrides.m1.lon));
      relocate.windMag = Math.round(G.norm360(brg + G.declinationWest(cb.lat, cb.lon))) % 360;
    }
    var laps = lapsAt(opsTracks, startMs);
    if (laps) relocate.laps = laps;
    return { relocate: relocate, overrides: overrides, found: found };
  }

  RT.importer = {
    parse: parse, build: build, MAX_ACC: MAX_ACC,
    starts: starts, opsCourse: opsCourse, positionAt: positionAt,
    raceWindow: raceWindow, lapsAt: lapsAt, PRE_MS: PRE_MS
  };
})(typeof window !== 'undefined' ? window : globalThis);
