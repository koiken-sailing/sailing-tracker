/* 計算部分の自動テスト。実行: node tools/test.js */
'use strict';
const path = require('path');
['geo', 'course', 'sim', 'race', 'analysis', 'importer'].forEach(f => require(path.join(__dirname, '..', 'js', f + '.js')));
const RT = globalThis.RT, G = RT.geo;

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; } else { failed++; console.log('  NG: ' + msg); }
}
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, msg + ' (got ' + a.toFixed(3) + ', want ' + b + ')'); }

// ---- 1. コースの幾何 ----
console.log('1. コースの幾何');
{
  const p = Object.assign({}, RT.course.DEFAULTS);
  const c = RT.course.build(p, {});
  ok(c.marks.pin === c.marks.m4, 'アウターは下マークと同じマーク');
  ok(RT.course.MARKS.length === 3, 'マークは上・下・フィニッシュの3個');
  near(G.dist(c.cb, c.marks.m4), p.startLen, 0.01, 'スタートライン長（本部船〜下マーク）');
  near(G.dist(c.marks.m1, c.marks.m4), p.d14, 0.01, '上下の距離');
  near(G.dist(c.cb, c.marks.fin), p.finLen, 0.01, 'フィニッシュライン長');
  near(G.norm180(G.bearing(c.marks.m4, c.marks.m1) - c.windTrue), 0, 0.01, '上マークは下マークの真風上');
  near(G.norm180(G.bearing(c.cb, c.marks.m4) - (c.windTrue - 90)), 0, 0.01, 'スタートラインは風軸に直角で、下マークは風上に向かって左');
  ok(G.dot(G.sub(c.marks.fin, c.cb), c.u) < 0, 'フィニッシュマークは本部船の風下側');
  const fl = G.norm180(G.bearing(c.cb, c.marks.fin) - G.bearing(c.marks.m4, c.finMid));
  near(Math.abs(fl), 90, 0.01, 'フィニッシュラインは最終レグに直角');
  const reach = G.norm180(G.bearing(c.marks.m4, c.finMid) - c.windTrue);
  ok(reach > 90 && reach < 125, '最終レグはリーチング（風位角 ' + reach.toFixed(0) + '°）');
  near(c.toMag(c.windTrue), p.windMag, 0.01, '真方位→磁針方位の戻し');
  // 偏差: 東京付近は西偏7.5°前後
  near(G.declinationWest(35.68, 139.77), 7.6, 0.4, '偏差（東京）');
  near(G.declinationWest(34.70, 135.33), 7.9, 0.6, '偏差（阪神間）');
  // 平面投影の往復
  const ll = c.latLon(c.marks.m1), back = c.proj.toXY(ll.lat, ll.lon);
  near(G.dist(back, c.marks.m1), 0, 0.001, '緯度経度への変換の往復');
  // 実際に打った位置の反映
  const moved = c.latLon(G.offset(c.targets.m1, 90, 30));
  const c2 = RT.course.build(p, { m1: moved });
  near(c2.moved.m1, 30, 0.01, '目標とのずれ');
}

// ---- 2. シミュレーションと回航判定 ----
console.log('2. シミュレーションと回航判定');
function checkRace(label, params, overridesFn, seed) {
  const p = Object.assign({}, RT.course.DEFAULTS, params);
  let c = RT.course.build(p, {});
  if (overridesFn) c = RT.course.build(p, overridesFn(c));
  const sim = RT.sim.run(c, { n: 12, seed: seed || 11 });
  const gates = RT.race.gates(c);
  const ev = RT.race.analyze(gates, sim.boats);
  ok(sim.complete, label + ': 全艇が時間内にフィニッシュ');
  let nan = false;
  sim.boats.forEach(b => { for (let k = 0; k < b.x.length; k++) if (!isFinite(b.x[k]) || !isFinite(b.y[k]) || !isFinite(b.hdg[k]) || !isFinite(b.spd[k])) nan = true; });
  ok(!nan, label + ': 数値に異常なし');
  let fin = [];
  ev.forEach((e, i) => {
    ok(e.length === gates.length, label + ': 艇' + i + ' の全ゲート通過を判定 (' + e.length + '/' + gates.length + ')');
    for (let k = 1; k < e.length; k++) ok(e[k] > e[k - 1], label + ': 艇' + i + ' の通過時刻が時間順');
    if (e.length) ok(e[0] >= 0 && e[0] < 12, label + ': 艇' + i + ' のスタート時刻が妥当 (' + e[0].toFixed(1) + 's)');
    if (e.length === gates.length) fin.push(e[e.length - 1]);
  });
  // 順位表
  const posAt = (i, t) => { const b = sim.boats[i]; const k = Math.max(0, Math.min(b.x.length - 1, Math.round(t - sim.t0))); return { x: b.x[k], y: b.y[k] }; };
  const end = RT.race.standings(gates, ev, sim.tEnd, posAt);
  ok(end.every(r => r.finished), label + ': 終了時に全艇フィニッシュ扱い');
  const midT = fin.length ? Math.min.apply(null, fin) / 2 : 300;
  const midRows = RT.race.standings(gates, ev, midT, posAt);
  ok(midRows.every((r, k) => r.rank === k + 1), label + ': レース中の順位が1位から連番');
  for (let k = 1; k < midRows.length; k++) ok(midRows[k].togo >= midRows[k - 1].togo, label + ': 残り距離の順に並ぶ');
  const before = RT.race.standings(gates, ev, -60, posAt);
  ok(before.every(r => !r.started && r.rank === null), label + ': スタート前は順位なし');
  const est = RT.perf.estimate(c);
  const win = fin.length ? Math.min.apply(null, fin) : NaN, last = fin.length ? Math.max.apply(null, fin) : NaN;
  ok(Math.abs(win - est) / est < 0.25, label + ': 所要時間の目安と先頭艇の差が25%以内');
  console.log('  ' + label + ': 先頭 ' + G.fmtClock(win) + ' / 最後尾 ' + G.fmtClock(last) + ' / 目安 ' + G.fmtClock(est) + ' / 記録 ' + sim.n + '点');
}
checkRace('初期設定', {});
checkRace('北風・1周', { windMag: 5, laps: 1 });
checkRace('東風・3周・微風', { windMag: 95, laps: 3, windKn: 6 });
checkRace('北西風・強風', { windMag: 320, windKn: 16 });
checkRace('長いコース', { d14: 1000, startLen: 150, finLen: 70 });
checkRace('短いコース', { d14: 400, startLen: 80, finLen: 40 });
checkRace('別の乱数', {}, null, 2024);
checkRace('マークを動かした場合', {}, c => ({
  m1: c.latLon(G.offset(c.targets.m1, c.windTrue + 70, 60)),
  m4: c.latLon(G.offset(c.targets.m4, c.windTrue - 120, 25)),
  fin: c.latLon(G.offset(c.targets.fin, c.windTrue + 180, 12))
}));

// ---- 3. コース取りの分析 ----
console.log('3. コース取りの分析');
/* 正解のタック回数。シミュレーションの「誤差なしの船首方位」と「その瞬間の風向」から数える。
 * 分析側は GPS 誤差つきの位置と固定の風軸しか使わないので、両者が合うかを確かめる。
 * 船首が風位を越えても、5秒以内に元の側へ戻った場合（ラフしただけ）はタックに数えない。 */
function truthTacks(sim, i, t0, t1) {
  const b = sim.boats[i], HOLD = 5;
  const k1 = Math.floor(t1 - sim.t0), kEnd = Math.min(b.hdg.length - 1, k1 + HOLD + 2);
  let n = 0, state = 0, held = 0, candK = -1;
  for (let k = Math.ceil(t0 - sim.t0); k <= kEnd; k++) {
    const rel = G.norm180(b.hdg[k] - sim.windAt(sim.t0 + k));
    const s = rel < 0 ? -1 : 1;
    if (state === 0) { state = s; continue; }
    if (s === state) { held = 0; continue; }
    if (held === 0) candK = k;
    held++;
    if (held >= HOLD) { if (candK <= k1 && Math.abs(rel) < 150) n++; state = s; held = 0; }
  }
  return n;
}
let tackTotal = 0, tackExact = 0, tackWorst = 0;
function checkAnalysis(label, params, seed) {
  const p = Object.assign({}, RT.course.DEFAULTS, params);
  const c = RT.course.build(p, {});
  const sim = RT.sim.run(c, { n: 12, seed: seed || 11 });
  const gates = RT.race.gates(c);
  const ev = RT.race.analyze(gates, sim.boats);
  const defs = RT.analysis.legs(gates);
  const st = RT.analysis.all(gates, sim.boats, ev);
  let exact = 0, total = 0;
  st.forEach((legsOf, i) => {
    let sumT = 0;
    for (let j = 1; j < gates.length; j++) {
      const s = legsOf[j], d = defs[j];
      ok(s !== null, label + ': 艇' + i + ' ' + (d && d.name) + ' の集計がある');
      if (!s) continue;
      sumT += s.time;
      ok(s.latMin <= s.latMean && s.latMean <= s.latMax, label + ': 左右の最小・平均・最大の順序');
      ok(s.rightShare >= 0 && s.rightShare <= 1, label + ': 右側にいた割合が0〜1');
      ok(s.dist >= d.len * 0.9, label + ': 艇' + i + ' ' + d.name + ' の帆走距離がレグ長より短すぎない (' + s.dist.toFixed(0) + '/' + d.len.toFixed(0) + ')');
      if (d.kind === 'beat') {
        ok(s.dist >= d.len * 1.15, label + ': 艇' + i + ' ' + d.name + ' の帆走距離はタックの分だけ長い (' + s.dist.toFixed(0) + '/' + d.len.toFixed(0) + ')');
        const truth = truthTacks(sim, i, ev[i][j - 1], ev[i][j]);
        total++; tackTotal++;
        if (truth === s.tacks) { exact++; tackExact++; }
        tackWorst = Math.max(tackWorst, Math.abs(truth - s.tacks));
        ok(Math.abs(truth - s.tacks) <= 1, label + ': 艇' + i + ' ' + d.name + ' のタック回数 (検出 ' + s.tacks + ' / 正解 ' + truth + ')');
      } else {
        ok(s.tacks === null, label + ': 上り以外ではタックを数えない');
      }
    }
    near(sumT, ev[i][gates.length - 1] - ev[i][0], 0.01, label + ': レグ時間の合計がレース時間に一致');
  });
  console.log('  ' + label + ': タック回数の一致 ' + exact + '/' + total + ' レグ');
}
checkAnalysis('初期設定', {});
checkAnalysis('北風・1周', { windMag: 5, laps: 1 });
checkAnalysis('東風・3周・微風', { windMag: 95, laps: 3, windKn: 6 });
checkAnalysis('北西風・強風', { windMag: 320, windKn: 16 });
checkAnalysis('長いコース', { d14: 1000, startLen: 150, finLen: 70 });
checkAnalysis('別の乱数', {}, 2024);
ok(tackExact / tackTotal >= 0.9, 'タック回数が正解と完全一致するレグが9割以上 (' + tackExact + '/' + tackTotal + ')');
console.log('  合計: 一致 ' + tackExact + '/' + tackTotal + '、最大のずれ ' + tackWorst + ' 回');

// ---- 4. スタートの分析 ----
console.log('4. スタートの分析');
/* シミュレーションは「どの艇が、いつ、ラインのどこを切ったか」を知っている。
 * 分析側が GPS 誤差つきの位置から出した値が、それと合うかを確かめる。 */
function checkStart(label, params, seed) {
  const p = Object.assign({}, RT.course.DEFAULTS, params);
  const c = RT.course.build(p, {});
  const sim = RT.sim.run(c, { n: 12, seed: seed || 11 });
  const gates = RT.race.gates(c);
  const ev = RT.race.analyze(gates, sim.boats);
  const st = RT.analysis.all(gates, sim.boats, ev);
  let maxT = 0, maxPos = 0;
  sim.boats.forEach((b, i) => {
    const s = st[i][0];
    ok(s !== null, label + ': 艇' + i + ' のスタート分析がある');
    if (!s) return;
    maxT = Math.max(maxT, Math.abs(s.time - b.truth.startTime));
    maxPos = Math.max(maxPos, Math.abs(s.fromCb - b.truth.startFromCb));
    near(s.time, b.truth.startTime, 2.5, label + ': 艇' + i + ' のライン通過時刻');
    near(s.fromCb, b.truth.startFromCb, 6, label + ': 艇' + i + ' のラインを切った位置');
    near(s.speed, b.truth.startSpeed, 0.5, label + ': 艇' + i + ' のスタート時の艇速');
    ok(s.tack === 'スターボード', label + ': 艇' + i + ' はスターボードタックでスタート');
    ok(s.frac > -0.1 && s.frac < 1.1, label + ': 切った位置がラインの範囲内');
    ok(s.gapAtGun > -4 && s.gapAtGun < 25, label + ': 艇' + i + ' の信号時の距離が妥当 (' + s.gapAtGun.toFixed(1) + 'm)');
  });
  near(RT.analysis.lineBias(c), 0, 0.01, label + ': 設計どおりのラインは有利不利なし');
  console.log('  ' + label + ': 時刻の最大ずれ ' + maxT.toFixed(1) + '秒 / 位置の最大ずれ ' + maxPos.toFixed(1) + 'm');
}
checkStart('初期設定', {});
checkStart('東風・微風', { windMag: 95, windKn: 6 });
checkStart('長いライン', { startLen: 180, windMag: 300, windKn: 14 }, 5);
{
  const p = Object.assign({}, RT.course.DEFAULTS);
  const c0 = RT.course.build(p, {});
  const c = RT.course.build(p, { m4: c0.latLon(G.offset(c0.targets.m4, c0.windTrue, 10)) });
  near(RT.analysis.lineBias(c), 10, 0.05, '下マークを10m風上に打つと、下マーク側が10m有利');
}

// ---- 5. 航跡ファイルの読み込み ----
console.log('5. 航跡ファイルの読み込み');
{
  const p = Object.assign({}, RT.course.DEFAULTS);
  const c = RT.course.build(p, {});
  const T = 1794000000000;   // 適当な基準時刻
  /* 本部船の位置から、真東へ秒速2mで進む模擬の記録を作る。
   * 途中に20秒の空白、最後は止まって10秒に1点、精度の悪い外れ値を1点まぜる。 */
  function makeFile(sail, name, offsetSec) {
    const fixes = [];
    const at = sec => c.latLon({ x: 2 * Math.min(sec, 100), y: 0 });
    for (let s = 0; s <= 100; s++) {
      if (s > 40 && s < 60) continue;                       // 20秒の空白（その間も進んでいる）
      const q = at(s);
      fixes.push([T + (offsetSec + s) * 1000, q.lat, q.lon, 5, 2, 90]);
    }
    for (let s = 110; s <= 160; s += 10) { const q = at(s); fixes.push([T + (offsetSec + s) * 1000, q.lat, q.lon, 4, null, null]); }
    const bad = c.latLon({ x: 60, y: 500 });
    fixes.push([T + (offsetSec + 30) * 1000 + 500, bad.lat, bad.lon, 150, null, null]);   // 外れ値
    return JSON.stringify({ format: 'yacht-track', version: 1, sail: sail, name: name, started: new Date(T).toISOString(), fixes: fixes, log: [] });
  }
  const trA = RT.importer.parse(makeFile('111111', 'A艇', 0), 'a.json');
  const trB = RT.importer.parse(makeFile('222222', 'B艇', 30), 'b.json');
  ok(trA.sail === '111111' && trA.name === 'A艇', 'セール番号と名前を読み取る');
  ok(trA.dropped === 1, '精度の悪い点を1点捨てる (' + trA.dropped + ')');
  near(trA.medAcc, 5, 0.01, '精度の中央値');
  const startMs = T + 10000;   // スタート信号は記録開始の10秒後とする
  const data = RT.importer.build([trA, trB], c, startMs);
  ok(data.t0 === -10, '時間の原点はスタート信号 (t0=' + data.t0 + ')');
  ok(data.tEnd === 180, '最後の記録まで含む (tEnd=' + data.tEnd + ')');
  ok(data.boats.length === 2 && data.boats[0].x.length === data.n, '艇の数と配列の長さ');
  const A = data.boats[0], B = data.boats[1];
  const idx = t => t - data.t0;
  near(A.x[idx(20)], 60, 0.5, 'スタート20秒後の位置（東へ60m）');
  near(A.y[idx(20)], 0, 0.5, '外れ値に引っぱられていない');
  near(A.spd[idx(20)], 2, 0.05, '艇速（秒速2m）');
  near(A.hdg[idx(20)], 90, 1, '針路（東）');
  near(A.x[idx(40)], 100, 0.5, '空白の間は前後の点をまっすぐつなぐ');
  near(A.spd[idx(40)], 2, 0.05, '空白の間の艇速');
  near(A.spd[idx(130)], 0, 0.05, '止まっている間の艇速は0');
  near(A.hdg[idx(130)], 90, 1, '止まっている間は直前の針路を保つ');
  let jump = 0;
  for (let k = 1; k < data.n; k++) jump = Math.max(jump, Math.hypot(A.x[k] - A.x[k - 1], A.y[k] - A.y[k - 1]));
  ok(jump < 2.5, '位置が不自然に飛ばない (最大 ' + jump.toFixed(2) + 'm/秒)');
  ok(A.from === 0 && A.to === idx(150), 'A艇の記録がある範囲');
  ok(B.from === idx(20) && B.to === idx(180), 'B艇の記録がある範囲（30秒遅れで開始）');
  near(B.x[idx(0)], 0, 0.5, '記録が始まる前は最初の位置で止めておく');
  near(B.hdg[idx(0)], 90, 1, '動き出す前の針路は、最初に動いた向き');
  // 回航判定や分析に渡しても落ちない
  const gates = RT.race.gates(c);
  const ev = RT.race.analyze(gates, data.boats);
  const st = RT.analysis.all(gates, data.boats, ev);
  ok(ev.length === 2 && st.length === 2, '読み込んだ航跡を回航判定と分析に渡せる');
  const rows = RT.race.standings(gates, ev, 50, (i, t) => ({ x: data.boats[i].x[idx(Math.round(t))], y: data.boats[i].y[idx(Math.round(t))] }));
  ok(rows.length === 2, '順位表を作れる');
  // 形式の違うファイルは理由つきで断る
  const throws = fn => { try { fn(); return ''; } catch (e) { return e.message; } };
  ok(throws(() => RT.importer.parse('これはJSONではない')) !== '', 'JSON でないファイルを断る');
  ok(throws(() => RT.importer.parse('{"format":"other","fixes":[]}')) !== '', '別の形式のファイルを断る');
  ok(throws(() => RT.importer.parse('{"format":"yacht-track","fixes":[[1,35,135,5]]}')) !== '', '点が足りないファイルを断る');
  ok(throws(() => RT.importer.build([trA], c, startMs - 13 * 3600 * 1000)) === '', 'スタート時刻が離れていても記録の幅で判定する');
  const far = RT.importer.parse(makeFile('333333', 'C艇', 13 * 3600), 'c.json');
  ok(throws(() => RT.importer.build([trA, far], c, startMs)) !== '', '時間幅が長すぎる組み合わせを断る');
  console.log('  模擬ファイル2艇: ' + data.n + '秒分に並べ直し');
}

// ---- 6. 運営艇の記録から、コースとスタート時刻を復元する ----
console.log('6. 運営艇の記録からの復元');
{
  /* シミュレーションのレースを「スマホの記録ファイル」の形に書き出し、読み込み直す。
   * 運営艇の記録（マークを打った位置・スタート信号）だけを手がかりにコースを組み立てて、
   * 元のレースと同じ回航時刻が出れば、記録 → 読み込み → 判定の流れが通っている。 */
  const p = Object.assign({}, RT.course.DEFAULTS, { windMag: 235, d14: 550, startLen: 120 });
  const c = RT.course.build(p, {});
  const sim = RT.sim.run(c, { n: 5, seed: 3 });
  const gates = RT.race.gates(c);
  const evTruth = RT.race.analyze(gates, sim.boats);
  const T = 1794000000000;                       // スタート信号（sim の t=0）にあたる時刻
  const tms = k => T + (sim.t0 + k) * 1000;
  const iso = new Date(tms(0)).toISOString();
  const files = sim.boats.map((b, i) => {
    const fixes = [];
    for (let k = 0; k < sim.n; k++) { const q = c.latLon({ x: b.x[k], y: b.y[k] }); fixes.push([tms(k), q.lat, q.lon, 5, b.spd[k], b.hdg[k]]); }
    return JSON.stringify({ format: 'yacht-track', version: 1, sail: String(100 + i), name: '艇' + i, started: iso, fixes: fixes, ops: false, marks: [], log: [] });
  });
  const cb = c.latLon(c.cb), m1 = c.latLon(c.marks.m1), m4 = c.latLon(c.marks.m4), fin = c.latLon(c.marks.fin);
  const wrong = c.latLon(G.offset(c.marks.m1, 90, 80));
  const opsFixes = [];
  for (let s = -1500; s <= sim.tEnd + 60; s += 5) opsFixes.push([T + s * 1000, cb.lat, cb.lon, 4, 0, null]);
  const marks = [
    [T - 1400000, 'm1', wrong.lat, wrong.lon, 5, 300],        // 打ち直す前の上マーク
    [T - 1200000, 'm1', m1.lat, m1.lon, 5, 300],
    [T - 900000, 'm4', m4.lat, m4.lon, 5, 300],
    [T - 700000, 'fin', fin.lat, fin.lon, 5, 300],
    [T - 600000, 'start', cb.lat, cb.lon, 4, 200],            // ゼネラルリコールになったスタート
    [T - 590000, 'start-cancel', null, null, null, null],
    [T, 'start', cb.lat, cb.lon, 4, 200]
  ];
  const opsFile = JSON.stringify({ format: 'yacht-track', version: 1, sail: 'RC', name: '本部船', started: iso, fixes: opsFixes, ops: true, marks: marks, log: [] });
  const tracks = files.map((f, i) => RT.importer.parse(f, 'b' + i + '.json')).concat([RT.importer.parse(opsFile, 'ops.json')]);
  ok(tracks[5].ops && !tracks[0].ops, '運営艇の記録と選手の記録を見分ける');
  ok(tracks[5].marks.length === 7, '運営艇の記録を読み取る');
  const st = RT.importer.starts(tracks);
  ok(st.length === 1 && st[0] === T, '取り消したスタートは数えない (' + st.length + '件)');
  const oc = RT.importer.opsCourse(tracks, st[0]);
  ok(oc && oc.found.m1 && oc.found.m4 && oc.found.fin, 'マーク3個の位置を取り出す');
  ok(RT.importer.opsCourse(tracks.slice(0, 5), st[0]) === null, '運営艇の記録が無ければ何もしない');
  // わざと「いつもの設定」（別の場所・別の風軸）から始めて、運営艇の記録で上書きする
  const c2 = RT.course.build(Object.assign({}, RT.course.DEFAULTS, oc.relocate), oc.overrides);
  const back = (pt) => { const q = c2.latLon(pt); return c.proj.toXY(q.lat, q.lon); };
  near(G.dist(back(c2.cb), c.cb), 0, 0.5, '本部船の位置');
  near(G.dist(back(c2.marks.m1), c.marks.m1), 0, 0.5, '上マークは打ち直した後の位置');
  near(G.dist(back(c2.marks.m4), c.marks.m4), 0, 0.5, '下マークの位置');
  near(G.dist(back(c2.marks.fin), c.marks.fin), 0, 0.5, 'フィニッシュマークの位置');
  near(G.norm180(oc.relocate.windMag - p.windMag), 0, 1, '風軸を上下マークの向きから求める');
  const data = RT.importer.build(tracks.filter(tr => !tr.ops), c2, st[0]);
  ok(data.boats.length === 5 && data.t0 === sim.t0, '選手5艇を、スタート時刻を基準に並べ直す');
  const gates2 = RT.race.gates(c2);
  const ev2 = RT.race.analyze(gates2, data.boats);
  let worst = 0;
  ev2.forEach((e, i) => {
    ok(e.length === gates2.length, '艇' + i + ' の全ゲート通過を再現 (' + e.length + '/' + gates2.length + ')');
    for (let j = 0; j < Math.min(e.length, evTruth[i].length); j++) worst = Math.max(worst, Math.abs(e[j] - evTruth[i][j]));
  });
  ok(worst < 1, '回航時刻が元のレースと一致 (最大のずれ ' + worst.toFixed(2) + '秒)');
  // 2レース目: マークを打ち直してからスタートした場合は、新しい位置を使う
  const m1b = c.latLon(G.offset(c.marks.m1, 0, 100));
  const marks2 = marks.concat([[T + 2400000, 'm1', m1b.lat, m1b.lon, 5, 300], [T + 3000000, 'start', cb.lat, cb.lon, 4, 200]]);
  const ops2 = RT.importer.parse(JSON.stringify({ format: 'yacht-track', version: 1, sail: 'RC', name: '本部船', started: iso, fixes: opsFixes, ops: true, marks: marks2, log: [] }));
  const st2 = RT.importer.starts([ops2]);
  ok(st2.length === 2, '1日に2レースあればスタートが2件');
  const r1 = RT.importer.opsCourse([ops2], st2[0]), r2 = RT.importer.opsCourse([ops2], st2[1]);
  near(r1.overrides.m1.lat, m1.lat, 1e-9, '1レース目は当時の上マーク');
  near(r2.overrides.m1.lat, m1b.lat, 1e-9, '2レース目は打ち直した上マーク');
  // スタート信号を押した位置が無いときは、その時刻の運営艇の位置を本部船とする
  const ops3 = RT.importer.parse(JSON.stringify({ format: 'yacht-track', version: 1, sail: 'RC', name: '本部船', started: iso, fixes: opsFixes, ops: true, marks: [[T, 'start', null, null, null, null]], log: [] }));
  const r3 = RT.importer.opsCourse([ops3], T);
  near(r3.relocate.lat, cb.lat, 1e-9, '位置なしのスタートは、運営艇の航跡から本部船の位置を出す');
  console.log('  5艇のレースを記録ファイル経由で再現: 回航時刻の最大のずれ ' + worst.toFixed(2) + '秒');
}

console.log('\n' + (failed ? 'NG ' + failed + ' 件 / ' : '') + 'OK ' + passed + ' 件');
process.exit(failed ? 1 : 0);
