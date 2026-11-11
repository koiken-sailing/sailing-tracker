/* 計算部分の自動テスト。実行: node tools/test.js */
'use strict';
const path = require('path');
['geo', 'course', 'sim', 'race', 'analysis', 'importer', 'config', 'cloud'].forEach(f => require(path.join(__dirname, '..', 'js', f + '.js')));
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

// ---- 7. 記録の送信（詰め方・公開する範囲・送り先とのやりとり） ----
console.log('7. 記録の送信');
const C = RT.cloud;
const SQUARE = [[34.70, 135.30], [34.70, 135.35], [34.66, 135.35], [34.66, 135.30]];
{
  // 設定ファイルに、秘密にすべきものや実在の送り先が紛れ込んでいないこと
  ok(Array.isArray(RT.config.area) && RT.config.area.length >= 3, '公開する範囲が設定されている');
  ok(!/pass|secret|private|合言葉/i.test(Object.keys(RT.config.cloud).join(',')), '設定ファイルに合言葉や秘密鍵の欄がない');

  RT.config.area = SQUARE;
  ok(C.inArea(34.68, 135.32), '範囲の中');
  ok(!C.inArea(34.72, 135.32) && !C.inArea(34.68, 135.36), '範囲の外');
  const saved = RT.config.area;
  RT.config.area = null;
  ok(!C.inArea(34.68, 135.32), '範囲が未設定なら、どこも公開しない');
  RT.config.area = saved;

  // 位置の列を詰めて戻す
  const T = 1794300000000;
  const fixes = [];
  let lat = 34.69, lon = 135.31, t = T;
  for (let i = 0; i < 5000; i++) {
    t += i % 97 === 0 ? 10432 : 1000 + (i % 7) * 3;       // ときどき10秒空く
    lat += Math.sin(i / 40) * 0.00002; lon += Math.cos(i / 55) * 0.00003;
    fixes.push([t, Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6, i % 211 === 0 ? null : 4 + (i % 9) * 1.3]);
  }
  const enc = C.encodeFixes(fixes), dec = C.decodeFixes(enc);
  ok(dec.length === fixes.length, '点数が変わらない');
  let dT = 0, dP = 0, accOk = true;
  dec.forEach((f, i) => {
    dT = Math.max(dT, Math.abs(f[0] - fixes[i][0]));
    dP = Math.max(dP, Math.abs(f[1] - fixes[i][1]), Math.abs(f[2] - fixes[i][2]));
    if (fixes[i][3] === null ? f[3] !== null : Math.abs(f[3] - fixes[i][3]) > 0.5) accOk = false;
  });
  ok(dT <= 50, '時刻のずれは0.05秒以内 (' + dT + 'ms)');
  ok(dP < 1e-9, '位置は変わらない');
  ok(accOk, '精度は1m単位で保たれる（不明は不明のまま）');
  ok(enc.length / fixes.length < 8, '1点あたり8文字未満 (' + (enc.length / fixes.length).toFixed(1) + '文字)');
  ok(/^[A-Za-z0-9_-]+$/.test(enc), '使う文字は英数字と - _ だけ');
  let threw = false;
  try { C.decodeFixes(enc.slice(0, -1) + '!'); } catch (e) { threw = true; }
  ok(threw, '壊れた文字列は読み取りを断る');

  // 範囲の外（陸の上）の位置は、送る中身に入らない
  const land = [];
  for (let i = 0; i < 300; i++) land.push([T - 400000 + i * 1000, 34.74 + i * 1e-5, 135.33, 8, null, null]);
  const after = [];
  for (let i = 0; i < 200; i++) after.push([t + 1000 + i * 1000, 34.72 + i * 1e-5, 135.36, 8, null, null]);
  const file = {
    format: 'yacht-track', version: 1, sail: ' 211034 ', name: 'さとう\u0007', ops: true,
    fixes: land.concat(fixes.map(f => [f[0], f[1], f[2], f[3], 1.5, 90]), after),
    marks: [[T + 60000, 'm1', 34.69, 135.32, 5, 100], [T + 90000, 'm4', 34.75, 135.32, 5, 100],
      [T + 120000, 'start', 34.685, 135.32, 5, 100], [T + 130000, 'bogus', 34.685, 135.32, 5, 100]],
    log: [[T, 'start', '']], device: 'test'
  };
  const packed = C.pack(file);
  ok(packed && packed.rec.n === fixes.length, '範囲の中の点だけを送る');
  ok(packed.outside === 500, '範囲の外だった点数を数える');
  ok(packed.rec.first === fixes[0][0] && packed.rec.last === fixes[fixes.length - 1][0], '最初と最後の時刻は範囲の中のもの');
  ok(packed.rec.sail === '211034' && packed.rec.nick === 'さとう', 'セール番号とニックネームは余分な空白や制御文字を除く');
  ok(Object.keys(packed.rec).sort().join() === 'f,first,last,m,n,nick,ops,sail,v', '送るのは決めた項目だけ（端末の情報や操作の記録は送らない）');
  const back = C.unpack(packed.rec);
  ok(back.fixes.every(f => C.inArea(f[1], f[2])), '戻した記録に範囲の外の位置がない');
  ok(back.marks.length === 3, '知らない種類の記録は捨てる');
  ok(back.marks[1][2] === null && back.marks[1][3] === null, '範囲の外で打ったマークの位置は送らない');
  const parsed = RT.importer.parse(JSON.stringify(back), 'cloud');
  ok(parsed.ops && parsed.fixes.length === fixes.length && RT.importer.starts([parsed]).length === 1, '戻した記録を、ファイルと同じ手順で読める');
  ok(C.pack({ sail: '1', name: 'a', fixes: land, marks: [] }) === null, '範囲の中に記録が無ければ、何も送らない');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(packed.day), '日付の形');
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(C.newId());
  ok(ids.size === 200 && [...ids].every(id => /^[A-Za-z0-9]{12}$/.test(id)), '記録IDは重ならない英数字12文字');
}

// ---- 8. 1日に複数レースある日（周回数の記録と、レースの区切り） ----
console.log('8. 1日に複数レース');
{
  /* 第1レースは1周、第2レースは2周。艇3は第1レースを上マークのあとでやめ、第2レースには出る。
   * 艇4は第2レースからの参加。記録は1日を通して1本で、送信（詰める → 戻す）を通してから読み込む。 */
  const base = Object.assign({}, RT.course.DEFAULTS, { lat: 34.685, lon: 135.32, windMag: 200, d14: 500 });
  const cA = RT.course.build(Object.assign({}, base, { laps: 1 }), {});
  const cB = RT.course.build(Object.assign({}, base, { laps: 2 }), {});
  const simA = RT.sim.run(cA, { n: 4, seed: 5 }), simB = RT.sim.run(cB, { n: 5, seed: 8 });
  const gA = RT.race.gates(cA), gB = RT.race.gates(cB);
  const evA = RT.race.analyze(gA, simA.boats), evB = RT.race.analyze(gB, simB.boats);
  const T1 = new Date(2026, 10, 15, 10, 0, 0).getTime();
  const T2 = T1 + (simA.tEnd + 900) * 1000;
  const fixesOf = (c, sim, b, T, kMax) => {
    const out = [];
    for (let k = 0; k < Math.min(sim.n, kMax === undefined ? Infinity : kMax); k++) {
      const q = c.latLon({ x: b.x[k], y: b.y[k] });
      out.push([T + (sim.t0 + k) * 1000, q.lat, q.lon, 5, b.spd[k], b.hdg[k]]);
    }
    return out;
  };
  const viaCloud = file => RT.importer.parse(JSON.stringify(C.unpack(C.pack(file).rec)), file.sail);
  const quitAt = Math.ceil(evA[3][1] - simA.t0) + 30;      // 艇3: 上マークを回って30秒後に記録が途切れる
  const racers = [0, 1, 2, 3, 4].map(i => {
    const first = i === 4 ? [] : fixesOf(cA, simA, simA.boats[i], T1, i === 3 ? quitAt : undefined);
    return viaCloud({ sail: String(200 + i), name: '艇' + i, ops: false, marks: [], fixes: first.concat(fixesOf(cB, simB, simB.boats[i], T2)) });
  });
  const cb = cA.latLon(cA.cb), m1 = cA.latLon(cA.marks.m1), m4 = cA.latLon(cA.marks.m4), fin = cA.latLon(cA.marks.fin);
  const opsFixes = [];
  for (let ms = T1 - 1500000; ms <= T2 + (simB.tEnd + 60) * 1000; ms += 5000) opsFixes.push([ms, cb.lat, cb.lon, 4, 0, null]);
  const ops = viaCloud({
    sail: 'RC', name: '本部船', ops: true, fixes: opsFixes,
    marks: [
      [T1 - 1200000, 'm1', m1.lat, m1.lon, 5, 300], [T1 - 900000, 'm4', m4.lat, m4.lon, 5, 300], [T1 - 700000, 'fin', fin.lat, fin.lon, 5, 300],
      [T1, 'start', cb.lat, cb.lon, 4, 200, 1],
      [T2 - 400000, 'start', cb.lat, cb.lon, 4, 200, 2], [T2 - 390000, 'start-cancel', null, null, null, null],
      [T2, 'start', cb.lat, cb.lon, 4, 200, 2]
    ]
  });
  const all = racers.concat([ops]);
  const st = RT.importer.starts(all);
  ok(st.length === 2 && st[0] === T1 && st[1] === T2, 'スタートが2件（取り消した1件は数えない）');
  ok(RT.importer.lapsAt(all, T1) === 1 && RT.importer.lapsAt(all, T2) === 2, '周回数が、送信を通してもスタートごとに残る');
  ok(RT.importer.lapsAt(racers, T1) === null, '周回数の記録が無ければ null（画面の設定を使う）');
  const oc1 = RT.importer.opsCourse(all, T1), oc2 = RT.importer.opsCourse(all, T2);
  ok(oc1.relocate.laps === 1 && oc2.relocate.laps === 2, 'コースの周回数は、選んだレースのもの');

  const w1 = RT.importer.raceWindow(st, T1), w2 = RT.importer.raceWindow(st, T2);
  ok(w1.fromMs === T1 - 360000 && w1.toMs === T2 - 360000, '第1レースの時間帯は、次のスタートの6分前まで');
  ok(w2.fromMs === T2 - 360000 && w2.toMs === Infinity, '最後のレースの時間帯は、記録の最後まで');
  ok(RT.importer.raceWindow(st, T1 + 5000) === null, '手で合わせたスタート時刻のときは、時間帯を区切らない');

  const course1 = RT.course.build(Object.assign({}, RT.course.DEFAULTS, oc1.relocate), oc1.overrides);
  const course2 = RT.course.build(Object.assign({}, RT.course.DEFAULTS, oc2.relocate), oc2.overrides);
  const gates1 = RT.race.gates(course1), gates2 = RT.race.gates(course2);
  ok(gates1.length === gA.length && gates2.length === gB.length, 'ゲートの数が周回数に合う (' + gates1.length + ' / ' + gates2.length + ')');

  // 第1レース
  const d1 = RT.importer.build(racers, course1, T1, w1);
  ok(d1.t0 === -360 && d1.tEnd === (T2 - 360000 - T1) / 1000, '第1レースの時間のバーは、そのレースの間だけ');
  const e1 = RT.race.analyze(gates1, d1.boats);
  let worst1 = 0;
  [0, 1, 2].forEach(i => {
    ok(e1[i].length === gates1.length, '第1レース 艇' + i + ' はフィニッシュ');
    for (let j = 0; j < Math.min(e1[i].length, evA[i].length); j++) worst1 = Math.max(worst1, Math.abs(e1[i][j] - evA[i][j]));
  });
  ok(worst1 < 1, '第1レースの回航時刻が元のレースと一致 (最大のずれ ' + worst1.toFixed(2) + '秒)');
  ok(e1[3].length === 2, '途中でやめた艇3は、上マークまで（' + e1[3].length + 'ゲート）。次のレースの動きを数えない');
  ok(d1.boats[4].none === true && e1[4].length === 0, '第2レースから出た艇4は、第1レースには記録なし');
  const loose = RT.race.analyze(gates1, RT.importer.build(racers, course1, T1).boats);
  console.log('  区切らない場合、艇3は ' + loose[3].length + ' ゲート通過と数えられ、艇4は ' + loose[4].length + ' ゲート（どちらも第2レースでの動き）');

  // 第2レース
  const d2 = RT.importer.build(racers, course2, T2, w2);
  ok(d2.t0 === -360, '第2レースは、そのスタートの6分前から');
  const e2 = RT.race.analyze(gates2, d2.boats);
  let worst2 = 0;
  e2.forEach((e, i) => {
    ok(e.length === gates2.length, '第2レース 艇' + i + ' は2周してフィニッシュ (' + e.length + '/' + gates2.length + ')');
    for (let j = 0; j < Math.min(e.length, evB[i].length); j++) worst2 = Math.max(worst2, Math.abs(e[j] - evB[i][j]));
  });
  ok(worst2 < 1, '第2レースの回航時刻が元のレースと一致 (最大のずれ ' + worst2.toFixed(2) + '秒)');
  ok(d2.boats.every(b => !b.none), '第2レースは全艇に記録がある');

  let threw = false;
  try { RT.importer.build(racers, course1, T1, { fromMs: T1 - 9e7, toMs: T1 - 8e7 }); } catch (e) { threw = true; }
  ok(threw, '記録のない時間帯を選んだら、理由を付けて断る');
}

// ---- 9. マーク練習（選手が自分でマークを打つ）と、陸上テスト用の送信 ----
console.log('9. マーク練習と陸上テスト');
{
  const p = Object.assign({}, RT.course.DEFAULTS, { lat: 34.685, lon: 135.32, windMag: 200, d14: 400 });
  const c = RT.course.build(p, {});
  const m1 = c.latLon(c.marks.m1), m4 = c.latLon(c.marks.m4), old = c.latLon(G.offset(c.marks.m1, 90, 150));
  const T = new Date(2026, 10, 20, 13, 0, 0).getTime();
  const fixes = [];
  for (let i = 0; i < 900; i++) { const q = c.latLon(G.offset(c.marks.m4, 200 + i * 0.4, 30 + (i % 300))); fixes.push([T + i * 1000, q.lat, q.lon, 5, 2, 0]); }
  const file = { format: 'yacht-track', version: 1, sail: '300', name: 'れんしゅう', ops: false, practice: true, fixes,
    marks: [[T + 60000, 'm1', old.lat, old.lon, 5, 100], [T + 120000, 'm4', m4.lat, m4.lon, 5, 100], [T + 300000, 'm1', m1.lat, m1.lon, 5, 100]] };
  const tr = RT.importer.parse(JSON.stringify(C.unpack(C.pack(file).rec)), 'p');
  const other = RT.importer.parse(JSON.stringify({ format: 'yacht-track', version: 1, sail: '301', name: 'ほか', ops: false, marks: [], fixes }), 'o');
  ok(tr.ops === false && tr.marks.length === 3, 'マークを打った選手は、運営艇ではなく選手として扱う');
  ok(RT.importer.starts([tr, other]).length === 0, 'マーク練習にはスタートの記録が無い');
  const pc = RT.importer.practiceCourse([other, tr], 10);
  ok(pc && pc.found.m1 && pc.found.m4 && !pc.found.fin, '上マークと下マークを取り出す（フィニッシュマークは無い）');
  const c2 = RT.course.build(Object.assign({}, RT.course.DEFAULTS, pc.relocate), pc.overrides);
  const back = pt => { const q = c2.latLon(pt); return c.proj.toXY(q.lat, q.lon); };
  near(G.dist(back(c2.marks.m1), c.marks.m1), 0, 0.5, '上マークは、最後に打った位置');
  near(G.dist(back(c2.marks.m4), c.marks.m4), 0, 0.5, '下マークの位置');
  near(G.norm180(pc.relocate.windMag - p.windMag), 0, 1, '風軸は、下マークから上マークを見た向き');
  near(G.dist(back(c2.cb), c.marks.m4), 100, 1, '本部船は下マークの横に仮置き（表示はしない）');
  ok(isFinite(c2.marks.fin.x) && RT.race.gates(c2).length > 0, '仮置きでもコースの計算が壊れない');
  const one = RT.importer.parse(JSON.stringify(Object.assign({}, file, { marks: [[T + 60000, 'm1', m1.lat, m1.lon, 5, 100]] })), 'one');
  const pc1 = RT.importer.practiceCourse([one], 135);
  ok(pc1 && pc1.found.m1 && !pc1.found.m4 && pc1.relocate.windMag === 135, 'マークが1個だけなら、風軸は画面の設定を使う');
  ok(RT.importer.practiceCourse([other], 10) === null, 'マークの記録が無ければ、マーク練習として扱わない');

  // 陸上テスト用の入口から始めた記録だけ、範囲の外でも送る
  const land = [];
  for (let i = 0; i < 100; i++) land.push([T + i * 1000, 35.0 + i * 1e-5, 135.9, 8, null, null]);
  const landFile = { sail: '1', name: 'りく', fixes: land, marks: [[T + 5000, 'm1', 35.0, 135.9, 5, 100]] };
  ok(C.pack(landFile) === null, 'ふつうの入口では、陸の上の記録は送らない');
  const lp = C.pack(landFile, { anywhere: true });
  ok(lp && lp.rec.n === 100 && lp.outside === 0, '陸上テスト用の入口では、範囲の外でも送る');
  ok(C.unpack(lp.rec).marks[0][2] === 35.0, '陸上テストでは、マークの位置も送る');
}

// 模擬の送り先を立てて、登録 → 送信 → 一覧 → 読み込み を通す
async function cloudRoundTrip() {
  const PORT = 5199, PASS = 'umi-no-aikotoba';
  const server = await require('./mock-cloud.js').start(PORT, PASS);
  const base = 'http://127.0.0.1:' + PORT;
  const stores = {};
  function useDevice(name) {     // 端末ごとに、ブラウザの保存領域の代わりを用意する
    const m = stores[name] = stores[name] || new Map();
    globalThis.localStorage = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
  }
  const realConf = RT.config.cloud;
  ok(!C.enabled() || !!realConf.databaseURL, '送り先が空のあいだは、送信の機能が無効');
  RT.config.cloud = { databaseURL: base, apiKey: 'test', authURL: base, tokenURL: base };
  RT.config.area = SQUARE;
  try {
    ok(C.enabled(), '送り先を設定すると有効になる');
    const T = new Date(2026, 10, 15, 10, 0, 0).getTime();
    const mk = (sail, nick, dx) => {
      const fixes = [];
      for (let i = 0; i < 600; i++) fixes.push([T + i * 1000, 34.68 + i * 2e-5, 135.32 + dx + i * 1e-5, 5, null, null]);
      return C.pack({ sail, name: nick, fixes, marks: [] });
    };

    useDevice('A');
    ok(!C.joined(), '最初は未登録');
    let code = '';
    try { await C.upload('recA', mk('1001', 'あお', 0)); } catch (e) { code = e.code; }
    ok(code === 'passcode', '合言葉を登録していない端末は書き込めない');
    code = '';
    try { await C.join('chigau'); } catch (e) { code = e.code; }
    ok(code === 'passcode' && !C.joined(), '違う合言葉は登録できない');
    ok(await C.join(PASS) === true && C.joined(), '正しい合言葉で登録できる');
    const up = await C.upload('recA', mk('1001', 'あお', 0));
    ok(up.day === '2026-11-15' && up.n === 600, '記録を送れる');
    await C.upload('recA', mk('1001', 'あお改', 0));
    ok(true, '同じ端末は自分の記録を送り直せる');

    useDevice('B');
    await C.join(PASS);
    code = '';
    try { await C.upload('recA', mk('9999', 'なりすまし', 0)); } catch (e) { code = e.code; }
    ok(code === 'passcode', '他の端末の記録は書き換えられない');
    await C.join(PASS);
    await C.upload('recB', mk('1002', 'あか', 0.002));

    useDevice('viewer');     // 見る人は、登録も合言葉も要らない
    const list = await C.days();
    ok(list.length === 1 && list[0] === '2026-11-15', '日付の一覧を読める');
    const items = await C.loadDay('2026-11-15');
    ok(items.length === 2, 'その日の記録をすべて読める');
    const tracks = items.map(it => RT.importer.parse(it.text, it.name)).sort((a, b) => (a.sail < b.sail ? -1 : 1));
    ok(tracks[0].sail === '1001' && tracks[0].name === 'あお改' && tracks[1].name === 'あか', '送り直した内容が反映され、他人の書き換えは反映されない');
    ok(tracks[0].fixes.length === 600 && Math.abs(tracks[0].fixes[599].lat - (34.68 + 599 * 2e-5)) < 1e-6, '位置がそのまま戻る');
    ok((await C.loadDay('2026-11-16')).length === 0, '記録の無い日は空');
    const res = await fetch(base + '/members.json');
    ok(res.status === 401, '合言葉の登録は、外から読めない');
    code = '';
    RT.config.cloud = { databaseURL: 'http://127.0.0.1:1', apiKey: 'test', authURL: base, tokenURL: base };
    try { await C.days(); } catch (e) { code = e.code; }
    ok(code === 'net', 'つながらないときは、通信の失敗として知らせる');
  } finally {
    RT.config.cloud = realConf;
    delete globalThis.localStorage;
    server.close();
  }
}

cloudRoundTrip().catch(e => { failed++; console.log('  NG: 送信の通しテストが止まりました: ' + (e && e.stack || e)); }).then(() => {
  console.log('\n' + (failed ? 'NG ' + failed + ' 件 / ' : '') + 'OK ' + passed + ' 件');
  process.exit(failed ? 1 : 0);
});
