/* 位置・方位の計算。
 * レース海面は数km四方なので、基準点まわりの平面（x=東, y=北, 単位m）で扱う。
 * 方位はすべて「北を0°として時計回り」の度。 */
(function (root) {
  'use strict';
  var RT = root.RT = root.RT || {};
  var R = 6371008.8;
  var D2R = Math.PI / 180;
  var R2D = 180 / Math.PI;

  function norm360(a) { a = a % 360; return a < 0 ? a + 360 : a; }
  function norm180(a) { a = norm360(a); return a > 180 ? a - 360 : a; }

  function vec(bearing) {
    var r = bearing * D2R;
    return { x: Math.sin(r), y: Math.cos(r) };
  }
  function bearing(from, to) {
    return norm360(Math.atan2(to.x - from.x, to.y - from.y) * R2D);
  }
  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function offset(p, brg, d) {
    var v = vec(brg);
    return { x: p.x + v.x * d, y: p.y + v.y * d };
  }
  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function unit(a) {
    var n = Math.hypot(a.x, a.y) || 1;
    return { x: a.x / n, y: a.y / n };
  }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  /* 基準点まわりの平面投影 */
  function projection(lat0, lon0) {
    var k = Math.cos(lat0 * D2R);
    return {
      lat0: lat0,
      lon0: lon0,
      toXY: function (lat, lon) {
        return { x: (lon - lon0) * D2R * R * k, y: (lat - lat0) * D2R * R };
      },
      toLatLon: function (p) {
        return { lat: lat0 + (p.y / R) * R2D, lon: lon0 + (p.x / (R * k)) * R2D };
      }
    };
  }

  /* 線分 p1-p2 と q1-q2 の交差。交差すれば {t, u}（それぞれの線分上の位置 0..1）。 */
  function segIntersect(p1, p2, q1, q2) {
    var rx = p2.x - p1.x, ry = p2.y - p1.y;
    var sx = q2.x - q1.x, sy = q2.y - q1.y;
    var den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    var qpx = q1.x - p1.x, qpy = q1.y - p1.y;
    var t = (qpx * sy - qpy * sx) / den;
    var u = (qpx * ry - qpy * rx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { t: t, u: u };
  }

  /* 偏差（西偏を正、度）。国土地理院 磁気図2020.0年値の近似式。日本周辺でのみ有効。 */
  function declinationWest(lat, lon) {
    var dp = lat - 37, dl = lon - 138;
    var minutes = 495.822 + 18.462 * dp - 7.726 * dl +
      0.007 * dp * dp - 0.007 * dp * dl - 0.655 * dl * dl;
    return minutes / 60;
  }

  function fmtDM(v, pos, neg) {
    var hemi = v >= 0 ? pos : neg;
    v = Math.abs(v);
    var d = Math.floor(v);
    var m = (v - d) * 60;
    if (m.toFixed(3) === '60.000') { d += 1; m = 0; }
    return hemi + ' ' + d + '度 ' + m.toFixed(3) + '分';
  }
  function fmtLat(lat) { return fmtDM(lat, '北緯', '南緯'); }
  function fmtLon(lon) { return fmtDM(lon, '東経', '西経'); }

  function fmtDeg(a) {
    var n = Math.round(norm360(a)) % 360;
    return (n < 10 ? '00' : n < 100 ? '0' : '') + n + '°';
  }

  /* 秒 → "m:ss"（負の値は絶対値で表示） */
  function fmtClock(sec) {
    sec = Math.abs(Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  RT.geo = {
    D2R: D2R, R2D: R2D,
    norm360: norm360, norm180: norm180,
    vec: vec, bearing: bearing, dist: dist, offset: offset,
    sub: sub, dot: dot, unit: unit, mid: mid,
    projection: projection, segIntersect: segIntersect,
    declinationWest: declinationWest,
    fmtLat: fmtLat, fmtLon: fmtLon, fmtDeg: fmtDeg, fmtClock: fmtClock
  };
})(typeof window !== 'undefined' ? window : globalThis);
