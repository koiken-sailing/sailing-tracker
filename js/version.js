/* アプリの版。公開するたびに、この1行を書き換える。
 * 画面に表示するので、部員のスマホに新しい版が届いたかを確かめられる。
 * 圏外でも開けるように保存しておく分（sw.js）も、この版ごとに入れ替える。 */
(function (root) {
  'use strict';
  var RT = root.RT = root.RT || {};
  RT.version = '2026.11.12a';
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
