/* どのページでも最後に読み込む小さな準備。
 *   1. 版を画面に表示する（data-version の付いた場所に書き込む）
 *   2. 圏外でもページを開けるようにする仕組み（sw.js）を登録する */
(function () {
  'use strict';
  var RT = window.RT = window.RT || {};

  Array.prototype.forEach.call(document.querySelectorAll('[data-version]'), function (el) {
    el.textContent = '版 ' + (RT.version || '不明');
  });

  // https（または自分のPC）でしか使えない。登録できなくても、ふつうに使える
  var host = location.hostname;
  var okPlace = location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1';
  if ('serviceWorker' in navigator && okPlace) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* 登録できなくても続ける */ });
  }
})();
