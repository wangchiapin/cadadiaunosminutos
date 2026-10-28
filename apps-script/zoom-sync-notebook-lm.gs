/**
 * NotebookLM 簡化版 Zoom 會議記錄生成函數
 *
 * 功能：從「原始資料」Sheet 提取 7 個欄位（不含逐字稿）
 * 生成「NotebookLM用簡化版」Sheet，供 NotebookLM 上傳使用
 *
 * 集成方式：
 * 1. 複製此整個函數到你的 Zoom Google Sheet 的 Apps Script 編輯器
 * 2. 在主同步函式的最後加上：generateNotebookLMSheet();
 * 3. 每次同步 Zoom 資料時會自動生成簡化版
 */

function generateNotebookLMSheet() {
  const ss = SpreadsheetApp.openById('1ViLuOMGXUWi-ExnfY061t745HXg4IVtsXRMl1OV2NB4');
  const sourceSheet = ss.getSheetByName('原始資料');

  if (!sourceSheet) {
    Logger.log('❌ 找不到「原始資料」Sheet');
    return;
  }

  // 取得原始資料的所有內容
  const allData = sourceSheet.getDataRange().getValues();
  const headers = allData[0];

  // 找出需要的欄位位置（中文版本，不含逐字稿）
  const colIndexes = {
    date: headers.indexOf('日期'),
    student: headers.indexOf('學生'),
    meetingName: headers.indexOf('會議名稱'),
    quickSummaryCN: headers.indexOf('快速摘要（中文）'),
    detailSummaryCN: headers.indexOf('詳細摘要（中文）'),
    actionsCN: headers.indexOf('行動事項（中文）'),
    studentTodoCN: headers.indexOf('給學生的待辦（中文）')
  };

  // 確認所有欄位都找到了
  const missingCols = Object.keys(colIndexes).filter(k => colIndexes[k] === -1);
  if (missingCols.length > 0) {
    Logger.log('❌ 找不到以下欄位：' + missingCols.join(', '));
    return;
  }

  // 準備簡化版資料（只取出需要的 7 欄）
  const simplifiedData = [];
  simplifiedData.push(['日期', '學生', '會議名稱', '快速摘要', '詳細摘要', '行動事項', '給學生的待辦']);

  // 從第 2 列開始，跳過標題行
  for (let i = 1; i < allData.length; i++) {
    const row = allData[i];
    const date = row[colIndexes.date] || '';
    const student = row[colIndexes.student] || '';
    const meetingName = row[colIndexes.meetingName] || '';
    const quickSum = row[colIndexes.quickSummaryCN] || '';
    const detailSum = row[colIndexes.detailSummaryCN] || '';
    const actions = row[colIndexes.actionsCN] || '';
    const studentTodo = row[colIndexes.studentTodoCN] || '';

    // 只有日期和學生都有值的行才加入
    if (date || student) {
      simplifiedData.push([date, student, meetingName, quickSum, detailSum, actions, studentTodo]);
    }
  }

  // 取得或建立「NotebookLM用簡化版」Sheet
  let targetSheet = ss.getSheetByName('NotebookLM用簡化版');
  if (targetSheet) {
    targetSheet.clearContents();
  } else {
    targetSheet = ss.insertSheet('NotebookLM用簡化版');
  }

  // 寫入資料
  if (simplifiedData.length > 1) {
    targetSheet.getRange(1, 1, simplifiedData.length, 7).setValues(simplifiedData);
  }

  Logger.log('✅ NotebookLM用簡化版已生成：' + (simplifiedData.length - 1) + ' 筆課程記錄');
}
