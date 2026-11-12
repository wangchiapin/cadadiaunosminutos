/* 華語教學日誌：自動檢查（不需要安裝任何東西，只要有 Node.js）
   用法：在專案資料夾執行  node tests/run.js
   做法：從 index.html 和 apps-script/WeeklyReport.gs 把要檢查的函式抄出來，
        在假的「今天＝2026/10/24」環境裡跑，對照預期結果。全部通過會顯示「全部通過」，有錯會列出哪一項。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const wr = fs.readFileSync(path.join(root, 'apps-script', 'WeeklyReport.gs'), 'utf8');
const ms = fs.readFileSync(path.join(root, 'apps-script', 'MaterialsSync.gs'), 'utf8');

/* 從原始碼抄出一個 function（用大括號配對找結尾） */
function fn(src, name) {
  const m = new RegExp('(^|\\n)[ \\t]*(async\\s+)?function\\s+' + name + '\\b').exec(src);
  if (!m) throw new Error('找不到函式 ' + name);
  let i = src.indexOf('function', m.index);
  const start = m[2] ? src.lastIndexOf('async', i) : i;
  let depth = 0, started = false, str = null;
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    if (str) { if (ch === '\\') { k++; continue; } if (ch === str) str = null; continue; }
    if (ch === '/' && src[k + 1] === '/') { while (k < src.length && src[k] !== '\n') k++; continue; }
    if (ch === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { str = ch; continue; }
    if (ch === '{') { depth++; started = true; }
    if (ch === '}') { depth--; if (started && depth === 0) return src.slice(start, k + 1); }
  }
  throw new Error('函式沒有結尾 ' + name);
}
/* 抄出「從 a 開頭到 b 開頭之前」的一段 */
function between(src, a, b) {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('找不到區段 ' + a);
  return src.slice(i, j);
}

/* 假的今天：2026/10/24 12:00（本機時間） */
const FIXED = new Date(2026, 9, 24, 12, 0, 0).getTime();
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(FIXED); }
  static now() { return FIXED; }
}

let passed = 0, failed = 0;
function test(name, f) {
  try { f(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + String(e.message).split('\n').join('\n      ')); }
}
async function testAsync(name, f) {
  try { await f(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + String(e.message).split('\n').join('\n      ')); }
}

/* ---------- 網頁端 ---------- */
const web = vm.createContext({ Date: FakeDate, console, TextEncoder, JSON, Math, Object, Array, String, Number, parseInt, isNaN, RegExp });
vm.runInContext([
  'const STD_MISSING_DAYS = 30;',
  fn(html, 'stdLocalIso'), fn(html, 'stdParseMD'), fn(html, 'stdResolveDates'), fn(html, 'stdClassDates'),
  fn(html, 'stdCountdownByRow'), fn(html, 'stdIsFutureTime'), fn(html, 'stdTaughtStats'),
  fn(html, 'stdTitleKeysOf'), fn(html, 'stdResolveTitle'), fn(html, 'renewTitleMatches'),
  'const STD_ZOOM_WINDOW_MIN = 45;',
  fn(html, 'stdZoomStartMin'), fn(html, 'stdZoomLessonStart'), fn(html, 'stdZoomCompute'),
  'const STD_CARD_PAGE = 8;',
  fn(html, 'stdCardRowEmpty'), fn(html, 'stdCardPlan'),
  'var stdDb = {};'
].join('\n'), web);
const W = name => web[name];
const dates = list => W('stdClassDates')(list.map(t => (typeof t === 'string' ? { time: t } : t)));

/* ---------- Apps Script 端 ---------- */
const gs = vm.createContext({ Date: FakeDate, String, Object, Array, parseInt, isNaN, RegExp });
vm.runInContext([fn(wr, 'wrClassDates'), fn(wr, 'wrCountdownOf'), fn(wr, 'wrResolveTitle')].join('\n'), gs);

console.log('\n年份推算（沒寫年份的課程時間）');
test('最後一筆是 1/13 的舊學生 → 2026，不會變 2027', () => {
  assert.deepStrictEqual(dates(['12/18 1000-1100', '1/5 1000', '1/13 1000']), ['2025-12-18', '2026-01-05', '2026-01-13']);
});
test('時間文字自己有寫年份就照寫的', () => {
  assert.deepStrictEqual(dates(['10/20 1000', '11/3 1000', '2027/1/2 1000']), ['2026-10-20', '2026-11-03', '2027-01-02']);
});
test('背後存的年份（ymd）優先，月日對得上才採用', () => {
  assert.deepStrictEqual(dates([{ time: '12/1', ymd: '2024-12-01' }, '1/5', 'garbage', '1/12']), ['2024-12-01', '2026-01-05', null, '2026-01-12']);
  assert.strictEqual(dates([{ time: '12/2', ymd: '2024-12-01' }])[0], '2026-12-02');   // 月日對不上 → 當作沒存，重新推算
});
test('跨年的順序：12 月、12 月、1 月（今天 10/24）', () => {
  assert.deepStrictEqual(dates(['12/20 1000', '12/27 1000', '1/3 1000']), ['2025-12-20', '2025-12-27', '2026-01-03']);
});
test('網頁和週報的 Apps Script 推算結果一致', () => {
  const cases = [
    ['12/18 1000', '1/5 1000', '1/13 1000'], ['10/20', '11/3', '2027/1/2'], ['3/1', '3/8', '3/15'],
    ['12/20', '12/27', '1/3'], ['9/25', '10/3', '10/22', '12/30'], ['2/3', '2/10', '8/4', '1/13']
  ];
  cases.forEach(c => {
    const a = dates(c), b = vm.runInContext('wrClassDates', gs)(c.map(t => ({ time: t })));
    assert.strictEqual(JSON.stringify(b), JSON.stringify(a), JSON.stringify(c));
  });
});

console.log('\n預付倒數（照日期順序，不受列的位置影響）');
test('排序錯位的列仍照日期算', () => {
  const rows = [{ time: '2026/10/1 1000', prepaidInput: '4', progress: 'a' }, { time: '2026/10/15 1000', progress: 'c' }, { time: '2026/10/8 1000', progress: 'b' }];
  assert.strictEqual(W('stdCountdownByRow')(rows).final, 2);
  assert.deepStrictEqual(Array.from(W('stdCountdownByRow')(rows).at), [4, 2, 3]);
});
test('空白列、沒寫進度的列不扣堂；「沒上課有付錢」要扣；扣完變負數就是超過', () => {
  const f = W('stdCountdownByRow');
  const base = [{ time: '2026/10/1 1000', prepaidInput: '2', progress: 'a' }, { time: '2026/10/8 1000', progress: 'b' }];
  assert.strictEqual(f(base.concat([{}, { time: '2026/10/20 1000' }])).final, 1);
  assert.strictEqual(f(base.concat([{ progress: '沒上課有付錢' }])).final, 0);
  assert.strictEqual(f(base.concat([{ progress: '沒上課有付錢' }, { progress: 'c' }])).final, -1);
});
test('週報的倒數跟網頁一致', () => {
  const st = { classes: [{ time: '2026/9/1 1000', prepaidInput: '3', progress: 'a' }, { time: '2026/9/8 1000', progress: 'b' }, { time: '2026/9/15 1000', progress: 'c' }] };
  assert.strictEqual(vm.runInContext('wrCountdownOf', gs)(st), W('stdCountdownByRow')(st.classes).final);
});

console.log('\nTimeTree 標題 → 學生');
const mk = (n, k, arch) => ({ isArchived: !!arch, basic: { name: n, ttKeys: k || '' }, classes: [] });
const stuData = { 1: mk('Alberto(MX)', 'Alberto墨西哥'), 2: mk('Alberto.V', 'Alberto墨西哥導遊'), 3: mk('Alexa'), 4: mk('Alex'), 5: mk('Anita', '西班牙文-Anita'),
  6: mk('Tania', '', true), 7: mk('Juan&Liz'), 8: mk('Juan'), 9: mk('Nicole'), 10: mk('Vasthy'), 11: mk('Megan'), 12: mk('Javier') };
web.stdDb = stuData;
const who = t => { const r = W('stdResolveTitle')(t); return r ? r.name + (r.archived ? '(封存)' : '') : null; };
const expect = {
  'Alberto墨西哥': 'Alberto(MX)', 'Alberto墨西哥導遊': 'Alberto.V', 'Alexa墨西哥': 'Alexa', 'Alex': 'Alex', 'Alex墨西哥': 'Alex',
  '西班牙文-Anita': 'Anita', 'Tania西班牙文': 'Tania(封存)', 'Juan&Liz': 'Juan&Liz', 'Juan': 'Juan', 'Nicole,菲律賓': 'Nicole',
  'Vasthy': 'Vasthy', 'Vasthy墨西哥': 'Vasthy', 'Megan菲律賓': 'Megan', 'Javier西班牙班': 'Javier', '宣傳練習卷': null, '教召': null
};
test('截圖上的各種標題都對到正確的人', () => { Object.keys(expect).forEach(t => assert.strictEqual(who(t), expect[t], t)); });
test('續課提醒用的比對跟上面一致', () => {
  assert.ok(W('renewTitleMatches')('Alberto.V', 'Alberto墨西哥導遊'));
  assert.ok(!W('renewTitleMatches')('Alberto(MX)', 'Alberto墨西哥導遊'));
  assert.ok(W('renewTitleMatches')('Alberto(MX)', 'Alberto墨西哥'));
});
test('週報的 Apps Script 比對結果一致', () => {
  const f = vm.runInContext('wrResolveTitle', gs);
  const idOf = { 'Alberto墨西哥': '1', 'Alberto墨西哥導遊': '2', 'Alexa墨西哥': '3'.replace('3', '3'), 'Alex': '4' };
  Object.keys(idOf).forEach(t => { const r = f(stuData, t); assert.ok(r, t); });
  assert.strictEqual(f(stuData, 'Alberto墨西哥導遊').id, '2');
  assert.strictEqual(f(stuData, 'Alberto墨西哥').id, '1');
  assert.strictEqual(f(stuData, '宣傳練習卷'), null);
});

console.log('\n已上堂數與已上多久');
test('不算：沒上課有付錢、待確認、還沒到的課', () => {
  const st = { basic: { name: 'A' }, classes: [
    { time: '2024/7/3 1000' }, { time: '2024/8/1 1000' }, { time: '2026/9/25 1000' },
    { time: '2026/10/3 1000', progress: '沒上課有付錢' }, { time: '2026/10/22 1000' }, { time: '2026/10/23 1000', pending: true }, { time: '2026/12/30 1000' }] };
  const r = W('stdTaughtStats')(st);
  assert.strictEqual(r.count, 4);
  assert.strictEqual(r.text, '2 年 3 個月');
});
test('封存的學生算到最後一堂課', () => {
  const r = W('stdTaughtStats')({ isArchived: true, classes: [{ time: '2025/1/10 1000' }, { time: '2025/3/20 1000' }] });
  assert.deepStrictEqual([r.count, r.text], [2, '2 個月']);
});
test('第一堂不到一個月顯示天數', () => {
  const r = W('stdTaughtStats')({ classes: [{ time: '2026/10/20 1000' }] });
  assert.deepStrictEqual([r.count, r.text], [1, '4 天']);
});


console.log('\nZoom 摘要對應到上課紀錄（日期＋開始時間）');
const zL = (start, uuid) => ({ start, uuid: uuid || start });
const zc = (times, isos, lessons) => W('stdZoomCompute')(times.map(t => ({ time: t })), isos, lessons);
const J = x => JSON.stringify(x);   // 跨 vm 比較物件用
test('開始時間看得懂', () => {
  const f = W('stdZoomStartMin');
  assert.strictEqual(f('12/18 1000-1100'), 600);
  assert.strictEqual(f('3/4 1100'), 660);
  assert.strictEqual(f('3/27 900-1000'), 540);
  assert.strictEqual(f('2025/3/12 2000-2100'), 1200);
  assert.strictEqual(f('沒時間'), null);
  assert.strictEqual(f('3/4'), null);
});
test('同一天、時間差 45 分鐘內 → 對到', () => {
  const r = zc(['10/27 1200-1300'], ['2026-10-27'], [zL('2026-10-27 12:03')]);
  assert.strictEqual(J(r.byRow), J({ 0: 0 }));
  assert.strictEqual(r.unmatched.length, 0);
});
test('剛好 45 分鐘算對到、46 分鐘不算', () => {
  assert.strictEqual(J(zc(['10/27 1200'], ['2026-10-27'], [zL('2026-10-27 11:15')]).byRow), J({ 0: 0 }));
  assert.strictEqual(J(zc(['10/27 1200'], ['2026-10-27'], [zL('2026-10-27 11:14')]).byRow), J({}));
});
test('日期不同 → 對不到，Zoom 那堂列在「沒對到」', () => {
  const r = zc(['10/27 1200'], ['2026-10-27'], [zL('2026-10-28 12:00')]);
  assert.strictEqual(J(r.byRow), J({}));
  assert.strictEqual(r.unmatched.length, 1);
});
test('同一時段對到兩堂 Zoom → 不亂猜，兩堂都列在「沒對到」', () => {
  const r = zc(['10/26 0830-1000'], ['2026-10-26'], [zL('2026-10-26 07:59', 'a'), zL('2026-10-26 08:49', 'b')]);
  assert.strictEqual(J(r.byRow), J({}));
  assert.strictEqual(J(r.unmatched.map(x => x.uuid)), J(['a', 'b']));
});
test('一天兩堂課各自對到自己的 Zoom', () => {
  const r = zc(['10/27 1000', '10/27 1600'], ['2026-10-27', '2026-10-27'], [zL('2026-10-27 16:01'), zL('2026-10-27 09:58')]);
  assert.strictEqual(J(r.byRow), J({ 0: 1, 1: 0 }));
  assert.strictEqual(r.matchedCount, 2);
});
/* ---------- 手機版課程紀錄卡片 ---------- */
const mkCards = (n, f) => Array.from({ length: n }, (_, i) => Object.assign({ time: (i + 1) + '/1 1000', progress: 'p' + i }, f && f(i)));
test('卡片：新的在最下面，預設只展開最近一堂有內容的', () => {
  const p = W('stdCardPlan')(mkCards(3), null, 8, false);
  assert.deepStrictEqual(Array.from(p.shown), [0, 1, 2]);
  assert.strictEqual(p.latest, 2);
  assert.deepStrictEqual(Array.from(p.open), [false, false, true]);
});
test('卡片：完全空白的列收進空白列；待確認、你打開的不收', () => {
  const l = mkCards(4); l[1] = { time: '' }; l[3] = { pending: true };
  const p = W('stdCardPlan')(l, { _n: 4, 1: true }, 8, false);
  assert.ok(Array.from(p.shown).includes(3) && Array.from(p.shown).includes(1));
  const q = W('stdCardPlan')(l, null, 8, false);
  assert.deepStrictEqual(Array.from(q.empty), [1]);
  assert.strictEqual(q.open[3], true);
});
test('卡片：超過一頁只先顯示最新的，其餘算進 more', () => {
  const p = W('stdCardPlan')(mkCards(20), null, 8, false);
  assert.strictEqual(p.shown.length, 8); assert.strictEqual(p.more, 12); assert.strictEqual(p.shown[7], 19); assert.strictEqual(p.shown[0], 12);
});
test('卡片：調整順序時照原順序全部列出', () => {
  const p = W('stdCardPlan')(mkCards(12), null, 8, true);
  assert.deepStrictEqual(Array.from(p.shown), [0,1,2,3,4,5,6,7,8,9,10,11]); assert.strictEqual(p.more, 0);
});
test('卡片：最新日期的列沒內容時，自動跳轉的是最近一堂「有內容」的', () => {
  const l = mkCards(4); l[3] = { time: '12/30 1000' }; l[2] = { time: '10/16 1000' };
  assert.strictEqual(W('stdCardPlan')(l, null, 8, false).latest, 1);
});
test('卡片：明確收合的最新一堂不會被預設值蓋回去', () => {
  const p = W('stdCardPlan')(mkCards(3), { _n: 3, 2: false }, 8, false);
  assert.strictEqual(p.open[2], false);
});

test('日期或時間看不懂的列、沒有 Zoom 的情況都不會出錯', () => {
  assert.strictEqual(J(zc(['abc', '10/27'], [null, '2026-10-27'], [zL('2026-10-27 10:00')]).byRow), J({}));
  const r = zc(['10/27 1000'], ['2026-10-27'], []);
  assert.strictEqual(J([r.byRow, r.unmatched.length, r.matchedCount]), J([{}, 0, 0]));
});

console.log('\n學生頁資料（portal-publish.js）');
const pp = fs.readFileSync(path.join(root, 'portal-publish.js'), 'utf8');
const pctx = vm.createContext({ String, Object, Array, Date, JSON });
vm.runInContext([fn(pp, 'portalIsoAdd'), fn(pp, 'portalTzOf'), fn(pp, 'portalBuildPayload'), fn(pp, 'portalLogOf'), fn(pp, 'portalNextOf'), fn(pp, 'portalTwIso'), fn(pp, 'portalHwRowIndex'), fn(pp, 'portalHwStatusText'), fn(pp, 'portalHwByRow')].join('\n'), pctx);
const P = name => pctx[name];
const PJ = JSON.stringify;
vm.runInContext('stdDb = ' + PJ({
  a: { isArchived: false, basic: { name: 'Pedro', payMode: 'package' }, classes: [
    { time: '2026/9/1 1000-1100', prepaidInput: '4', progress: 'x' }, { time: '2026/9/8 1000-1100', progress: 'x' }, { time: '2026/9/15 1000-1100', progress: 'x' }, { time: '2026/9/22 1000-1100', progress: '沒上課有付錢' }] },
  b: { isArchived: false, basic: { name: 'Liz', payMode: 'single' }, classes: [{ time: '2026/9/1 1000-1100' }] },
  c: { isArchived: false, basic: { name: 'Ana' }, classes: [{ time: '2026/9/1 1000-1100' }] },
  d: { isArchived: true, basic: { name: 'Old' }, classes: [{ time: '2026/1/1 1000-1100', prepaidInput: '9' }] },
  e: { isArchived: false, basic: { name: 'Alberto(MX)', ttKeys: 'Alberto墨西哥' }, classes: [] }
}), web);
const build = (id, extra) => P('portalBuildPayload')(Object.assign({
  id, st: JSON.parse(PJ(vm.runInContext('stdDb', web)[id])), tz: '', occ: [],
  resolve: W('stdResolveTitle'), countdown: s => W('stdCountdownByRow')(s.classes).final, taught: W('stdTaughtStats')
}, extra || {}));
const J2 = x => PJ(JSON.parse(PJ(x)));
test('日期加減：跨月、跨年', () => {
  assert.strictEqual(P('portalIsoAdd')('2026-12-30', 3), '2027-01-02');
  assert.strictEqual(P('portalIsoAdd')('2026-03-01', -1), '2026-02-28');
});
test('所在地 → 時區名稱；沒設定就是空的', () => {
  const list = [{ id: 'mx-city', tz: 'America/Mexico_City' }, { id: 'us-ny-dst', tz: 'America/New_York' }];
  assert.strictEqual(P('portalTzOf')('Pedro', { Pedro: { nat: 'mx-city' } }, list), 'America/Mexico_City');
  assert.strictEqual(P('portalTzOf')('Pedro', { Pedro: {} }, list), '');
  assert.strictEqual(P('portalTzOf')('Nobody', {}, list), '');
});
test('起始上課日期：日期格式正確才帶給學生頁，沒填或格式不對就是空的', () => {
  vm.runInContext('stdDb.a.basic.startDate = "2026-08-01";', web);
  assert.strictEqual(build('a').since, '2026-08-01');
  vm.runInContext('stdDb.a.basic.startDate = "八月";', web);
  assert.strictEqual(build('a').since, '');
  vm.runInContext('delete stdDb.a.basic.startDate;', web);
  assert.strictEqual(build('a').since, '');
});
test('包堂：顯示剩幾堂，已上堂數不含「沒上課有付錢」', () => {
  const r = build('a');
  assert.strictEqual(r.pay, 'package'); assert.strictEqual(r.remaining, 1); assert.strictEqual(r.taught, 3);
});
test('單次付費：不顯示剩幾堂', () => {
  const r = build('b'); assert.strictEqual(r.pay, 'single'); assert.strictEqual(r.remaining, null);
});
test('沒設定付費方式：有預付倒數才當包堂，沒有就留空', () => {
  assert.strictEqual(build('c').pay, ''); assert.strictEqual(build('c').remaining, null);
  const st = { basic: { name: 'X' }, classes: [{ time: '2026/9/1', prepaidInput: '5' }] };
  const r = P('portalBuildPayload')({ id: 'x', st, occ: [], resolve: () => null, countdown: s => W('stdCountdownByRow')(s.classes).final, taught: W('stdTaughtStats') });
  assert.strictEqual(r.pay, 'package'); assert.strictEqual(r.remaining, 5);
});
test('已封存的學生：只留名字，沒有付費和課表', () => {
  assert.strictEqual(J2(build('d')), PJ({ v: 1, name: 'Old', archived: true }));
});
test('課表：只收自己的課；請假標記；整天行程只有「剛好等於姓名」才算；依時間排序', () => {
  const occ = [
    { title: 'Pedro', date: '2026-10-28', startTime: '10:00', endTime: '11:00', allDay: false },
    { title: 'Pedro 初級', date: '2026-10-21', startTime: '09:00', endTime: '10:00', allDay: false, leave: true },
    { title: 'Liz', date: '2026-10-22', startTime: '10:00', endTime: '11:00', allDay: false },
    { title: 'Pedro', date: '2026-10-25', startTime: '', endTime: '', allDay: true },
    { title: 'Pedro 宣傳練習卷', date: '2026-10-26', startTime: '', endTime: '', allDay: true },
    { title: 'Alberto墨西哥', date: '2026-10-27', startTime: '20:00', endTime: '21:00', allDay: false, paidAbsence: true }
  ];
  assert.strictEqual(J2(build('a', { occ }).lessons), PJ([
    { d: '2026-10-21', s: '09:00', e: '10:00', x: 1 }, { d: '2026-10-25', s: '', e: '', x: 1 }, { d: '2026-10-28', s: '10:00', e: '11:00', x: 0 }]));
  assert.strictEqual(J2(build('e', { occ }).lessons), PJ([{ d: '2026-10-27', s: '20:00', e: '21:00', x: 1 }]));   // 標題開頭對應（ttKeys）
});
test('上課紀錄：只留有填課程進度的列；沒上課有付錢、日期看不懂、空白都不放；舊到新；不含作業和備註', () => {
  const classes = [
    { time: '10/3', progress: '把', homework: '秘密作業', price: '500' }, { time: '10/1', progress: '可以' },
    { time: '10/5', progress: '沒上課有付錢' }, { time: '10/6', progress: '  ' }, { time: '??', progress: '亂' }, { time: '10/9', progress: '圖片：延長線', next: '比較句' }];
  const dates = ['2026-10-03', '2026-10-01', '2026-10-05', '2026-10-06', null, '2026-10-09'];
  const log = P('portalLogOf')(classes, dates);
  assert.strictEqual(PJ(JSON.parse(PJ(log))), PJ([{ d: '2026-10-01', p: '可以' }, { d: '2026-10-03', p: '把' }, { d: '2026-10-09', p: '圖片：延長線' }]));
  assert.strictEqual(PJ(log).indexOf('秘密'), -1);
  assert.strictEqual(PJ(JSON.parse(PJ(P('portalNextOf')(classes, dates)))), PJ({ d: '2026-10-09', n: '比較句' }));
  assert.strictEqual(P('portalNextOf')([{ time: 'x' }], [null]), null);
  assert.strictEqual(P('portalLogOf')(undefined, undefined).length, 0);
});
test('上課紀錄：最多 400 筆，留最新的', () => {
  const classes = [], dates = [];
  for(let i = 0; i < 450; i++){ classes.push({ progress: 'p' + i }); dates.push('2026-01-01'.slice(0, 8) + '01'); }
  dates.forEach((_, i) => { dates[i] = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10); });
  const log = P('portalLogOf')(classes, dates);
  assert.strictEqual(log.length, 400); assert.strictEqual(log[399].p, 'p449'); assert.strictEqual(log[0].p, 'p50');
});
test('隱私：給學生頁的欄位只有這幾個，沒有收入、匯款、備註、其他學生', () => {
  assert.strictEqual(Object.keys(build('a')).sort().join(','), 'archived,lessons,log,name,next,pay,remaining,since,taught,tz,v');
  assert.strictEqual(PJ(build('a')).indexOf('Liz'), -1);
});

console.log('\n防止兩個裝置互相蓋掉');
const cloudSrc = between(html, 'const cloudSeenAt = {};', 'function scheduleDocRef(){');
const cctx = { Date: FakeDate, console: { log() {}, warn() {}, error() {} }, document: { getElementById() { return null; }, createElement() { return { style: {}, set innerHTML(v) {} }; }, body: { appendChild() {} } }, Object, JSON };
const cloud = vm.createContext(cctx);
vm.runInContext(cloudSrc, cloud);
console.log('\n作業狀態顯示（portal-publish.js）');
test('台灣日期：UTC 晚上 17:00 已經是台灣隔天', () => {
  assert.strictEqual(P('portalTwIso')(Date.UTC(2026, 10, 10, 17, 0)), '2026-11-11');
  assert.strictEqual(P('portalTwIso')(Date.UTC(2026, 10, 10, 15, 59)), '2026-11-10');
});
test('作業掛哪一堂：發出日期當天或之前最靠近的那一堂', () => {
  const R = P('portalHwRowIndex'), at = (y, m, d, h) => Date.UTC(y, m - 1, d, h || 4);   // UTC 04:00 = 台灣中午
  const rows = ['2026-11-02', '2026-11-09', '2026-11-16'];
  assert.strictEqual(R(at(2026, 11, 11), rows), 1);
  assert.strictEqual(R(at(2026, 11, 9), rows), 1);       // 發出當天剛好有課 → 掛當天
  assert.strictEqual(R(at(2026, 11, 20), rows), 2);
  assert.strictEqual(R(at(2026, 11, 1), rows), 0);       // 比第一堂還早 → 第一堂
});
test('作業掛哪一堂：列順序亂、同一天多堂、沒有日期、沒有課', () => {
  const R = P('portalHwRowIndex'), at = Date.UTC(2026, 10, 11, 4);
  assert.strictEqual(R(at, ['2026-11-16', '2026-11-09', '2026-11-02']), 1);
  assert.strictEqual(R(at, ['2026-11-09', '2026-11-09']), 1);
  assert.strictEqual(R(at, ['2026-11-09', null, '2026-11-20']), 0);
  assert.strictEqual(R(at, [null, null, null]), 2);
  assert.strictEqual(R(at, []), -1);
});
test('作業狀態文字：未交、已交待批改、已批改（含分數）', () => {
  const T = P('portalHwStatusText');
  assert.strictEqual(J2(T({ status: 'todo' })), PJ({ text: '未交', cls: 'todo' }));
  assert.strictEqual(J2(T({ status: 'submitted' })), PJ({ text: '已交，待批改', cls: 'submitted' }));
  assert.strictEqual(J2(T({ status: 'graded', result: { got: 8, max: 11 } })), PJ({ text: '已批改 8/11', cls: 'graded' }));
  assert.strictEqual(T({ status: 'graded' }).text, '已批改');
});
test('一位學生的多份作業：各自掛到對應的課', () => {
  const M = P('portalHwByRow'), rows = ['2026-11-02', '2026-11-09'];
  const m = M([{ wid: 'b', assignedAt: Date.UTC(2026, 10, 10, 4) }, { wid: 'a', assignedAt: Date.UTC(2026, 10, 3, 4) }], rows);
  assert.strictEqual(J2(Object.keys(m)), '["0","1"]');
  assert.strictEqual(m[0][0].wid, 'a'); assert.strictEqual(m[1][0].wid, 'b');
  assert.strictEqual(J2(M([], rows)), '{}');
});

(async () => {
  const db = { x: { updatedAt: 1000 } }, sets = [];
  cctx.window = { firebaseGetDoc: async ref => ({ exists: () => !!db[ref], data: () => db[ref] }), firebaseSetDoc: async (ref, pl) => { db[ref] = pl; sets.push(pl); } };
  const guard = (...a) => vm.runInContext('cloudGuardedSet', cloud)(...a);
  const seen = (...a) => vm.runInContext('cloudNoteSeen', cloud)(...a);
  seen('k', 1000, true);
  await testAsync('正常存檔', async () => { assert.strictEqual(await guard('k', '測試', 'x', { a: 1 }), true); });
  await testAsync('別的裝置剛更新過 → 不存', async () => {
    db.x = { updatedAt: FIXED + 5000 };
    const before = sets.length;
    assert.strictEqual(await guard('k', '測試', 'x', { a: 2 }), false);
    assert.strictEqual(sets.length, before);
  });
  await testAsync('收到最新版之後可以再存', async () => { seen('k', db.x.updatedAt, true); assert.strictEqual(await guard('k', '測試', 'x', { a: 3 }), true); });
  await testAsync('讀不到雲端時間（斷線）仍照常存', async () => {
    cctx.window.firebaseGetDoc = async () => { throw new Error('offline'); };
    assert.strictEqual(await guard('k', '測試', 'x', { a: 4 }), true);
  });

  console.log('\n更新學生頁（portal-publish.js 的寫入流程）');
  {
    const writes = [], deletes = [];
    let remoteIds = ['gone1'];
    const fakeWin = {
      ledgerUid: 'U1', firebaseDb: {},
      firebaseDoc: (db, ...segs) => segs.join('/'), firebaseCollection: (db, ...segs) => segs.join('/'),
      firebaseGetDocs: async () => ({ forEach: f => remoteIds.forEach(id => f({ id })) }),
      firebaseWriteBatch: () => { const ops = []; return { set: (ref, data) => ops.push(['set', ref, data]), delete: ref => ops.push(['del', ref]), commit: async () => ops.forEach(o => (o[0] === 'set' ? writes.push([o[1], o[2]]) : deletes.push(o[1]))) }; },
      ttGetStatus: () => ({ loaded: true, hasData: true }),
      ttGetOccurrencesInRange: () => [{ title: 'Pedro', date: '2026-10-28', startTime: '10:00', endTime: '11:00', allDay: false }]
    };
    web.window = fakeWin; web.document = { getElementById: () => null, visibilityState: 'visible', addEventListener() {} };
    web.setInterval = () => 0; web.setTimeout = () => 0; web.navigator = {}; web.Promise = Promise;
    vm.runInContext([
      fn(html, 'ymdStr'), fn(html, 'renewTodayISO'), fn(html, 'renewCountdownOf'),
      'var stdCloudLoaded = true; var studentInfo = { Pedro: { nat: "mx-city" } }; var TZ_LIST = [{ id: "mx-city", tz: "America/Mexico_City" }];',
      'stdDb = { a: { isArchived: false, basic: { name: "Pedro", payMode: "package" }, classes: [{ time: "2026/9/1 1000-1100", prepaidInput: "4" }] }, b: { isArchived: false, basic: { name: "Liz", payMode: "single" }, classes: [] } };'
    ].join('\n'), web);
    vm.runInContext(fs.readFileSync(path.join(root, 'portal-publish.js'), 'utf8'), web);
    const publish = () => web.window.portalPublishNow();

    fakeWin.ttGetStatus = () => ({ loaded: true, hasData: false });
    await publish();
    await testAsync('TimeTree 還沒同步成功：不寫任何東西（免得把空的課表蓋上去）', async () => {
      assert.strictEqual(writes.length, 0); assert.ok(/TimeTree/.test(web.window.portalStatus.text), web.window.portalStatus.text);
    });
    fakeWin.ttGetStatus = () => ({ loaded: true, hasData: true });
    await publish();
    await testAsync('第一次：每位在學學生寫一份；日誌已經沒有的學生從學生頁清掉', async () => {
      assert.strictEqual(writes.length, 2); assert.deepStrictEqual(deletes, ['portal/U1/students/gone1']);
      assert.strictEqual(writes[0][0], 'portal/U1/students/a');
      assert.strictEqual(writes[0][1].tz, 'America/Mexico_City'); assert.strictEqual(writes[0][1].lessons.length, 1);
      assert.ok(writes[0][1].updatedAt > 0);
    });
    writes.length = 0;
    await publish();
    await testAsync('沒有任何變動：不再寫（省雲端額度）', async () => { assert.strictEqual(writes.length, 0); assert.ok(/最新/.test(web.window.portalStatus.text)); });
    vm.runInContext('stdDb.b.basic.payMode = "package"; stdDb.b.classes = [{ time: "2026/9/1 1000-1100", prepaidInput: "2" }];', web);
    await publish();
    await testAsync('只有 Liz 的付費方式變了：只重寫 Liz 那一份', async () => {
      assert.strictEqual(writes.length, 1); assert.strictEqual(writes[0][0], 'portal/U1/students/b'); assert.strictEqual(writes[0][1].remaining, 2);
    });
    web.console = { log() {}, warn() {}, error() {} };   // 這一項會故意失敗，不要印出一長串錯誤
    fakeWin.firebaseWriteBatch = () => { throw Object.assign(new Error('x'), { code: 'permission-denied' }); };
    vm.runInContext('stdDb.b.basic.payMode = "single";', web);
    await publish();
    await testAsync('規則還沒加（permission-denied）：顯示看得懂的提示，不當掉', async () => { assert.ok(/規則/.test(web.window.portalStatus.text), web.window.portalStatus.text); });

    console.log('\n讀取作業狀態、備課提醒（portal-publish.js）');
    {
      const T0 = Date.UTC(2026, 8, 2, 4);   // 2026/9/2 台灣中午
      const hwDocs = { 'portal/U1/students/a/hw': [
        { id: 'w1', title: '把字句練習', assignedAt: T0, status: 'submitted' },
        { id: 'w2', title: '被字句練習', assignedAt: T0 + 1000, status: 'graded', result: { got: 8, max: 11 } }] };
      fakeWin.firebaseGetDocs = async col => ({ forEach: f => (hwDocs[col] || []).forEach(d => f({ id: d.id, data: () => d })) });
      vm.runInContext([fn(html, 'genMissingPrepReminder'), 'function escapeHtml(s){ return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }'].join('\n') + '\nstdDb.a.classes = [{ time: "2026/9/1 1000-1100", next: "第二課" }];', web);
      const before = vm.runInContext('genMissingPrepReminder()', web).join('');
      await testAsync('還沒讀到作業：最新一堂的作業空白，備課提醒會點名', async () => { assert.ok(/Pedro/.test(before), before); });
      await web.window.portalHwRefresh();
      await testAsync('讀到作業：每位在學學生各讀一次，只存有作業的學生', async () => {
        assert.deepStrictEqual(Object.keys(web.window.portalHw), ['a']); assert.strictEqual(web.window.portalHw.a.length, 2);
        assert.strictEqual(web.window.portalHw.a[0].title, '把字句練習');
      });
      await testAsync('作業掛到發出前最近的那一堂課，狀態文字正確', async () => {
        const m = web.window.portalHwMap('a');
        assert.deepStrictEqual(Object.keys(m), ['0']); assert.strictEqual(m[0].length, 2);
        const h = web.window.portalHwBlockHtml(m[0]);
        assert.ok(h.includes('把字句練習：已交，待批改') && h.includes('被字句練習：已批改 8/11'), h);
        assert.ok(/待批改/.test(web.window.portalHwChipHtml(m[0])));
      });
      await testAsync('學生頁有發作業就算有填：備課提醒不再點名（下次進度有填）', async () => {
        assert.ok(web.window.portalHwOnLastRow('a'));
        assert.ok(!/Pedro/.test(vm.runInContext('genMissingPrepReminder()', web).join('')));
      });
      await testAsync('作業標題有特殊字元：顯示時會被跳脫', async () => {
        const h = web.window.portalHwBlockHtml([{ title: '<b>x</b>', status: 'todo' }]);
        assert.ok(!h.includes('<b>x'), h);
      });
      fakeWin.firebaseGetDocs = async () => { throw Object.assign(new Error('x'), { code: 'permission-denied' }); };
      await web.window.portalHwRefresh();
      await testAsync('規則還沒加：不當掉，之前讀到的狀態還在', async () => { assert.strictEqual(web.window.portalHw.a.length, 2); });
    }
  }

  console.log('\n教材同步（MaterialsSync.gs 的純計算）');
  const MS = (() => { const c = vm.createContext({ String, Object, Array, Math, JSON }); vm.runInContext(['msNormName', 'msMatchFolders', 'msBuildFiles', 'msToFs', 'msBuildDoc'].map(n => fn(ms, n)).join('\n'), c); return n => c[n]; })();
  test('資料夾對學生：大小寫、空白、全形不影響；對不到和同名不猜', () => {
    const r = MS('msMatchFolders')([{ id: '1', name: ' alberto(mx) ' }, { id: '2', name: 'Ａna' }, { id: '3', name: 'Zed' }, { id: '4', name: 'Liz' }],
      { s1: 'Alberto(MX)', s2: 'Ana', s3: 'Liz', s4: 'liz' });
    assert.strictEqual(JSON.stringify(r.matched.map(x => [x.folder.id, x.sid])), JSON.stringify([['1', 's1'], ['2', 's2']]));
    assert.strictEqual(JSON.stringify(r.unmatched), JSON.stringify(['Zed']));
    assert.strictEqual(JSON.stringify(r.ambiguous), JSON.stringify(['Liz']));
  });
  test('資料夾對學生：名字後面多了字（唯一）會對到；對照可手動指定，一個資料夾可對兩位', () => {
    const st = { s1: 'Mirna', s2: 'Anita', s3: 'Alberto(MX)', s4: 'Liz', s5: 'Juan', s6: 'Ana' };
    const r = MS('msMatchFolders')([{ id: '1', name: 'Mirna米娜' }, { id: '2', name: 'Anita西班牙文' }, { id: '3', name: 'Alberto墨西哥' }, { id: '4', name: 'Liz&Juan' }, { id: '5', name: 'Anabel' }], st,
      { 'Alberto墨西哥': 'Alberto(MX)', 'Liz&Juan': ['Liz', 'Juan'] });
    assert.strictEqual(JSON.stringify(r.matched.map(x => [x.folder.id, x.sid])), JSON.stringify([['1', 's1'], ['2', 's2'], ['3', 's3'], ['4', 's4'], ['4', 's5'], ['5', 's6']]));
    const r2 = MS('msMatchFolders')([{ id: '9', name: 'Liz&Juan' }], st);
    assert.strictEqual(JSON.stringify(r2.matched.map(x => x.sid)), JSON.stringify(['s4']));
    const r3 = MS('msMatchFolders')([{ id: '8', name: 'Alberto墨西哥' }], { a: 'Albert', b: 'Alber' });
    assert.strictEqual(JSON.stringify(r3.ambiguous), JSON.stringify(['Alberto墨西哥']));
  });
  test('檔案清單：去掉 .pdf、只收 Google https 連結、新的在前', () => {
    const f = MS('msBuildFiles')([{ name: 'L1.pdf', url: 'https://drive.google.com/file/d/a/view', ms: 10 }, { name: 'L2.PDF', url: 'https://drive.google.com/file/d/b/view', ms: 20 },
      { name: 'x', url: 'http://drive.google.com/x', ms: 99 }, { name: 'y', url: 'https://evil.com/', ms: 99 }, null]);
    assert.strictEqual(JSON.stringify(f.map(x => [x.n, x.t])), JSON.stringify([['L2', 20], ['L1', 10]]));
  });
  test('寫進 Firestore 的格式：數字用 integerValue 字串、陣列和欄位位置正確', () => {
    const d = MS('msBuildDoc')([{ name: 'L1.pdf', url: 'https://drive.google.com/file/d/a/view', ms: 10 }], 123);
    assert.strictEqual(d.fields.updatedAt.integerValue, '123');
    assert.strictEqual(d.fields.v.integerValue, '1');
    const first = d.fields.files.arrayValue.values[0].mapValue.fields;
    assert.strictEqual(first.n.stringValue, 'L1'); assert.strictEqual(first.t.integerValue, '10');
    assert.strictEqual(MS('msBuildDoc')([], 1).fields.files.arrayValue.values.length, 0);
  });

  console.log('\n' + (failed ? '有 ' + failed + ' 項沒通過（通過 ' + passed + ' 項）' : '全部通過（' + passed + ' 項）') + '\n');
  process.exit(failed ? 1 : 0);
})();
