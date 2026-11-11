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

## 教材同步（MaterialsSync.gs）

把 Drive「一位學生一個資料夾」裡的 PDF 連結寫到學生頁（學生在「我的學習 → 教材」點開）。
- 跟 `Code.gs` 放在同一個 Apps Script 專案（會用到 `getAccessToken`）。
- 「指令碼屬性」新增 `MATERIALS_ROOT_FOLDER_ID`（放所有學生資料夾的大資料夾 ID）；`PORTAL_TID` 可省略（預設用 `MONEYBOOK_UID`）。
- 先執行 `previewMaterials()` 看記錄（資料夾對到誰、有幾個 PDF、哪些對不到），沒問題再 `syncMaterials()`，最後 `installMaterialsTrigger()` 每 30 分鐘自動更新；取消用 `removeMaterialsTrigger()`。
- 資料夾名稱要跟日誌的學生名字一樣（大小寫、空白不影響）；同名學生不會亂猜。
- 預設會把掃到的 PDF 設成「知道連結的人都能檢視」；不想讓程式改分享設定就把 `MATERIALS_AUTO_SHARE` 設成 `false`。
- 寫入路徑 `portal/{老師uid}/materials/{學生代號}`（規則見學生頁 repo 的 `moneybook-50481-portal-rules.txt` 第七批）。

## 資料欄位提醒

- 學生資料裡的 `pending`（待確認）、`ymd`（背後存的完整日期）不會寫進 Google Sheet。
- 學生基本資料多了 `ttKeys`（TimeTree 標題開頭），會自動出現在 Sheet 的學生總覽欄位。
- 週報用同一套規則推算年份、對應 TimeTree 標題（`wrClassDates`、`wrResolveTitle`），改網頁的規則時要一起改。
