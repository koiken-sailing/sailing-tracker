/* 送り先（Firebase）の代わりをする、自分のPC専用の模擬サーバー。
 * 本物の Firebase を用意する前でも、記録を送る → 観戦ページで見る、の流れを試せる。
 * 実行: node tools/mock-cloud.js → http://localhost:5174（合言葉は test-pass）
 *
 * 本物と同じ決まり（tools/firebase-rules.json）をまねている:
 *   合言葉が合った端末だけが書き込める / 他人の記録は書き換えられない / 読むのは誰でもできる
 * データはメモリの中だけに置き、止めると消える。 */
'use strict';
const http = require('http');

function start(port, passcode) {
  const db = { members: {}, days: {}, tracks: {} };
  let seq = 0;

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
  }
  const denied = res => send(res, 401, { error: 'Permission denied' });
  const uidOf = token => (token && token.startsWith('tok-') ? token.slice(4) : null);

  function writeRecord(table, day, id, uid, body, need) {
    if (!uid || !db.members[uid]) return false;                       // 合言葉を登録した端末だけ
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !body || body.uid !== uid) return false;
    const old = db[table][day] && db[table][day][id];
    if (old && old.uid !== uid) return false;                         // 他人の記録は書き換えられない
    if (!need.every(k => body[k] !== undefined)) return false;
    if (typeof body.sail !== 'string' || body.sail.length > 12) return false;
    if (typeof body.nick !== 'string' || body.nick.length > 20) return false;
    if (table === 'tracks' && (typeof body.f !== 'string' || body.f.length >= 600000)) return false;
    (db[table][day] = db[table][day] || {})[id] = body;
    return true;
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 200, {});
    const u = new URL(req.url, 'http://localhost');
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      // 匿名の ID を作る・更新する
      if (req.method === 'POST' && u.pathname === '/v1/accounts:signUp') {
        const uid = 'u' + (++seq) + Date.now().toString(36);
        return send(res, 200, { idToken: 'tok-' + uid, refreshToken: 'ref-' + uid, expiresIn: '3600', localId: uid });
      }
      if (req.method === 'POST' && u.pathname === '/v1/token') {
        const ref = new URLSearchParams(raw).get('refresh_token') || '';
        if (!ref.startsWith('ref-')) return send(res, 400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
        const uid = ref.slice(4);
        return send(res, 200, { id_token: 'tok-' + uid, refresh_token: ref, user_id: uid, expires_in: '3600' });
      }
      if (!u.pathname.endsWith('.json')) return send(res, 404, { error: 'not found' });
      const parts = u.pathname.slice(1, -5).split('/').map(decodeURIComponent);
      const uid = uidOf(u.searchParams.get('auth'));
      let body = null;
      if (req.method === 'PUT') { try { body = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'bad json' }); } }

      if (parts[0] === 'members' && parts.length === 2 && req.method === 'PUT') {
        if (!uid || uid !== parts[1] || body !== passcode) return denied(res);
        db.members[uid] = body;
        return send(res, 200, body);
      }
      if (parts[0] === 'days' && req.method === 'GET') {
        let node = db.days;
        for (let i = 1; i < parts.length && node; i++) node = node[parts[i]];
        if (node && u.searchParams.get('shallow') === 'true' && typeof node === 'object') {
          const keys = {};
          Object.keys(node).forEach(k => { keys[k] = true; });
          node = keys;
        }
        return send(res, 200, node === undefined || (node && !Object.keys(node).length) ? null : node);
      }
      if (parts[0] === 'tracks' && parts.length >= 2 && req.method === 'GET') {
        let node = db.tracks;
        for (let i = 1; i < parts.length && node; i++) node = node[parts[i]];
        return send(res, 200, node === undefined ? null : node);
      }
      if (parts[0] === 'days' && parts.length === 3 && req.method === 'PUT') {
        return writeRecord('days', parts[1], parts[2], uid, body, ['uid', 'sail', 'nick', 'first', 'last', 'n']) ? send(res, 200, body) : denied(res);
      }
      if (parts[0] === 'tracks' && parts.length === 3 && req.method === 'PUT') {
        return writeRecord('tracks', parts[1], parts[2], uid, body, ['v', 'uid', 'sail', 'nick', 'first', 'last', 'n', 'f', 'm']) ? send(res, 200, body) : denied(res);
      }
      return denied(res);
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { start };

if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 5174;
  const pass = process.env.MOCK_PASS || 'test-pass';
  start(port, pass).then(() => console.log('模擬の送り先: http://localhost:' + port + ' （合言葉: ' + pass + '）。止めるには Ctrl+C。'));
}
