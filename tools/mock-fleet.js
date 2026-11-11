/* 模擬サーバーに「いま走っている艇団」を流し続ける、動作確認用の道具。
 * リアルタイムの地図を、海に出なくても自分のPCで確かめられる。
 * 使い方: 先に node tools/mock-cloud.js を動かしてから、node tools/mock-fleet.js
 * 本物の送り先（Firebase）には何も送らない。送り先は必ず自分のPCの模擬サーバー。 */
'use strict';
const path = require('path');
['geo', 'course', 'sim', 'config', 'cloud'].forEach(f => require(path.join(__dirname, '..', 'js', f + '.js')));
const RT = globalThis.RT, C = RT.cloud;

const PORT = parseInt(process.env.PORT, 10) || 5174;
const PASS = process.env.MOCK_PASS || 'test-pass';
const BOATS = parseInt(process.env.BOATS, 10) || 5;
const base = 'http://127.0.0.1:' + PORT;
RT.config.cloud = { databaseURL: base, apiKey: 'test', authURL: base, tokenURL: base };   // 模擬サーバーだけに送る

const stores = {};
function useDevice(name) {   // 艇ごとに、スマホの保存領域の代わりを用意する
  const m = stores[name] = stores[name] || new Map();
  globalThis.localStorage = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
}

const course = RT.course.build(RT.course.DEFAULTS, {});
const sim = RT.sim.run(course, { n: BOATS, seed: 21 });
const START = Date.now() - 240 * 1000;          // 4分前にスタートしたレース、という想定
const timeOf = k => START + (sim.t0 + k) * 1000;
const nicks = ['あお', 'あか', 'きいろ', 'みどり', 'むらさき', 'しろ', 'くろ', 'ちゃ', 'もも', 'そら', 'ぎん', 'きん'];

function fixesOf(i, untilMs) {
  const b = sim.boats[i], out = [];
  for (let k = 0; k < sim.n && timeOf(k) <= untilMs; k++) {
    const q = course.latLon({ x: b.x[k], y: b.y[k] });
    out.push([timeOf(k), q.lat, q.lon, 5, null, null]);
  }
  return out;
}
const cb = course.latLon(course.cb), ll = k => course.latLon(course.marks[k]);
const opsMarks = [
  [START - 900000, 'm1', ll('m1').lat, ll('m1').lon, 5, 100], [START - 800000, 'm4', ll('m4').lat, ll('m4').lon, 5, 100],
  [START - 700000, 'fin', ll('fin').lat, ll('fin').lon, 5, 100], [START, 'start', cb.lat, cb.lon, 4, 100, 2]
];

const state = {};   // 艇ごと: 航跡のかたまりをどこまで送ったか
async function tick() {
  const now = Date.now();
  for (let i = 0; i <= BOATS; i++) {
    const isOps = i === BOATS, id = isOps ? 'mockOps' : 'mockBoat' + i;
    useDevice(id);
    const st = state[id] = state[id] || { joined: false, chunkFrom: 0 };
    const fixes = isOps ? [[now - 1000, cb.lat, cb.lon, 4, null, null], [now, cb.lat, cb.lon, 4, null, null]] : fixesOf(i, now);
    if (!fixes.length) continue;
    try {
      if (!st.joined) { await C.join(PASS); st.joined = true; }
      const info = isOps ? { sail: 'RC', nick: '本部船', ops: true, marks: opsMarks } : { sail: String(1001 + i), nick: nicks[i % nicks.length], ops: false, marks: [] };
      const lastT = fixes[fixes.length - 1][0];
      await C.liveNow(id, info, C.livePick(fixes, lastT - C.LIVE_TAIL_MS, Infinity, 0, false), false);
      if (!isOps && lastT - st.chunkFrom >= 60000) {
        const part = C.livePick(fixes, st.chunkFrom || lastT - 10 * 60000, lastT, 2000, false).slice(-450);
        if (part.length) await C.liveChunk(id, part);
        st.chunkFrom = lastT;
      }
    } catch (e) {
      console.log(id + ': ' + (e.code || e.message) + '（模擬サーバーは動いていますか？）');
    }
  }
}
console.log('模擬の艇団 ' + BOATS + '艇と本部船を、' + base + ' に5秒ごとに流します。止めるには Ctrl+C。');
tick();
setInterval(tick, 5000);
