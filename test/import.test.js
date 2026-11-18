import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { openDb } from '../src/db.js';
import { buildPlan, commit, summarize } from '../src/import.js';

// 테스트용 xlsx를 직접 만든다 (압축 없는 zip).
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    parts.push(head, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const col = (i) => String.fromCharCode(65 + i);
function sheetXml(rows) {
  return `<worksheet><sheetData>${rows.map((cells, r) => `<row r="${r + 1}">${cells.map((v, i) => {
    if (v == null) return '';
    const ref = `${col(i)}${r + 1}`;
    return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  }).join('')}</row>`).join('')}</sheetData></worksheet>`;
}

const D = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000) + 25569;

function book(sheets) {
  const files = {
    'xl/workbook.xml': `<workbook><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows); });
  return zip(files);
}

const HEAD = [null, '연도', '입고일계산', '내용', '입고액', '결제액', '잔고'];

test('제약회사 시트: 이월·반품·결제·잔고 대조', () => {
  const buf = book([
    {
      name: ' 고려',
      rows: [[], [], [], [], HEAD,
        [null, 2025, D('2025-03-01'), '이월', null, null, 1000],
        [null, 2025, D('2025-03-05'), '약A', 500, null, 1500],
        [null, 2025, D('2025-03-06'), '반품 약A', -100, null, 1400],
        [null, 2025, D('2025-03-10'), '결재', null, 300, 1100],
        [null, 2025, D('2025-03-12'), '약B', 200, 100, 1200],
        [null, 2025, D('2025-03-13'), '약C', 50, null, 9999]],
    },
    { name: '녹십자', rows: [HEAD, [null, 2025, D('2025-03-01'), '약', 1, null, 1]] },
  ]);
  const plan = buildPlan([buf]);
  assert.equal(plan.vendors.length, 1);
  assert.equal(plan.skipped[0].sheet, '녹십자');
  const v = plan.vendors[0];
  assert.equal(v.name, '고려제약');
  assert.equal(v.opening, 1000);
  assert.equal(v.returns.length, 1);
  assert.equal(v.computed, 1250); // 1000+500-100-300+200-100+50
  assert.equal(v.excel, 9999);
  assert.equal(summarize(plan).vendors[0].mismatch, true);

  const db = openDb(':memory:');
  commit(db, plan);
  const bal = db.prepare(`SELECT SUM(CASE kind WHEN 'purchase' THEN amount WHEN 'adjust' THEN amount ELSE -amount END) b FROM vendor_entries`).get().b;
  assert.equal(bal, 9999); // 엑셀의 마지막 잔고에 맞춘다
  assert.ok(db.prepare("SELECT 1 FROM vendor_entries WHERE description = '결제'").get());
  assert.equal(db.prepare('SELECT done FROM vendor_returns').get().done, 1);
  assert.deepEqual(commit(db, plan).skippedExisting, ['고려제약']); // 두 번 넣어도 겹치지 않는다

  const db2 = openDb(':memory:');
  commit(db2, plan, { useComputed: [v.sheet] });
  assert.equal(db2.prepare(`SELECT SUM(CASE kind WHEN 'purchase' THEN amount WHEN 'adjust' THEN amount ELSE -amount END) b FROM vendor_entries`).get().b, 1250);
});

test('이월 줄이 없으면 첫 잔고에서 시작 잔고를 거꾸로 구한다', () => {
  const buf = book([{ name: '신규', rows: [HEAD, [null, 2025, D('2025-01-02'), '약', 100, null, 600], [null, 2025, D('2025-01-03'), '결제', null, 50, 550]] }]);
  const v = buildPlan([buf]).vendors[0];
  assert.equal(v.opening, 500);
  assert.equal(v.computed, 550);
  assert.equal(v.excel, 550);
});

test('연도 칸이 늦게 바뀐 줄은 1년 뒤로 보정한다', () => {
  const buf = book([{ name: '연도', rows: [HEAD,
    [null, 2025, D('2025-12-20'), '약', 100, null, 100],
    [null, 2025, D('2025-01-05'), '약', 100, null, 200]] }]);
  const v = buildPlan([buf]).vendors[0];
  assert.equal(v.entries[1].date, '2026-01-05');
  assert.equal(v.yearFixes.length, 1);
});

test('엉뚱한 해로 적힌 한 줄이 뒤의 날짜를 밀어내지 않는다', () => {
  const buf = book([{ name: '단일', rows: [HEAD,
    [null, 2024, D('2024-10-18'), '약', 100, null, 100],
    [null, 2025, D('2025-10-24'), '결제', null, 10, 90], // 2024-10-24의 오타
    [null, 2024, D('2024-12-04'), '약', 100, null, 190],
    [null, 2025, D('2025-01-10'), '약', 100, null, 290]] }]);
  const v = buildPlan([buf]).vendors[0];
  assert.deepEqual(v.entries.map((e) => e.date), ['2024-10-18', '2024-10-24', '2024-12-04', '2025-01-10']);
});

test('결제란에 반품이라고 적힌 줄은 반품으로 옮긴다', () => {
  const buf = book([{ name: '반품시트', rows: [HEAD,
    [null, 2025, D('2025-01-02'), '약', 1000, null, 1000],
    [null, 2025, D('2025-01-05'), '바이락스반품', null, 100, 900],
    [null, 2025, D('2025-01-06'), '결제', null, 200, 700]] }]);
  const v = buildPlan([buf]).vendors[0];
  assert.equal(v.returns.length, 1);
  assert.equal(v.returns[0].item, '바이락스');
  assert.equal(v.entries.filter((e) => e.kind === 'payment').length, 1);
  assert.equal(v.computed, 700);
});

test('결제란에 상품명이 적힌 줄은 반품, 할인·정정 줄은 그대로 둔다', () => {
  const buf = book([{ name: '상품명', rows: [HEAD,
    [null, 2025, D('2025-01-02'), '약', 1000, null, 1000],
    [null, 2025, D('2025-01-05'), '레스큐라이트', null, 100, 900],
    [null, 2025, D('2025-01-06'), '매출할인', null, 10, 890],
    [null, 2025, D('2025-01-07'), '결재', null, 90, 800]] }]);
  const v = buildPlan([buf]).vendors[0];
  assert.deepEqual(v.returns.map((r) => r.item), ['레스큐라이트']);
  assert.deepEqual(v.entries.filter((e) => e.kind === 'payment').map((e) => e.description), ['매출할인', '결제']);
  assert.equal(v.computed, 800);
});

test('reset: 기존 장부 내역을 지우고 새로 가져오되, 제약회사 회전 개월 수는 남긴다', () => {
  const buf1 = book([{ name: '고려', rows: [HEAD, [null, 2025, D('2025-03-05'), '약A', 500, null, 500]] }]);
  const buf2 = book([{ name: '고려', rows: [HEAD, [null, 2025, D('2025-04-01'), '약B', 700, null, 700]] }]);
  const db = openDb(':memory:');
  commit(db, buildPlan([buf1]));
  db.prepare("UPDATE vendors SET rotation_months = 4 WHERE name = '고려제약'").run();
  db.prepare("INSERT INTO credits (date, name, amount) VALUES ('2026-01-01', '시험', 100)").run();
  // reset 없이는 이미 있는 제약회사를 건너뛴다
  assert.deepEqual(commit(db, buildPlan([buf2])).skippedExisting, ['고려제약']);
  const r = commit(db, buildPlan([buf2]), { reset: true });
  assert.equal(r.reset, true);
  const items = db.prepare('SELECT description FROM vendor_entries').all().map((x) => x.description);
  assert.deepEqual(items, ['약B']);
  assert.equal(db.prepare("SELECT rotation_months FROM vendors WHERE name = '고려제약'").get().rotation_months, 4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM credits').get().n, 0);
});

test('reset 중 가져오기가 실패하면 지운 것도 되돌린다', () => {
  const buf1 = book([{ name: '고려', rows: [HEAD, [null, 2025, D('2025-03-05'), '약A', 500, null, 500]] }]);
  const db = openDb(':memory:');
  commit(db, buildPlan([buf1]));
  const bad = buildPlan([buf1]);
  bad.vendors[0].entries[0].kind = 'broken'; // CHECK 제약에 걸려 실패
  assert.throws(() => commit(db, bad, { reset: true }));
  assert.deepEqual(db.prepare('SELECT description FROM vendor_entries').all().map((x) => x.description), ['약A']); // 지운 것도 취소되어 그대로
});

const HHEAD = [null, null, '입고일계산', '연도', '날짜', '환자명/품목명', '수량', '외상액', '결제액', '잔고'];
const hrow = (iso, item, qty, bill, paid, bal) => [null, null, D(iso), 2025, D(iso), item, qty, bill, paid, bal];

test('병원 외상: 같은 줄의 5,000원 결제는 할인액으로, 금액 없는 품목 줄도 가져온다', () => {
  const buf = book([{ name: ' 병원외상장부', rows: [[], [], [], [], [], HHEAD,
    hrow('2025-11-01', '이월', null, null, null, 100000),
    hrow('2025-11-02', '한상근 조제', null, 61600, 5000, 156600),   // 5,000원 = 할인
    hrow('2025-11-03', '타이레놀', '5정', null, null, 156600),      // 금액 없는 줄
    hrow('2025-11-04', '파스', null, 44000, 10000, 190600),         // 5,000원이 아닌 결제는 결제로
    hrow('2025-11-05', '결제', null, null, 20000, 170600)] }]);
  const h = buildPlan([buf]).hospital;
  const rx = h.entries.find((e) => e.item === '한상근 조제');
  assert.deepEqual([rx.kind, rx.original, rx.discount, rx.billed, rx.paid], ['rx', 61600, 5000, 56600, 0]);
  assert.ok(h.entries.some((e) => e.item === '타이레놀 5정' && e.qty === 5 && e.billed === 0 && e.paid === 0));
  assert.equal(h.entries.filter((e) => e.kind === 'payment').map((e) => e.paid).join(), '10000,20000');
  assert.equal(h.computed, 170600);
  assert.equal(h.excel, 170600); // 잔고는 엑셀과 그대로 일치

  const db = openDb(':memory:');
  commit(db, buildPlan([buf]));
  const row = db.prepare("SELECT kind, original, discount, billed FROM hospital_entries WHERE item = '한상근 조제'").get();
  assert.deepEqual([row.kind, row.original, row.discount, row.billed], ['rx', 61600, 5000, 56600]);
  assert.equal(db.prepare('SELECT SUM(billed - paid) b FROM hospital_entries').get().b, 170600);
});
