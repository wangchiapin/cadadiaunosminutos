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
  const rows = [{ time: '2026/10/1 1000', prepaidInput: '4' }, { time: '2026/10/15 1000' }, { time: '2026/10/8 1000' }];
  assert.strictEqual(W('stdCountdownByRow')(rows).final, 2);
  assert.deepStrictEqual(Array.from(W('stdCountdownByRow')(rows).at), [4, 2, 3]);
});
test('週報的倒數跟網頁一致', () => {
  const st = { classes: [{ time: '2026/9/1 1000', prepaidInput: '3' }, { time: '2026/9/8 1000' }, { time: '2026/9/15 1000' }] };
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

console.log('\n防止兩個裝置互相蓋掉');
const cloudSrc = between(html, 'const cloudSeenAt = {};', 'function scheduleDocRef(){');
const cctx = { Date: FakeDate, console: { log() {}, warn() {}, error() {} }, document: { getElementById() { return null; }, createElement() { return { style: {}, set innerHTML(v) {} }; }, body: { appendChild() {} } }, Object, JSON };
const cloud = vm.createContext(cctx);
vm.runInContext(cloudSrc, cloud);
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

  console.log('\n' + (failed ? '有 ' + failed + ' 項沒通過（通過 ' + passed + ' 項）' : '全部通過（' + passed + ' 項）') + '\n');
  process.exit(failed ? 1 : 0);
})();
