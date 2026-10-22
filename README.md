# 華語教學日誌

> 每日上課收入、學生收費、課表與匯款紀錄（華語教學管理工具，原 repo 名稱 `-`）

- **網址：** https://wangchiapin.github.io/cadadiaunosminutos/
- **Firebase 專案：** moneybook-50481
- **登入方式：** Email / 密碼
- **狀態：** 使用中
- **備註：** 以 GitHub Actions 部署（`.github/workflows/deploy.yml`）。

## 相關的部分

- **TimeTree 課表同步：** 在私人 repo `timetree-sync`（每 3 小時把 TimeTree「課表」寫進 `users/{uid}/ttSync/state`，網頁只讀、不寫）。因為含登入資訊與行程，所以刻意不放在這個公開 repo。
- **請假／沒上課有付錢的標記：** 存在 `users/{uid}/ttMeta/marks`（一份文件，欄位 `items`），只有網頁會寫。舊版 `users/{uid}/ttMarks`（一標記一份文件）第一次登入會自動搬進來，舊的保留不刪。
- **Google Apps Script：** `apps-script/` 裡是備份，包含資料同步到 Google Sheet（`Code.gs`）與每週日 20:00 寄出的週報（`WeeklyReport.gs`）；改了 Firestore 的欄位或存放方式，記得一起更新。
