# MWS_25 - MAL和狩

このプロジェクトは、2人で協力してMalwareを解析するマルチプレイヤーWebゲームです。  
指示者（A）と回答者（B）がそれぞれ異なる情報を受け取り、正しい答えを導きます。

## 構成ファイル
- `server.js`：Node.js + Socket.IO によるゲームサーバー。ラウンド管理、出題、スコア計算などを担当。
- `index.html`：クライアント側UI。プレイヤーの役割に応じた情報表示、回答入力、ページ送りなどを提供。
- `challenges.json`：ゲームで使用される問題ファイル
## 起動方法
```bash
npm install
node src/server.js
