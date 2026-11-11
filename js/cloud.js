/* 記録を送る・公開された記録を読む部分（記録ページと観戦ページの両方で使う）。
 *
 * 送り先は Firebase Realtime Database。専用の部品は読み込まず、ふつうの通信（REST）だけで使う。
 *   送る人: 端末ごとに匿名の ID を作り、合言葉を1度だけ登録する。合言葉が合った端末だけが書き込める。
 *   見る人: ID も合言葉も要らない。
 *
 * 置き方:
 *   /days/{日付}/{記録ID}   … 一覧用の小さな情報（セール番号・ニックネーム・時刻）
 *   /tracks/{日付}/{記録ID} … 航跡そのもの（位置は差分にして1本の文字列に詰める）
 *   /members/{端末のID}     … 合言葉の登録（本人以外は読めない）
 *
 * 送るのは「公開してよい範囲」の中の位置だけ。範囲の外の位置は、端末から出さない。 */
(function (root) {
  'use strict';
  var RT = root.RT = root.RT || {};

  var AUTH_KEY = 'yt-cloud-auth';
  var DEV_KEY = 'yt-cloud-dev';
  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var MAX_FIXES = 12 * 3600;      // 1件の記録で送る点数の上限（1秒に1点で12時間ぶん）
  var MARK_TYPES = { m1: 1, m4: 1, fin: 1, start: 1, 'start-cancel': 1 };
  var TIMEOUT_MS = 20000;

  // ---------- 設定 ----------
  function conf() {
    var c = (RT.config && RT.config.cloud) || {};
    // 自分のPCで試すときだけ、送り先を模擬サーバーに差し替えられる
    try {
      var host = root.location && root.location.hostname;
      if ((host === 'localhost' || host === '127.0.0.1') && root.localStorage) {
        var dev = JSON.parse(root.localStorage.getItem(DEV_KEY) || 'null');
        if (dev && dev.databaseURL) c = dev;
      }
    } catch (e) { /* 差し替えが読めなければ、本来の設定を使う */ }
    return c;
  }
  function enabled() {
    var c = conf();
    return !!(c.databaseURL && c.apiKey);
  }

  // ---------- 公開してよい範囲 ----------
  function inPolygon(lat, lon, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inArea(lat, lon) {
    var poly = RT.config && RT.config.area;
    if (!poly || poly.length < 3) return false;   // 範囲が決まっていなければ、何も送らない
    return inPolygon(lat, lon, poly);
  }

  // ---------- 位置の列を短い文字列に詰める ----------
  // 1点ごとに「前の点との差」を整数にして、6ビットずつ文字にする（5ビットが値、1ビットが続きの印）。
  //   時刻: 0.1秒単位 / 緯度・経度: 100万分の1度（約0.1m）/ 精度: 1m単位（不明は -1）
  function putInt(out, n) {
    var v = n >= 0 ? n * 2 : -n * 2 - 1;
    while (v >= 32) { out.push(ALPHABET.charAt(32 + (v % 32))); v = Math.floor(v / 32); }
    out.push(ALPHABET.charAt(v));
  }
  function encodeFixes(fixes) {
    var out = [], pt = 0, pla = 0, plo = 0, pa = 0;
    fixes.forEach(function (f) {
      var t = Math.round(f[0] / 100), la = Math.round(f[1] * 1e6), lo = Math.round(f[2] * 1e6);
      var a = f[3] === null || f[3] === undefined || !isFinite(f[3]) ? -1 : Math.min(9999, Math.round(f[3]));
      putInt(out, t - pt); putInt(out, la - pla); putInt(out, lo - plo); putInt(out, a - pa);
      pt = t; pla = la; plo = lo; pa = a;
    });
    return out.join('');
  }
  function decodeFixes(str) {
    var vals = [], v = 0, mul = 1;
    for (var i = 0; i < str.length; i++) {
      var c = ALPHABET.indexOf(str.charAt(i));
      if (c < 0) throw new Error('記録を読み取れません');
      v += (c % 32) * mul;
      if (c >= 32) { mul *= 32; continue; }
      vals.push(v % 2 ? -(v + 1) / 2 : v / 2);
      v = 0; mul = 1;
    }
    if (mul !== 1 || vals.length % 4) throw new Error('記録を読み取れません');
    var fixes = [], t = 0, la = 0, lo = 0, a = 0;
    for (i = 0; i < vals.length; i += 4) {
      t += vals[i]; la += vals[i + 1]; lo += vals[i + 2]; a += vals[i + 3];
      fixes.push([t * 100, la / 1e6, lo / 1e6, a < 0 ? null : a]);
    }
    return fixes;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayOf(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function clean(s, max) {
    return String(s === undefined || s === null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  }
  function newId() {
    var out = '', buf = new Uint8Array(12);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(buf);
    else for (var k = 0; k < buf.length; k++) buf[k] = Math.floor(Math.random() * 256);
    for (var i = 0; i < buf.length; i++) out += ALPHABET.charAt(buf[i] % 62);   // 英数字だけ
    return out;
  }

  /* 記録ファイル（記録ページの buildFile の形）から、送る中身を作る。
   * 範囲の中に位置が2点以上なければ null（＝送るものがない）。 */
  function pack(file) {
    var all = Array.isArray(file.fixes) ? file.fixes : [];
    var inside = all.filter(function (f) {
      return Array.isArray(f) && isFinite(f[0]) && isFinite(f[1]) && isFinite(f[2]) && inArea(f[1], f[2]);
    });
    if (inside.length > MAX_FIXES) inside = inside.slice(inside.length - MAX_FIXES);
    if (inside.length < 2) return null;
    var marks = [];
    (Array.isArray(file.marks) ? file.marks : []).forEach(function (m) {
      if (!Array.isArray(m) || !MARK_TYPES[m[1]] || !isFinite(m[0])) return;
      var okPos = m[2] !== null && m[3] !== null && isFinite(m[2]) && isFinite(m[3]) && inArea(m[2], m[3]);
      marks.push(okPos ? [m[0], m[1], m[2], m[3]] : [m[0], m[1], null, null]);
    });
    var first = inside[0][0], last = inside[inside.length - 1][0];
    return {
      day: dayOf(first),
      outside: all.length - inside.length,     // 範囲の外だったので送らない点の数
      rec: {
        v: 1,
        sail: clean(file.sail, 12),
        nick: clean(file.name, 20),
        ops: !!file.ops,
        first: first, last: last, n: inside.length,
        f: encodeFixes(inside),
        m: JSON.stringify(marks.slice(0, 200))
      }
    };
  }

  /* 公開された記録1件を、記録ファイルと同じ形に戻す（観戦ページは、ファイルと同じ手順で読み込める） */
  function unpack(rec) {
    if (!rec || typeof rec.f !== 'string') throw new Error('記録を読み取れません');
    var marks = [];
    try {
      (JSON.parse(rec.m || '[]') || []).forEach(function (m) {
        if (Array.isArray(m) && MARK_TYPES[m[1]]) marks.push([Number(m[0]), m[1], m[2], m[3]]);
      });
    } catch (e) { marks = []; }
    return {
      format: 'yacht-track', version: 1,
      sail: clean(rec.sail, 12), name: clean(rec.nick, 20),
      ops: !!rec.ops,
      fixes: decodeFixes(rec.f).map(function (f) { return [f[0], f[1], f[2], f[3], null, null]; }),
      marks: marks
    };
  }

  // ---------- 通信 ----------
  function fail(code, msg) { var e = new Error(msg); e.code = code; return e; }

  /* 返り値は { status, data }。つながらない・時間切れは code='net' のエラー。 */
  function http(method, url, body, isForm) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
    var opt = { method: method, cache: 'no-store' };
    if (ctl) opt.signal = ctl.signal;
    if (body !== undefined) {
      opt.body = isForm ? body : JSON.stringify(body);
      opt.headers = { 'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json' };
    }
    return fetch(url, opt).then(function (res) {
      return res.text().then(function (text) {
        clearTimeout(timer);
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        return { status: res.status, data: data };
      });
    }, function () {
      clearTimeout(timer);
      throw fail('net', '通信できませんでした');
    });
  }

  function dbUrl(path, query) {
    var base = conf().databaseURL.replace(/\/+$/, '');
    return base + '/' + path.split('/').map(encodeURIComponent).join('/') + '.json' + (query ? '?' + query : '');
  }
  function authBase() { return (conf().authURL || 'https://identitytoolkit.googleapis.com').replace(/\/+$/, ''); }
  function tokenBase() { return (conf().tokenURL || 'https://securetoken.googleapis.com').replace(/\/+$/, ''); }

  // 端末の匿名 ID。更新用のトークンだけを端末に残し、通信用のトークン（1時間で切れる）は覚えておくだけ。
  var session = null;   // { id, uid, exp }
  function loadAuth() {
    try { return JSON.parse(root.localStorage.getItem(AUTH_KEY) || 'null') || {}; } catch (e) { return {}; }
  }
  function saveAuth(a) {
    try { root.localStorage.setItem(AUTH_KEY, JSON.stringify(a)); } catch (e) { /* 残せなくても続ける */ }
  }
  function signUp() {
    var url = authBase() + '/v1/accounts:signUp?key=' + encodeURIComponent(conf().apiKey);
    return http('POST', url, { returnSecureToken: true }).then(function (r) {
      if (r.status !== 200 || !r.data || !r.data.idToken) throw fail('server', '送り先の準備ができていません');
      saveAuth({ refresh: r.data.refreshToken, uid: r.data.localId, joined: false });
      session = { id: r.data.idToken, uid: r.data.localId, exp: Date.now() + (parseInt(r.data.expiresIn, 10) || 3600) * 1000 };
      return session;
    });
  }
  function ensureAuth() {
    var saved = loadAuth();
    // 覚えているトークンは、端末に残した ID と同じものであるときだけ使う（保存領域が消されていたら作り直す）
    if (session && session.exp > Date.now() + 60000 && saved.uid === session.uid) return Promise.resolve(session);
    if (!saved.refresh) return signUp();
    var url = tokenBase() + '/v1/token?key=' + encodeURIComponent(conf().apiKey);
    var form = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(saved.refresh);
    return http('POST', url, form, true).then(function (r) {
      if (r.status !== 200 || !r.data || !r.data.id_token) return signUp();   // ID が無効になっていたら作り直す
      saved.refresh = r.data.refresh_token || saved.refresh;
      saved.uid = r.data.user_id || saved.uid;
      saveAuth(saved);
      session = { id: r.data.id_token, uid: saved.uid, exp: Date.now() + (parseInt(r.data.expires_in, 10) || 3600) * 1000 };
      return session;
    });
  }

  /* この端末は合言葉の登録を済ませているか（端末に残した印を見るだけ。通信はしない） */
  function joined() { return !!loadAuth().joined; }

  /* 合言葉を登録する。違っていれば code='passcode' のエラー。 */
  function join(passcode) {
    passcode = String(passcode || '').trim();
    if (!passcode) return Promise.reject(fail('passcode', '合言葉を入力してください'));
    return ensureAuth().then(function (s) {
      return http('PUT', dbUrl('members/' + s.uid, 'auth=' + encodeURIComponent(s.id)), passcode).then(function (r) {
        if (r.status === 401 || r.status === 403) throw fail('passcode', '合言葉が違います');
        if (r.status !== 200) throw fail('server', '送り先でエラーが起きました');
        var a = loadAuth(); a.joined = true; saveAuth(a);
        return true;
      });
    });
  }

  /* 記録を送る。id は記録ごとの ID（同じ ID で送り直すと置き換わる）。packed は pack() の結果。 */
  function upload(id, packed) {
    return ensureAuth().then(function (s) {
      var q = 'auth=' + encodeURIComponent(s.id);
      var rec = packed.rec;
      var full = { v: rec.v, uid: s.uid, sail: rec.sail, nick: rec.nick, ops: rec.ops, first: rec.first, last: rec.last, n: rec.n, f: rec.f, m: rec.m };
      var head = { uid: s.uid, sail: rec.sail, nick: rec.nick, ops: rec.ops, first: rec.first, last: rec.last, n: rec.n };
      function check(r) {
        if (r.status === 401 || r.status === 403) {
          // 合言葉の登録が消えている（または未登録）。印を外して、入れ直してもらう
          var a = loadAuth(); a.joined = false; saveAuth(a);
          throw fail('passcode', '合言葉の登録が必要です');
        }
        if (r.status !== 200) throw fail('server', '送り先でエラーが起きました');
      }
      return http('PUT', dbUrl('tracks/' + packed.day + '/' + id, q), full).then(function (r) {
        check(r);
        return http('PUT', dbUrl('days/' + packed.day + '/' + id, q), head);
      }).then(function (r) {
        check(r);
        return { day: packed.day, n: rec.n };
      });
    });
  }

  /* 記録のある日付の一覧（新しい順） */
  function days() {
    return http('GET', dbUrl('days', 'shallow=true')).then(function (r) {
      if (r.status !== 200) throw fail('server', '記録の一覧を読めませんでした');
      return Object.keys(r.data || {}).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort().reverse();
    });
  }

  /* ある日の記録をすべて読む。返り値は [{ name, text }]（航跡ファイルを選んだときと同じ形）。 */
  function loadDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return Promise.reject(fail('server', '日付の形が違います'));
    return http('GET', dbUrl('tracks/' + day)).then(function (r) {
      if (r.status !== 200) throw fail('server', '記録を読めませんでした');
      var out = [];
      Object.keys(r.data || {}).forEach(function (id) {
        try { out.push({ name: id, text: JSON.stringify(unpack(r.data[id])) }); } catch (e) { /* 壊れた1件は飛ばす */ }
      });
      return out;
    });
  }

  RT.cloud = {
    enabled: enabled, inArea: inArea, inPolygon: inPolygon,
    encodeFixes: encodeFixes, decodeFixes: decodeFixes, pack: pack, unpack: unpack,
    dayOf: dayOf, newId: newId,
    joined: joined, join: join, upload: upload, days: days, loadDay: loadDay
  };
})(typeof window !== 'undefined' ? window : globalThis);
