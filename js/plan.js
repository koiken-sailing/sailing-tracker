/* コース設定ナビの計算。
 * 最初に打ったマークと、風軸・上下の距離・スタートラインの長さから、残りのマークを打つ位置（目標）を出す。
 * 画面の処理（js/tracker.js）から切り離してあるので、自動テスト（tools/test.js）で確かめられる。
 *
 * 基準は下マーク。打ってあれば実際の位置、まだなら「上マークから風下へ取った位置」を使う。
 *   上マークの目標         = 下マークから風上へ「上下の距離」
 *   本部船の目標           = 下マークから、風上に向かって右へ「スタートラインの長さ」（運営艇のみ）
 *   フィニッシュマークの目標 = 本部船の風下側（運営艇のみ）
 * 風軸はコンパスの読み（磁針方位）で受け取り、計算のときに真方位へ直す。 */
(function (root) {
  'use strict';
  var RT = root.RT = root.RT || {};
  var G = RT.geo;

  var DEFAULT = { wind: 200, dist: 600, line: 100 };
  var LIMIT = { wind: [0, 359], dist: [50, 3000], line: [10, 500] };
  var FIN_LEN = 50;        // フィニッシュラインの長さの目安 m
  var ARRIVE_M = 10;       // 目標のこの距離以内に入ったら「到着」とする（GPS の誤差が5mほどあるため）
  var NAMES = { m1: '上マーク', m4: '下マーク', cb: '本部船の位置', fin: 'フィニッシュマーク' };

  /* 入力された数字を、使える範囲の整数に直す。数字でなければ null。風軸は 0〜359 に巻き戻す。 */
  function clamp(key, value) {
    var lim = LIMIT[key], v = Math.round(Number(value));
    if (!lim || value === '' || value === null || !isFinite(v)) return null;
    if (key === 'wind') return ((v % 360) + 360) % 360;
    return Math.max(lim[0], Math.min(lim[1], v));
  }

  /* from から to を見た角度（コンパスの読み、度）。from, to は { lat, lon }。 */
  function axisAngle(from, to) {
    var proj = G.projection(from.lat, from.lon);
    var brg = G.bearing({ x: 0, y: 0 }, proj.toXY(to.lat, to.lon));
    return Math.round(G.norm360(brg + G.declinationWest(from.lat, from.lon))) % 360;
  }

  /* 目標位置を計算する。
   * inp = { wind, dist, line, ops, m1, m4, fin, started }（位置は { lat, lon } か null。started は記録済みのスタートの位置）
   * 戻り値 = { proj, decl, windTrue, targets: [{ key, name, lat, lon, x, y, placed: 打った位置 | null, dev: 目標とのずれ m | null }] }
   * 上マークも下マークも打っていなければ null。 */
  function calc(inp) {
    var anchor = inp.m4 || inp.m1;
    if (!anchor) return null;
    var proj = G.projection(anchor.lat, anchor.lon);
    var decl = G.declinationWest(anchor.lat, anchor.lon), wt = G.norm360(inp.wind - decl);
    function xy(p) { return p ? proj.toXY(p.lat, p.lon) : null; }
    var p1 = xy(inp.m1), p4 = xy(inp.m4), targets = [];
    var low = p4 || G.offset(p1, wt + 180, inp.dist);          // 下マークの位置（実際、または目標）
    function add(key, p, placed) {
      var q = proj.toLatLon(p), pp = xy(placed);
      targets.push({
        key: key, name: NAMES[key], lat: q.lat, lon: q.lon, x: p.x, y: p.y,
        placed: placed || null, dev: pp ? G.dist(pp, p) : null
      });
    }
    if (!inp.m4) add('m4', low, null);
    if (inp.m4) add('m1', G.offset(low, wt, inp.dist), inp.m1 || null);
    if (inp.ops) {
      var cb = G.offset(low, wt + 90, inp.line);
      add('cb', cb, inp.started || null);
      var ang = Math.asin(Math.min(1, FIN_LEN / (2 * inp.line))) * 180 / Math.PI;
      add('fin', G.offset(cb, wt + 180 + ang, FIN_LEN), inp.fin || null);
    }
    return { proj: proj, decl: decl, windTrue: wt, targets: targets };
  }

  /* いまの位置 here（{ lat, lon }）から目標 target までの案内。
   * 戻り値 = { dist: 距離 m, brg: 方位（コンパスの読み）, along: 風上へ何m（負なら風下へ）, cross: 風上に向かって右へ何m（負なら左へ） } */
  function guide(c, target, here) {
    var h = c.proj.toXY(here.lat, here.lon), v = { x: target.x - h.x, y: target.y - h.y };
    var up = G.vec(c.windTrue), right = G.vec(c.windTrue + 90);
    return {
      dist: Math.hypot(v.x, v.y),
      brg: Math.round(G.norm360(G.bearing(h, target) + c.decl)) % 360,
      along: v.x * up.x + v.y * up.y,
      cross: v.x * right.x + v.y * right.y
    };
  }

  RT.plan = {
    DEFAULT: DEFAULT, LIMIT: LIMIT, FIN_LEN: FIN_LEN, ARRIVE_M: ARRIVE_M, NAMES: NAMES,
    clamp: clamp, axisAngle: axisAngle, calc: calc, guide: guide
  };
})(typeof window !== 'undefined' ? window : globalThis);
