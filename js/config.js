/* 記録の送り先と、公開してよい範囲の設定。
 *
 * このファイルは GitHub で誰でも読める。ここに書いてよいのは「公開されても困らない値」だけ。
 *   databaseURL と apiKey は、送り先を示す「住所」にあたる。ブラウザに渡す前提の値なので公開してよい。
 *   合言葉・パスワード・「秘密鍵」「サービスアカウント」と名の付くものは、絶対にここへ書かない。
 * 誰が書き込めるかは、Firebase 側のルール（tools/firebase-rules.json）と合言葉で守る。 */
(function (root) {
  'use strict';
  var RT = root.RT = root.RT || {};

  RT.config = {
    // 2つとも空のあいだは、送信の機能そのものが画面に出ない
    cloud: {
      databaseURL: 'https://sailing-tracker-6007b-default-rtdb.asia-southeast1.firebasedatabase.app',
      apiKey: 'AIzaSyCQrz6OYLMcEibRS1r7ks96lCCFSy_ogG0'
    },

    // 公開してよい範囲（海の上）を囲む多角形。[緯度, 経度] を順に並べる。
    // この外で記録した位置は送信しない（自宅や通学路が公開されるのを防ぐ）。
    // いまの範囲: 芦屋浜・西宮浜の沖。岸から100m以上離してあり、ハーバーの中と水路は含めていない。
    //   北の端は芦屋浜の護岸の約150m沖、東の端は甲子園浜の埋立地の沖、西の端は六甲アイランドの東の沖。
    area: [
      [34.7035, 135.2965],
      [34.7035, 135.3420],
      [34.7005, 135.3420],
      [34.7005, 135.3500],
      [34.6550, 135.3500],
      [34.6550, 135.2965]
    ]
  };
})(typeof window !== 'undefined' ? window : globalThis);
