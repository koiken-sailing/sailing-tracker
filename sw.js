/* 電波のない場所でもページを開けるようにする仕組み（サービスワーカー）。
 *
 * 海の上でブラウザがページを読み込み直すと、圏外では記録ページを開けず、記録を再開できなくなる。
 * それを防ぐために、アプリのファイルをスマホの中に保存しておく。
 *
 *   電波があるとき: いつも最新のファイルを取りに行く（古い版を見せ続けない）。取れたら保存し直す。
 *   電波がないとき: 保存してあるファイルで開く。4秒待っても届かないときも同じ。
 *
 * 手を出すのは、このサイト自身のファイルと、地図を回す部品1つだけ。
 * 地図の画像や、送り先（Firebase）との通信には触れない。 */
'use strict';
importScripts('js/version.js');

var CACHE = 'yt-app-' + self.RT.version;
var WAIT_MS = 4000;
// 地図を回す部品。配布元から読み込み、改ざんの検知は読み込む側（integrity）で行う。版が固定なので、保存したものを使う
var ROTATE = 'https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate.js';
var FILES = [
  './', 'index.html', 'tracker.html', 'live.html',
  'css/style.css', 'css/tracker.css', 'css/live.css',
  'js/version.js', 'js/boot.js', 'js/geo.js', 'js/course.js', 'js/sim.js', 'js/race.js', 'js/analysis.js',
  'js/importer.js', 'js/config.js', 'js/cloud.js', 'js/plan.js', 'js/livemap.js', 'js/app.js', 'js/tracker.js',
  'vendor/leaflet-1.9.4/leaflet.min.js', 'vendor/leaflet-1.9.4/leaflet.min.css'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (cache) {
    return cache.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); })).then(function () {
      // 地図を回す部品は、保存できなくてもアプリは動く（地図を開くときに読みに行く）
      return cache.add(new Request(ROTATE, { mode: 'cors' })).catch(function () {});
    });
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('yt-app-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* 保存するときの名前。アドレスの「?」以降（?test=1 や ?day=…）は外す。 */
function keyOf(url) { return url.origin + url.pathname; }

function saved(url) {
  return caches.open(CACHE).then(function (cache) { return cache.match(keyOf(url)); });
}

function networkFirst(url) {
  return new Promise(function (resolve) {
    var settled = false;
    function finish(res) { if (!settled && res) { settled = true; resolve(res); } }
    var timer = setTimeout(function () { saved(url).then(finish); }, WAIT_MS);
    fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
      clearTimeout(timer);
      if (res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(keyOf(url), copy); });
      }
      finish(res);
    }).catch(function () {
      clearTimeout(timer);
      saved(url).then(function (res) { finish(res || Response.error()); });
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (req.url === ROTATE) {
    e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req); }));
    return;
  }
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(networkFirst(url));
});
