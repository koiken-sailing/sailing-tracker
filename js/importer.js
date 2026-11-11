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
    return {
      file: fileName || '',
      sail: String(d.sail === undefined ? '' : d.sail).slice(0, 12),
      name: String(d.name === undefined ? '' : d.name).slice(0, 20),
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
      from: Math.max(0, Math.min(n - 1, from)),   // この範囲の外は、その艇の記録がない
      to: Math.max(0, Math.min(n - 1, to))
    };
  }

  /* 読み込んだ航跡（parse の結果の配列）から、観戦画面用のデータを作る。
   * startMs はスタート信号の時刻（1970年からのミリ秒）。 */
  function build(tracks, course, startMs) {
    if (!tracks.length) throw new Error('航跡がありません');
    var first = Infinity, last = -Infinity;
    tracks.forEach(function (tr) { first = Math.min(first, tr.first); last = Math.max(last, tr.last); });
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

  RT.importer = { parse: parse, build: build, MAX_ACC: MAX_ACC };
})(typeof window !== 'undefined' ? window : globalThis);
