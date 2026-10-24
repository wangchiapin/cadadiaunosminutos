# Google Apps Script 備份

`Code.gs` 是「華語教學日誌」資料同步到 Google Sheet 的 Apps Script 備份（`syncAllTutoring` 會依序同步課表、學生、收入、TimeTree 課程行事曆）。

- 這裡只是備份；實際執行的是 Google Apps Script 專案本身，改了那邊之後記得回來更新這份。
- 金鑰（`FIREBASE_PRIVATE_KEY` 等）存在 Apps Script 的「指令碼屬性」，不在這份檔案裡。

## 每週報表（WeeklyReport.gs）

每週日晚上 8 點（台灣時間）自動寄 HTML 週報＋PDF 附件到信箱。
- 跟 `Code.gs` 放在同一個 Apps Script 專案。
- 先執行 `previewWeeklyReport()` 試寄一封，確認樣子後再執行 `installWeeklyReportTrigger()` 設定每週排程。
- 想換收件信箱：在「指令碼屬性」新增 `REPORT_EMAIL`；沒設定就寄給執行者本人。
- 取消排程：執行 `removeWeeklyReportTrigger()`。

## 資料欄位提醒

- 學生資料裡的 `pending`（待確認）、`ymd`（背後存的完整日期）不會寫進 Google Sheet。
- 學生基本資料多了 `ttKeys`（TimeTree 標題開頭），會自動出現在 Sheet 的學生總覽欄位。
- 週報用同一套規則推算年份、對應 TimeTree 標題（`wrClassDates`、`wrResolveTitle`），改網頁的規則時要一起改。
