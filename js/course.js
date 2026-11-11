/* 上下コース（リーチングフィニッシュ）の設計。
 *
 * 基準点は本部船。本部船はスタートラインの右端（風上に向かって右）で、
 * フィニッシュラインの風上側の端も兼ねる。
 *
 *   下マーク = 本部船から風軸の左90°へ「スタートライン長」。アウターマークを兼ねる
 *              （スタートラインは本部船と下マークの間）
 *   上マーク = 下マークから風上へ「上下の距離」
 *   フィニッシュマーク = 本部船の風下側へ「フィニッシュライン長」
 *
 * 最終レグは、下マークを回ってスタートラインのすぐ風下をリーチングで走り、
 * 本部船の風下に張ったフィニッシュラインを切る。フィニッシュラインは最終レグに直角。
 * 計算した位置は「目標」。実際に打った位置（overrides）があればそちらを使う。 */
(function (root) {
  'use strict';
  var RT = root.RT = root.RT || {};
  var G = RT.geo;
  var KN = 0.514444;

  var DEFAULTS = {
    lat: 34.702,      // 本部船の位置（初期値は新西宮ヨットハーバーと芦屋浜の間の沖）
    lon: 135.325,
    windMag: 200,     // 風軸（コンパス角度）
    d14: 600,         // 上下の距離 m
    startLen: 100,    // スタートライン長（本部船〜下マーク）m
    finLen: 50,       // フィニッシュライン長 m
    laps: 2,          // 周回数
    windKn: 10        // 風速 kt
  };

  var MARKS = [
    { key: 'm1', name: '上マーク', short: '上' },
    { key: 'm4', name: '下マーク（アウター兼用）', short: '下' },
    { key: 'fin', name: 'フィニッシュマーク', short: 'F' }
  ];

  function build(p, overrides) {
    overrides = overrides || {};
    var proj = G.projection(p.lat, p.lon);
    var decl = G.declinationWest(p.lat, p.lon);
    var wt = G.norm360(p.windMag - decl);   // 真方位 = 磁針方位 − 西偏
    var cb = { x: 0, y: 0 };

    var targets = {};
    targets.m4 = G.offset(cb, wt - 90, p.startLen);
    targets.m1 = G.offset(targets.m4, wt, p.d14);
    // フィニッシュラインが最終レグ（下マーク→ライン中央）に直角になるよう、
    // 真風下から下マーク側へ asin(ライン長の半分 / スタートライン長) だけ振る
    var alpha = Math.asin(Math.min(0.9, p.finLen / (2 * p.startLen))) * G.R2D;
    targets.fin = G.offset(cb, wt + 180 + alpha, p.finLen);

    var marks = {}, moved = {};
    MARKS.forEach(function (m) {
      var o = overrides[m.key];
      if (o) {
        marks[m.key] = proj.toXY(o.lat, o.lon);
        moved[m.key] = G.dist(marks[m.key], targets[m.key]);
      } else {
        marks[m.key] = targets[m.key];
      }
    });
    // アウターは下マークと同じマーク。「スタートラインの端」として読むときの別名
    marks.pin = marks.m4;
    targets.pin = targets.m4;

    var startMid = G.mid(cb, marks.pin);
    var finMid = G.mid(cb, marks.fin);
    var axis = G.unit(G.sub(marks.m1, marks.m4));
    var u = G.vec(wt);
    var d = G.dist(marks.m1, marks.m4);
    var legs = {
      beat1: Math.max(0, G.dot(G.sub(marks.m1, startMid), axis)),
      d: d,
      fin: G.dist(marks.m4, finMid)
    };

    return {
      params: p,
      proj: proj,
      decl: decl,
      windTrue: wt,
      u: u,
      r: G.vec(wt + 90),
      cb: cb,
      targets: targets,
      marks: marks,
      moved: moved,
      startMid: startMid,
      finMid: finMid,
      axis: axis,
      axisBearing: G.bearing(marks.m4, marks.m1),
      legs: legs,
      length: legs.beat1 + (2 * p.laps - 1) * d + legs.fin,
      toMag: function (trueBrg) { return G.norm360(trueBrg + decl); },
      latLon: function (pt) { return proj.toLatLon(pt); }
    };
  }

  /* ILCA の艇速の目安（kt）。実測ではなく概算値。記録がたまれば実績に置き換える。 */
  var TABLE = {
    tws:   [4,   6,   8,   10,  12,  14,  16,  20],
    up:    [2.6, 3.4, 4.0, 4.4, 4.7, 4.9, 5.0, 5.1],   // クローズホールドの艇速
    down:  [2.2, 3.0, 3.8, 4.6, 5.3, 6.0, 6.8, 8.0],   // ランニングの風下方向の速さ
    reach: [2.8, 3.8, 4.8, 5.6, 6.3, 7.0, 7.8, 9.0]    // リーチングの艇速
  };
  var TWA_UP = 44;

  function interp(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    for (var i = 1; i < xs.length; i++) {
      if (x <= xs[i]) {
        var f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
        return ys[i - 1] + (ys[i] - ys[i - 1]) * f;
      }
    }
    return ys[ys.length - 1];
  }

  /* 風速(kt) → 各レグの速さ(m/s) */
  function speeds(tws) {
    var up = interp(TABLE.tws, TABLE.up, tws) * KN;
    return {
      twaUp: TWA_UP,
      up: up,
      upVmg: up * Math.cos(TWA_UP * G.D2R),
      down: interp(TABLE.tws, TABLE.down, tws) * KN,
      reach: interp(TABLE.tws, TABLE.reach, tws) * KN
    };
  }

  /* 先頭艇の所要時間の目安（秒） */
  function estimate(course) {
    var s = speeds(course.params.windKn);
    var L = course.legs, laps = course.params.laps;
    var upDist = L.beat1 + (laps - 1) * L.d;
    var t = upDist / s.upVmg + laps * L.d / s.down + L.fin / s.reach;
    return t * 1.03;   // タックや回航のロス分
  }

  RT.course = { DEFAULTS: DEFAULTS, MARKS: MARKS, build: build };
  RT.perf = { KN: KN, speeds: speeds, estimate: estimate };
})(typeof window !== 'undefined' ? window : globalThis);
