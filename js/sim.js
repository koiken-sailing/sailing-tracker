/* 艇団のシミュレーション（試作用のダミーデータ生成）。
 *
 * 本番ではスマホの GPS から届く位置がこれに置き換わる。
 * 出力は「1秒ごとの位置・針路・艇速」で、スマホから届くデータと同じ形にしてある。
 * GPS らしい数m以内の誤差も加えている。 */
(function (root) {
  'use strict';
  var RT = root.RT = root.RT || {};
  var G = RT.geo;

  var T0 = -360;     // 記録開始（スタート6分前）
  var DT = 0.5;      // 計算の刻み（秒）
  var TWA = 44;      // クローズホールドの風位角
  var T_MAX = 3 * 3600;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    var u = 1 - rng(), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* 折れ線の角を丸める */
  function chaikin(pts, times) {
    for (var k = 0; k < times; k++) {
      var out = [pts[0]];
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1];
        out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }
  function polyLen(pts) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) s += G.dist(pts[i - 1], pts[i]);
    return s;
  }
  /* 折れ線上を距離 s だけ進んだ位置と向き */
  function polyline(pts) {
    var cum = [0];
    for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + G.dist(pts[i - 1], pts[i]));
    return {
      total: cum[cum.length - 1],
      at: function (s) {
        s = clamp(s, 0, cum[cum.length - 1]);
        var i = 1;
        while (i < cum.length - 1 && cum[i] < s) i++;
        var a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1] || 1;
        var f = (s - cum[i - 1]) / seg;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, h: G.bearing(a, b) };
      }
    };
  }

  function run(course, opts) {
    var n = opts.n;
    var rng = mulberry32(opts.seed || 11);
    var sp = RT.perf.speeds(course.params.windKn);
    var wt = course.windTrue;
    var laps = course.params.laps;
    var M = course.marks, cb = course.cb;

    // 風の振れ（ゆっくりした周期の重ね合わせ）
    var ph1 = rng() * 480, ph2 = rng() * 170;
    function windAt(t) {
      return wt + 6 * Math.sin(2 * Math.PI * (t + ph1) / 480) +
        3 * Math.sin(2 * Math.PI * (t + ph2) / 170);
    }

    // 回航の通過点。軸（下マーク→上マーク）に対して 右=+90°, 左=-90°
    var axB = course.axisBearing;
    function rel(mark, right, up) {
      return G.offset(G.offset(mark, axB + 90, right), axB, up);
    }
    var TOP = [rel(M.m1, 14, 0), rel(M.m1, 0, 10), rel(M.m1, -10, 3)];
    var BOTTOM = [rel(M.m4, -13, 2), rel(M.m4, 0, -11)];

    var lineVec = G.sub(M.pin, cb);
    var lineLen = Math.hypot(lineVec.x, lineVec.y) || 1;
    var e = { x: lineVec.x / lineLen, y: lineVec.y / lineLen };
    var u0 = course.u;
    var finVec = G.sub(M.fin, cb);

    function rndBox() {
      var al = -40 + rng() * (lineLen + 80);
      var dp = 35 + rng() * 95;
      return { x: cb.x + e.x * al - u0.x * dp, y: cb.y + e.y * al - u0.y * dp };
    }

    // スタート位置の割り当て（ライン上にばらけさせる）
    var slots = [];
    for (var i = 0; i < n; i++) slots.push(i);
    for (i = n - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1)), tmp = slots[i];
      slots[i] = slots[j]; slots[j] = tmp;
    }

    function makeBoat(idx) {
      var skill = 0.87 + 0.15 * rng();                       // 腕前の差（艇速の倍率）
      var frac = 0.12 + 0.8 * (slots[idx] + 0.2 + 0.6 * rng()) / n;
      var delay = Math.round((1 + rng() * 6) * 2) / 2;       // ライン通過はスタートの1〜7秒後
      var S = { x: cb.x + e.x * lineLen * frac, y: cb.y + e.y * lineLen * frac };
      var hS = windAt(delay) - TWA;                          // スターボードタックで接近
      var dS = G.vec(hS);
      var vUp = sp.up * skill;
      var TAPP = 30;
      var Pa = { x: S.x - dS.x * vUp * TAPP, y: S.y - dS.y * vUp * TAPP };
      var Pb = { x: Pa.x - dS.x * 25, y: Pa.y - dS.y * 25 };
      var tA = delay - TAPP;
      var dur = tA - T0;
      var pts = [rndBox()];
      while (polyLen(pts.concat([Pb, Pa])) < 1.5 * dur) pts.push(rndBox());
      var path = polyline(chaikin(pts.concat([Pb, Pa]), 3));
      var ff = 0.25 + 0.5 * rng();
      var Pf = { x: cb.x + finVec.x * ff, y: cb.y + finVec.y * ff };
      var fd = G.unit(G.sub(Pf, BOTTOM[1]));
      return {
        skill: skill, delay: delay, along: lineLen * frac, S: S, hS: hS, dS: dS, vUp: vUp, Pa: Pa, tA: tA,
        path: path, vPre: path.total / dur,
        cLeft: 50 + rng() * 230, cRight: 50 + rng() * 230,   // 左右どこまで伸ばすか
        sens: rng() < 0.3 ? 99 : 3.5 + rng() * 6,            // 風の振れに合わせてタックする敏感さ（3割は振れを無視）
        wT: 35 + rng() * 25, wPh: rng() * 60, runBias: -20 + rng() * 40,
        Pf: Pf, Pg: { x: Pf.x + fd.x * 45, y: Pf.y + fd.y * 45 },
        st: null, doneT: null, nx: 0, ny: 0,
        x: [], y: [], hdg: [], spd: []
      };
    }

    /* 目標点へ向かう。十分近づくか、いったん近づいたあと離れ始めたら到達とみなす
     * （小回りが利かずに目標点の周りを回り続けるのを防ぐ）。 */
    function reached(st, wp, rad) {
      var d = G.dist(st, wp);
      if (st.seek !== wp) { st.seek = wp; st.minD = d; }
      if (d < st.minD) st.minD = d;
      return d < rad || (st.minD < 8 && d > st.minD + 2);
    }

    function step(b, t) {
      var st = b.st, W = windAt(t);
      var hd, vt, turn = 14;
      var shift = G.norm180(W - wt);

      if (st.mode === 'up') {
        var wp = TOP[0];
        var brg = G.bearing(st, wp);
        var a = G.norm180(brg - W);
        var toWP = G.sub(wp, st);
        var up = G.dot(toWP, G.vec(W));
        var lat = -G.dot(toWP, G.vec(W + 90));
        var want;
        if (st.tack === 'S') {
          want = a >= TWA + 3 || (lat < -b.cLeft && up > 60) ||
            (shift < -b.sens && up > 120 && Math.abs(a) < 30 && lat < 0.6 * b.cRight);
        } else {
          want = a <= -(TWA + 3) || (lat > b.cRight && up > 60) ||
            (shift > b.sens && up > 120 && Math.abs(a) < 30 && lat > -0.6 * b.cLeft);
        }
        if (want && t - st.lastTack > 25) {
          st.tack = st.tack === 'S' ? 'P' : 'S';
          st.lastTack = t;
        }
        if (st.tack === 'S') hd = a <= -TWA ? brg : W - TWA;
        else hd = a >= TWA ? brg : W + TWA;
        var off = Math.abs(G.norm180(hd - W));
        vt = off <= 50 ? sp.up : off >= 90 ? sp.reach : sp.up + (sp.reach - sp.up) * (off - 50) / 40;
        if (G.dist(st, wp) < 40) turn = 25;
        if (G.dist(st, wp) < 6) { st.mode = 'top'; st.q = 1; }
      } else if (st.mode === 'top') {
        hd = G.bearing(st, TOP[st.q]);
        vt = sp.reach * 0.75; turn = 30;
        if (reached(st, TOP[st.q], 5)) {
          st.q++;
          if (st.q >= TOP.length) st.mode = 'down';
        }
      } else if (st.mode === 'down') {
        var dd = G.dist(st, BOTTOM[0]);
        var weave = dd > 70 ? 13 * Math.sin(2 * Math.PI * (t + b.wPh) / b.wT) : 0;
        var bias = b.runBias * clamp((dd - 120) / 200, 0, 1);   // レグ前半は左右に散らばる
        hd = G.bearing(st, BOTTOM[0]) + weave + bias;
        vt = sp.down * 1.03;
        if (dd < 40) turn = 25;
        if (dd < 6) { st.mode = 'bottom'; st.q = 1; }
      } else if (st.mode === 'bottom') {
        hd = G.bearing(st, BOTTOM[1]);
        vt = sp.reach * 0.7; turn = 30;
        if (reached(st, BOTTOM[1], 5)) {
          st.lap++;
          if (st.lap >= laps) st.mode = 'reach';
          else { st.mode = 'up'; st.tack = 'P'; st.lastTack = t; }
        }
      } else if (st.mode === 'reach') {
        hd = G.bearing(st, b.Pf);
        vt = sp.reach; turn = 25;
        if (reached(st, b.Pf, 5)) st.mode = 'coast';
      } else if (st.mode === 'coast') {
        hd = G.bearing(st, b.Pg);
        vt = sp.reach * 0.6;
        if (reached(st, b.Pg, 8)) { st.mode = 'done'; b.doneT = t; }
      } else {
        hd = W; vt = 0.2;
      }

      vt *= b.skill * st.gust;
      var dh = G.norm180(hd - st.h);
      if (Math.abs(dh) > 25 && st.mode !== 'done') vt *= 0.55;   // タック・回航中の失速
      var maxTurn = turn * DT;
      st.h = G.norm360(st.h + clamp(dh, -maxTurn, maxTurn));
      st.v += (vt - st.v) * (1 - Math.exp(-DT / 4));
      var hv = G.vec(st.h);
      st.x += hv.x * st.v * DT;
      st.y += hv.y * st.v * DT;
      st.gust = clamp(st.gust + (1 - st.gust) * 0.01 + 0.006 * gauss(rng), 0.92, 1.08);
    }

    var boats = [];
    for (i = 0; i < n; i++) boats.push(makeBoat(i));

    var NOISE = 1.2 * Math.sqrt(1 - 0.95 * 0.95);
    var endAt = null;
    for (var s = 0; ; s++) {
      var t = T0 + s * DT;
      var whole = s % 2 === 0;
      var allDone = true;
      for (i = 0; i < n; i++) {
        var b = boats[i], px, py, ph, pv;
        if (t <= b.tA) {
          var p = b.path.at((t - T0) * b.vPre);
          px = p.x; py = p.y; ph = p.h; pv = b.vPre;
        } else if (t < b.delay) {
          var f = (t - b.tA) * b.vUp;
          px = b.Pa.x + b.dS.x * f; py = b.Pa.y + b.dS.y * f; ph = G.norm360(b.hS); pv = b.vUp;
        } else {
          if (!b.st) {
            b.st = { x: b.S.x, y: b.S.y, h: G.norm360(b.hS), v: b.vUp, tack: 'S', mode: 'up', lap: 0, q: 0, lastTack: t - 100, gust: 1 };
          } else {
            step(b, t);
          }
          px = b.st.x; py = b.st.y; ph = b.st.h; pv = b.st.v;
        }
        if (b.doneT === null) allDone = false;
        if (whole) {
          b.nx = 0.95 * b.nx + NOISE * gauss(rng);
          b.ny = 0.95 * b.ny + NOISE * gauss(rng);
          b.x.push(px + b.nx); b.y.push(py + b.ny); b.hdg.push(ph); b.spd.push(pv);
        }
      }
      if (allDone && endAt === null) endAt = t + 60;
      if (whole && ((endAt !== null && t >= endAt) || t >= T_MAX)) break;
    }

    var K = boats[0].x.length;
    return {
      t0: T0, dt: 1, n: K, tEnd: T0 + K - 1,
      windAt: windAt,
      complete: endAt !== null,
      boats: boats.map(function (b) {
        return {
          t0: T0, dt: 1, x: b.x, y: b.y, hdg: b.hdg, spd: b.spd,
          // 検算用の正解（本番データには無い）: ラインを切った時刻と、本部船からの距離
          truth: { startTime: b.delay, startFromCb: b.along, startSpeed: b.vUp }
        };
      })
    };
  }

  RT.sim = { run: run, T0: T0 };
})(typeof window !== 'undefined' ? window : globalThis);
