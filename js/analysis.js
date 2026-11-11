/* コース取りの分析。レグごとに「左右どこを走ったか」「タック回数」「帆走距離」を出す。
 *
 * race.js と同じく、位置の列（1秒ごと）と回航時刻だけを使う。
 * シミュレーションの内部状態は見ていないので、本番の GPS データにもそのまま使える。
 *
 * 左右は「風上に向かって見たとき」の、レグ中心線（レグの始点と終点を結ぶ線）からのずれ。
 * 右が正、左が負（単位 m）。 */
(function (root) {
  'use strict';
  var RT = root.RT = root.RT || {};
  var G = RT.geo;

  var WIN = 3;          // 進行方向を出すときの前後の幅（秒）。GPS の細かい揺れをならす
  var HOLD = 4;         // 反対タックがこの秒数続いたらタックと認める
  var MIN_ANGLE = 15;   // 風軸に対してこの角度より浅い向きは、どちらのタックか判定しない
  var MIN_SPEED = 0.4;  // これより遅いときは判定しない（m/s）
  var DIST_STEP = 3;    // 帆走距離はこの秒数おきの位置で測る（GPS の揺れによる水増しを抑える）
  var SIDE_RATIO = 0.06; // 平均のずれがレグ長のこの割合を超えたら「右寄り／左寄り」とする

  /* レグの定義。defs[j] は「ゲート j-1 を通ってからゲート j を通るまで」。defs[0] は無し。 */
  function legs(gateList) {
    var c = gateList.course, M = c.marks, defs = [null];
    for (var j = 1; j < gateList.length; j++) {
      var g = gateList[j], d;
      if (g.type === 'm1') d = { kind: 'beat', name: g.lap + '上り', a: g.lap === 1 ? c.startMid : M.m4, b: M.m1 };
      else if (g.type === 'm4') d = { kind: 'run', name: g.lap + '下り', a: M.m1, b: M.m4 };
      else d = { kind: 'reach', name: 'フィニッシュ', a: M.m4, b: c.finMid };
      var dir = G.unit(G.sub(d.b, d.a));
      d.len = G.dist(d.a, d.b);
      d.up = d.kind === 'run' ? { x: -dir.x, y: -dir.y } : dir;   // レグに沿って風上を向く向き
      d.right = { x: d.up.y, y: -d.up.x };                         // 風上に向かって右
      d.upBearing = G.bearing({ x: 0, y: 0 }, d.up);
      defs.push(d);
    }
    return defs;
  }

  /* タックした時刻の一覧。進行方向が風軸の左右どちら側かの入れ替わりを数える。 */
  function detectTacks(tr, k0, k1, upBearing) {
    var n = tr.x.length, state = 0, held = 0, candK = -1, times = [];
    var kEnd = Math.min(n - 1 - WIN, k1 + HOLD + 2);
    for (var k = Math.max(WIN, k0); k <= kEnd; k++) {
      var dx = tr.x[k + WIN] - tr.x[k - WIN], dy = tr.y[k + WIN] - tr.y[k - WIN];
      if (Math.hypot(dx, dy) / (2 * WIN * tr.dt) < MIN_SPEED) continue;
      var a = G.norm180(G.bearing({ x: 0, y: 0 }, { x: dx, y: dy }) - upBearing);
      if (Math.abs(a) < MIN_ANGLE || Math.abs(a) > 180 - MIN_ANGLE) continue;
      var s = a < 0 ? -1 : 1;   // -1: 左へ進む（スターボードタック） / +1: 右へ進む（ポートタック）
      if (state === 0) { state = s; continue; }
      if (s === state) { held = 0; continue; }
      if (held === 0) candK = k;
      held++;
      if (held >= HOLD) {
        if (candK <= k1) times.push(tr.t0 + candK * tr.dt);
        state = s; held = 0;
      }
    }
    return times;
  }

  /* 1艇・1レグの集計。t0〜t1 はそのレグの開始・終了時刻。 */
  function legStats(tr, def, t0, t1) {
    var k0 = Math.max(0, Math.ceil(t0 - tr.t0));
    var k1 = Math.min(tr.x.length - 1, Math.floor(t1 - tr.t0));
    if (k1 <= k0) return null;
    var min = Infinity, max = -Infinity, sum = 0, nRight = 0, cnt = 0;
    for (var k = k0; k <= k1; k++) {
      var lat = (tr.x[k] - def.a.x) * def.right.x + (tr.y[k] - def.a.y) * def.right.y;
      if (lat < min) min = lat;
      if (lat > max) max = lat;
      if (lat > 0) nRight++;
      sum += lat; cnt++;
    }
    var dist = 0, prev = k0;
    for (k = k0 + DIST_STEP; k <= k1; k += DIST_STEP) {
      dist += Math.hypot(tr.x[k] - tr.x[prev], tr.y[k] - tr.y[prev]);
      prev = k;
    }
    dist += Math.hypot(tr.x[k1] - tr.x[prev], tr.y[k1] - tr.y[prev]);
    var mean = sum / cnt;
    var side = mean > def.len * SIDE_RATIO ? '右寄り' : mean < -def.len * SIDE_RATIO ? '左寄り' : '中央';
    var tacks = def.kind === 'beat' ? detectTacks(tr, k0, k1, def.upBearing) : null;
    return {
      time: t1 - t0,
      dist: dist,
      latMin: min, latMax: max, latMean: mean,
      rightShare: nRight / cnt,
      side: side,
      tacks: tacks ? tacks.length : null,
      tackTimes: tacks
    };
  }

  /* 時刻 t の位置（前後の点から補間） */
  function posAt(tr, t) {
    var s = Math.max(0, Math.min(tr.x.length - 1, (t - tr.t0) / tr.dt));
    var k = Math.min(tr.x.length - 2, Math.floor(s)), f = s - k;
    return { x: tr.x[k] + (tr.x[k + 1] - tr.x[k]) * f, y: tr.y[k] + (tr.y[k + 1] - tr.y[k]) * f };
  }
  /* 時刻 t の速さ(m/s)と進行方位。前後2秒の位置の差から出す。 */
  function velAt(tr, t) {
    var a = posAt(tr, t - 2), b = posAt(tr, t + 2);
    return { speed: G.dist(a, b) / 4, bearing: G.bearing(a, b) };
  }

  /* スタートの分析。ラインを切った時刻・位置・艇速と、信号の瞬間にラインまで何mあったか。
   * GPS には数mの誤差があるので、リコールの判定には使えない（参考値）。 */
  function startStats(gateList, tr, ev) {
    if (ev[0] === undefined) return null;
    var c = gateList.course, cb = c.cb, pin = c.marks.pin;
    var len = G.dist(cb, pin);
    var e = G.unit(G.sub(pin, cb));    // 本部船 → 下マーク
    var n = gateList[0].dir;           // ラインに直角で、コース側（風上）を向く
    var tc = ev.startRaw !== undefined ? ev.startRaw : ev[0];
    var fromCb = G.dot(G.sub(posAt(tr, tc), cb), e);
    var frac = fromCb / len;
    var v = velAt(tr, tc);
    return {
      time: tc,                         // 信号からの秒。負なら信号より前に切ったように見えている
      fromCb: fromCb,                   // 切った位置（本部船からの距離 m）
      lineLen: len,
      frac: frac,
      zone: frac < 1 / 3 ? '本部船寄り' : frac > 2 / 3 ? '下マーク寄り' : '中央',
      speed: v.speed,
      tack: G.norm180(v.bearing - c.windTrue) < 0 ? 'スターボード' : 'ポート',
      gapAtGun: -G.dot(G.sub(posAt(tr, 0), cb), n),   // 信号の瞬間のラインまでの距離（正 = ラインの手前）
      speedAtGun: velAt(tr, 0).speed
    };
  }

  /* スタートラインの有利不利。下マーク側が本部船側より何m風上にあるか（正なら下マーク側が有利）。 */
  function lineBias(course) {
    return G.dot(G.sub(course.marks.pin, course.cb), course.u);
  }

  /* 全艇・全レグ。戻り値 [艇][レグ番号] = 集計（そのレグを終えていなければ null）。
   * [艇][0] にはスタートの分析を入れる。 */
  function all(gateList, tracks, events) {
    var defs = legs(gateList);
    return tracks.map(function (tr, i) {
      var ev = events[i], out = [startStats(gateList, tr, ev)];
      for (var j = 1; j < gateList.length; j++) {
        out.push(ev[j] === undefined || ev[j - 1] === undefined ? null : legStats(tr, defs[j], ev[j - 1], ev[j]));
      }
      return out;
    });
  }

  RT.analysis = {
    legs: legs, all: all, legStats: legStats, detectTacks: detectTacks,
    startStats: startStats, lineBias: lineBias
  };
})(typeof window !== 'undefined' ? window : globalThis);
