/* 航跡からスタート・回航・フィニッシュを判定し、順位を出す。
 *
 * シミュレーションの内部状態は使わず、位置の列だけを見る。
 * 本番でスマホから届く位置データにも、そのまま使える作りにしてある。
 *
 * 判定は「ゲート」（線分）を決まった向きに横切ったかどうかで行う。
 *   スタート    : 本部船-アウターの線を、上マーク側へ横切る（スタート時刻以降）
 *   上マーク    : マークから風上へ伸ばした線を、右から左へ横切る（反時計回り）
 *   下マーク    : マークから風下へ伸ばした線を、左から右へ横切る
 *   フィニッシュ: 本部船-フィニッシュマークの線を、下マークから遠ざかる向きに横切る */
(function (root) {
  'use strict';
  var RT = root.RT = root.RT || {};
  var G = RT.geo;
  var RAY = 200;   // マークから伸ばす判定線の長さ m
  var TOL = 12;    // GPS とマーク位置の誤差を見込んで、判定線をこの分だけ余分に伸ばす m

  /* 線分 a-b を、a 側へ da、b 側へ db だけ伸ばす */
  function extend(a, b, da, db) {
    var d = G.unit(G.sub(b, a));
    return {
      a: { x: a.x - d.x * da, y: a.y - d.y * da },
      b: { x: b.x + d.x * db, y: b.y + d.y * db }
    };
  }

  function gates(course) {
    var M = course.marks, ax = course.axis, L = course.legs;
    var left = { x: -ax.y, y: ax.x };
    var right = { x: ax.y, y: -ax.x };
    var list = [], seg;

    var sLine = G.sub(M.pin, course.cb);
    var sDir = G.unit({ x: -sLine.y, y: sLine.x });
    if (G.dot(sDir, G.sub(M.m1, course.startMid)) < 0) sDir = { x: -sDir.x, y: -sDir.y };
    seg = extend(course.cb, M.pin, TOL, TOL);
    list.push({ type: 'start', a: seg.a, b: seg.b, dir: sDir, len: 0, toLabel: 'スタート前', doneLabel: 'スタート' });

    var up = { x: M.m1.x + ax.x, y: M.m1.y + ax.y };
    var down = { x: M.m4.x - ax.x, y: M.m4.y - ax.y };
    for (var lap = 1; lap <= course.params.laps; lap++) {
      seg = extend(M.m1, up, TOL, RAY);
      list.push({
        type: 'm1', lap: lap, a: seg.a, b: seg.b,
        dir: left, len: lap === 1 ? L.beat1 : L.d,
        toLabel: lap + '上へ', doneLabel: lap + '上'
      });
      seg = extend(M.m4, down, TOL, RAY);
      list.push({
        type: 'm4', lap: lap, a: seg.a, b: seg.b,
        dir: right, len: L.d,
        toLabel: lap + '下へ', doneLabel: lap + '下'
      });
    }

    var fLine = G.sub(M.fin, course.cb);
    var fDir = G.unit({ x: -fLine.y, y: fLine.x });
    if (G.dot(fDir, G.sub(M.m4, course.finMid)) > 0) fDir = { x: -fDir.x, y: -fDir.y };
    seg = extend(course.cb, M.fin, TOL, TOL);
    list.push({ type: 'finish', a: seg.a, b: seg.b, dir: fDir, len: L.fin, toLabel: 'フィニッシュへ', doneLabel: 'フィニッシュ' });

    // remAfter[j] = ゲート j より後のレグ長の合計
    var rem = 0;
    for (var j = list.length - 1; j >= 0; j--) {
      list[j].remAfter = rem;
      rem += list[j].len;
    }
    list.course = course;
    return list;
  }

  /* 次のゲートまでの残り距離（レグの軸方向に測る） */
  function distToGo(gateList, j, pos) {
    var c = gateList.course, g = gateList[j];
    if (g.type === 'm1') return Math.max(0, G.dot(G.sub(c.marks.m1, pos), c.axis));
    if (g.type === 'm4') return Math.max(0, G.dot(G.sub(pos, c.marks.m4), c.axis));
    if (g.type === 'finish') {
      var f = G.unit(G.sub(c.finMid, c.marks.m4));
      return Math.max(0, G.dot(G.sub(c.finMid, pos), f));
    }
    return 0;
  }

  /* 各艇のゲート通過時刻を求める。戻り値 [艇][ゲート番号] = 時刻（秒、スタート=0）。
   * track = { t0, dt, x[], y[] }（等間隔の位置の列） */
  var EARLY = 10;   // スタート信号の何秒前までの通過を「スタート」とみなすか

  function crossing(tr, k, gate) {
    var p = { x: tr.x[k], y: tr.y[k] };
    var q = { x: tr.x[k + 1], y: tr.y[k + 1] };
    var hit = G.segIntersect(p, q, gate.a, gate.b);
    if (!hit) return null;
    if ((q.x - p.x) * gate.dir.x + (q.y - p.y) * gate.dir.y <= 0) return null;
    return tr.t0 + (k + hit.t) * tr.dt;
  }

  /* GPS には数mの誤差があるので、スタートはライン通過が信号の少し前に見えても
   * スタート済みとして扱う（リコールの判定には使わない）。
   * ラインに戻ってスタートし直した艇は、最初の上マークまでの間、後の通過で上書きする。 */
  function analyze(gateList, tracks) {
    return tracks.map(function (tr) {
      var ev = [], g = 0, n = tr.x.length, tc;
      for (var k = 0; k < n - 1 && g < gateList.length; k++) {
        if (g <= 1) {
          tc = crossing(tr, k, gateList[0]);
          // startRaw は補正前の通過時刻（スタート分析用。負なら信号より前に見えている）
          if (tc !== null && tc >= -EARLY) { ev[0] = Math.max(0, tc); ev.startRaw = tc; g = 1; continue; }
          if (g === 0) continue;
        }
        tc = crossing(tr, k, gateList[g]);
        if (tc !== null) { ev[g] = tc; g++; }
      }
      return ev;
    });
  }

  /* 時刻 t の順位表。posAt(i, t) は艇 i の位置 {x, y} を返す関数。 */
  function standings(gateList, events, t, posAt) {
    var nG = gateList.length;
    var rows = events.map(function (ev, i) {
      var passed = 0;
      while (passed < ev.length && ev[passed] <= t) passed++;
      var row = { i: i, passed: passed, started: passed > 0, finished: passed === nG };
      if (row.finished) {
        row.finishTime = ev[nG - 1];
        row.togo = 0;
        row.status = 'フィニッシュ';
      } else if (!row.started) {
        row.togo = Infinity;
        row.status = gateList[0].toLabel;
      } else {
        row.togo = distToGo(gateList, passed, posAt(i, t)) + gateList[passed].remAfter;
        row.status = gateList[passed].toLabel;
      }
      return row;
    });
    rows.sort(function (a, b) {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.started !== b.started) return a.started ? -1 : 1;
      if (!a.started) return a.i - b.i;
      return a.togo - b.togo;
    });
    rows.forEach(function (r, k) { r.rank = r.started ? k + 1 : null; });
    return rows;
  }

  RT.race = { gates: gates, analyze: analyze, standings: standings, distToGo: distToGo };
})(typeof window !== 'undefined' ? window : globalThis);
