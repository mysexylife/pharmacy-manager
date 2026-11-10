// 엑셀(제약회사 장부 / 외상 장부) 가져오기.
// plan*()는 파일에서 읽기만 하고, commit()이 DB에 쓴다. 환자 정보는 서버 안에서만 오간다.
import { readXlsx, serialToIso } from './xlsx.js';
import { tx, audit } from './db.js';
import { todayKST, addDays, daysBetween } from '../public/dates.js';

// 제약회사가 아닌 시트
const NOT_VENDOR = new Set([
  '종합', '셀메드10+2', '제약반품차용', '제약찬조', '제품가격비교', '셀메드처방', '유효기간확인',
  '환자 외상 장부', '병원외상장부', '셀메드 창고 입출고 내역', '셀메드 재고 현황', '창고 재고', '주문 필요 상품 리스트',
]);
// 정산이 끝났거나 쓰지 않는 제약회사
const EXCLUDED = new Set(['녹십자', '오스틴(구룡)', '오스틴', '중외', '하나', '동아제약', '부광', '삼진']);
// 시트 이름 → 푸른약국에서 쓸 이름
const RENAME = { 고려: '고려제약', 가오: '가오약품', 종근당: '종근당(일반)' };
const HOSPITAL = '한사랑의원';

const text = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const n = Number(v.replace(/[,\s원]/g, ''));
  return v.trim() !== '' && Number.isFinite(n) ? Math.round(n) : null;
};
const isoOf = (v) => (typeof v === 'number' ? serialToIso(v) : null);

// 머리글 행을 찾아 {열 이름: 열 번호}를 만든다 (열 위치는 시트마다 다르다).
function header(sheet, mustHave) {
  for (const [rowNo, cells] of sheet.rows) {
    if (rowNo > 15) break;
    const cols = {};
    for (const [c, v] of cells) if (typeof v === 'string') cols[v.replace(/\s+/g, '')] ??= c;
    if (mustHave.every((k) => k in cols)) return { rowNo, cols };
  }
  return null;
}

// above: 머리글 위에 잘못 적힌 거래 줄(날짜와 금액이 있는 줄)도 함께 읽는다.
function* dataRows(sheet, rowNo, { above = null } = {}) {
  const isEntry = (cells) => above
    && [above.inn, above.pay].some((c) => typeof cells.get(c) === 'number')
    && [above.date, above.date2].some((c) => c != null && serialToIso(cells.get(c)));
  const nos = [...sheet.rows.keys()]
    .filter((n) => n > rowNo || (n < rowNo && isEntry(sheet.rows.get(n))))
    .sort((a, b) => a - b);
  for (const n of nos) yield [n, sheet.rows.get(n)];
}

// 연도 칸을 잘못 적은 줄(예: 1월에도 작년 그대로, 또는 한 줄만 엉뚱한 해)을 바로잡는다.
// 줄마다 연도를 -1/0/+1 옮겨 보고, "날짜가 크게 뒤로 가거나 앞서 나가는 곳"과 "연도를 바꾸는 횟수"가
// 가장 적은 조합을 고른다 (비터비). 고친 줄 목록을 돌려준다.
function fixYears(rows) {
  const todayIso = todayKST();
  const idx = rows.map((r, i) => (r.date ? i : -1)).filter((i) => i >= 0);
  if (idx.length < 2) return [];
  const shifts = [-1, 0, 1];
  const shifted = (iso, k) => `${Number(iso.slice(0, 4)) + k}${iso.slice(4)}`;
  const link = (a, b) => {
    const gap = daysBetween(a, b);
    return (gap < -90 ? 3 : 0) + (gap > 200 ? 3 : 0);
  };
  let cost = shifts.map((k) => (k === 0 ? 0 : 1) + (shifted(rows[idx[0]].date, k) > todayIso ? 5 : 0));
  const back = [];
  for (let n = 1; n < idx.length; n++) {
    const prevDate = (k) => shifted(rows[idx[n - 1]].date, k);
    const next = [];
    const from = [];
    shifts.forEach((k, j) => {
      const here = shifted(rows[idx[n]].date, k);
      let best = Infinity;
      let arg = 0;
      shifts.forEach((pk, pj) => {
        const c = cost[pj] + (pj === j ? 0 : 1) + link(prevDate(pk), here);
        if (c < best) { best = c; arg = pj; }
      });
      next.push(best + (here > todayIso ? 5 : 0));
      from.push(arg);
    });
    cost = next;
    back.push(from);
  }
  let j = cost.indexOf(Math.min(...cost));
  const fixed = [];
  for (let n = idx.length - 1; n >= 0; n--) {
    const r = rows[idx[n]];
    if (shifts[j] !== 0) fixed.push({ rowNo: r.rowNo, from: r.date, date: shifted(r.date, shifts[j]), r });
    if (n > 0) j = back[n - 1][j];
  }
  fixed.reverse();
  for (const f of fixed) f.r.date = f.date;
  return fixed;
}

// 결제란 줄 중 결제·할인·정정이 아니라 상품명이 적힌 줄은 반품이다.
const NOT_RETURN = /결[제재]|할인|보정|약가인하|정정|수금|패스|조정|입금|송금|에누리|이월/;
const isReturnLike = (desc) => /반품/.test(desc) || (desc !== '' && !NOT_RETURN.test(desc));

// ---- 제약회사 ----------------------------------------------------------
function planVendorSheet(sheet) {
  const head = header(sheet, ['입고액', '결제액', '잔고']);
  if (!head) return null;
  const { cols } = head;
  const dateCol = cols['입고일계산'] ?? cols['입고일'];
  const warnings = [];
  const yearFixes = [];
  const raw = [];
  let prev = null;
  for (const [rowNo, cells] of dataRows(sheet, head.rowNo, { above: { inn: cols['입고액'], pay: cols['결제액'], date: cols['입고일계산'], date2: cols['입고일'] } })) {
    const desc = text(cells.get(cols['내용']));
    const inn = num(cells.get(cols['입고액']));
    const pay = num(cells.get(cols['결제액']));
    const bal = num(cells.get(cols['잔고']));
    if (!desc && inn == null && pay == null) continue;
    let date = isoOf(cells.get(dateCol)) ?? isoOf(cells.get(cols['입고일']));
    if (!date) {
      date = prev;
      warnings.push(`행 ${rowNo}: 날짜가 없어 앞 행의 날짜(${prev ?? '없음'})로 넣었습니다`);
    }
    if (date) prev = date;
    raw.push({ rowNo, desc, inn, pay, bal, date });
  }
  for (const r of fixYears(raw)) yearFixes.push(`행 ${r.rowNo}: ${r.from} → ${r.date}`);
  const firstDate = raw.map((r) => r.date).filter(Boolean).sort()[0] ?? todayKST();
  for (const r of raw) r.date ??= firstDate;

  // 이월(시작 잔고)
  let opening = null;
  const body = [];
  for (const r of raw) {
    if (/^이월/.test(r.desc) && r.inn == null && r.pay == null) {
      if (opening == null && r.bal != null) opening = r.bal;
      continue;
    }
    body.push(r);
  }
  const delta = (r) => (r.inn ?? 0) - (r.pay ?? 0);
  if (opening == null) {
    let cum = 0;
    for (const r of body) {
      cum += delta(r);
      if (r.bal != null) { opening = r.bal - cum; break; }
    }
    opening ??= 0;
  }

  const entries = [];
  const returns = [];
  let sum = opening;
  for (const r of body) {
    const isReturn = r.inn != null && (r.inn < 0 || (/반품/.test(r.desc) && r.inn > 0));
    if (isReturn) {
      const amount = Math.abs(r.inn);
      returns.push({ date: r.date, item: r.desc.replace(/^반품\s*/, '').trim() || r.desc, amount });
      sum -= amount;
    } else if (r.inn) {
      entries.push({ date: r.date, kind: 'purchase', description: r.desc || '입고', amount: r.inn });
      sum += r.inn;
    }
    if (r.pay > 0 && (/반품/.test(r.desc) || (!r.inn && isReturnLike(r.desc)))) {
      // 결제란에 상품명(또는 "…반품")이 적힌 줄은 반품으로 본다
      returns.push({ date: r.date, item: r.desc.replace(/반품/g, '').trim() || r.desc, amount: r.pay });
      sum -= r.pay;
    } else if (r.pay) {
      const label = /결[제재]/.test(r.desc) ? '결제' : r.desc || '결제';
      if (r.pay > 0) entries.push({ date: r.date, kind: 'payment', description: label, amount: r.pay });
      else entries.push({ date: r.date, kind: 'adjust', description: label, amount: -r.pay });
      sum -= r.pay;
    }
  }
  const lastRow = [...body].reverse().find((r) => r.bal != null);
  return {
    sheet: sheet.name,
    opening, openingDate: firstDate,
    entries, returns,
    computed: sum,
    excel: lastRow?.bal ?? null,
    lastDate: lastRow?.date ?? firstDate,
    warnings, yearFixes,
  };
}

export function planVendors(sheets) {
  const vendors = [];
  const skipped = [];
  for (const s of sheets) {
    const key = s.name.trim();
    if (NOT_VENDOR.has(key)) continue;
    if (EXCLUDED.has(key)) { skipped.push({ sheet: key, reason: '제외 대상' }); continue; }
    const p = planVendorSheet(s);
    if (!p) { skipped.push({ sheet: key, reason: '장부 형식이 아님' }); continue; }
    vendors.push({ ...p, name: RENAME[key] ?? key });
  }
  return { vendors, skipped };
}

// ---- 병원 --------------------------------------------------------------
export function planHospital(sheets) {
  const s = sheets.find((x) => x.name.trim() === '병원외상장부');
  const head = s && header(s, ['외상액', '결제액', '잔고']);
  if (!head) return null;
  const { cols } = head;
  const dateCol = cols['날짜'];
  const itemCol = cols['환자명/품목명'];
  const warnings = [];
  const raw = [];
  let prev = null;
  for (const [rowNo, cells] of dataRows(s, head.rowNo)) {
    const item = text(cells.get(itemCol));
    const bill = num(cells.get(cols['외상액']));
    const paid = num(cells.get(cols['결제액']));
    const bal = num(cells.get(cols['잔고']));
    if (!item && bill == null && paid == null) continue;
    let date = isoOf(cells.get(dateCol)) ?? isoOf(cells.get(cols['입고일계산']));
    if (!date) { date = prev; warnings.push(`행 ${rowNo}: 날짜가 없어 앞 행의 날짜(${prev ?? '없음'})로 넣었습니다`); }
    if (date) prev = date;
    raw.push({ rowNo, item, qty: num(cells.get(cols['수량'])), bill, paid, bal, date });
  }
  const firstDate = raw.map((r) => r.date).filter(Boolean).sort()[0] ?? todayKST();
  for (const r of raw) r.date ??= firstDate;
  const delta = (r) => (r.bill ?? 0) - (r.paid ?? 0);
  let opening = null;
  let cum = 0;
  for (const r of raw) {
    cum += delta(r);
    if (r.bal != null) { opening = r.bal - cum; break; }
  }
  opening ??= 0;
  const entries = [];
  let sum = opening;
  for (const r of raw) {
    if (r.bill) {
      entries.push(r.bill > 0
        ? { date: r.date, kind: 'otc', item: r.item || '외상', qty: r.qty, billed: r.bill, paid: 0 }
        : { date: r.date, kind: 'adjust', item: r.item || '조정', qty: null, billed: r.bill, paid: 0 });
      sum += r.bill;
    }
    if (r.paid) {
      entries.push({ date: r.date, kind: 'payment', item: /결[제재]/.test(r.item) ? '결제' : r.item || '결제', qty: null, billed: 0, paid: r.paid });
      sum -= r.paid;
    }
  }
  const last = [...raw].reverse().find((r) => r.bal != null);

  // 오른쪽 제품 가격표 (제품명 칸에 "노블루겔8000"처럼 가격이 붙어 있으면 떼어 낸다)
  const products = [];
  if (cols['제품명'] != null && cols['할인가격'] != null) {
    for (const [, cells] of dataRows(s, head.rowNo)) {
      const price = num(cells.get(cols['할인가격']));
      let name = text(cells.get(cols['제품명']));
      if (!name || !price) continue;
      if (name.endsWith(String(price)) && name.length > String(price).length) name = name.slice(0, -String(price).length).trim();
      if (!products.some((p) => p.name === name)) products.push({ name, price });
    }
  }
  return { name: HOSPITAL, opening, openingDate: firstDate, entries, products, computed: sum, excel: last?.bal ?? null, lastDate: last?.date ?? firstDate, warnings };
}

// ---- 환자 외상 -----------------------------------------------------------
const checked = (v) => /^\s*o\s*$/i.test(String(v ?? ''));

export function planCredits(sheets) {
  const s = sheets.find((x) => x.name.trim() === '환자 외상 장부');
  const head = s && header(s, ['환자명/품목명', '외상액']);
  if (!head) return null;
  const { cols } = head;
  const rows = [];
  const warnings = [];
  let prev = null;
  for (const [rowNo, cells] of dataRows(s, head.rowNo)) {
    const name = text(cells.get(cols['환자명/품목명']));
    const amount = num(cells.get(cols['외상액']));
    if (text(cells.get(cols['연도'])) === '예시' || name === 'ㅁㅁㅁ') continue; // 작성 예시 줄
    if (!name && amount == null) continue;
    if (!name || !amount) { warnings.push(`행 ${rowNo}: 이름 또는 금액이 비어 있어 건너뜀`); continue; }
    let date = isoOf(cells.get(cols['날짜'])) ?? isoOf(cells.get(cols['입고일계산']));
    if (!date) { date = prev; warnings.push(`행 ${rowNo}: 날짜가 없어 앞 행의 날짜(${prev ?? '없음'})로 넣었습니다`); }
    if (date) prev = date;
    const memoRaw = cells.get(cols['고객메모장작성여부']);
    const rrn = text(cells.get(cols['주민번호앞자리'])).replace(/\D/g, '');
    const note = [text(cells.get(cols['비고'])), checked(memoRaw) || /^x$/i.test(text(memoRaw)) || !text(memoRaw) ? '' : text(memoRaw)].filter(Boolean).join(' / ');
    const paid = checked(cells.get(cols['완불체크']));
    rows.push({
      date: date ?? todayKST(), name, rrn_front: /^\d{6}$/.test(rrn) ? rrn : '', content: text(cells.get(cols['외상내용'])),
      amount, memo_done: checked(memoRaw) ? 1 : 0, paid: paid ? 1 : 0, note,
    });
  }
  return { rows, warnings };
}

// ---- 전체 계획(요약) -----------------------------------------------------
export function buildPlan(buffers) {
  const sheets = buffers.flatMap((b) => readXlsx(b));
  return { ...planVendors(sheets), hospital: planHospital(sheets), credits: planCredits(sheets) };
}

export function summarize(plan) {
  const sum = (a) => a.reduce((n, x) => n + x.amount, 0);
  return {
    vendors: plan.vendors.map((v) => ({
      sheet: v.sheet, name: v.name, entries: v.entries.length, returns: v.returns.length,
      opening: v.opening, computed: v.computed, excel: v.excel,
      mismatch: v.excel != null && v.excel !== v.computed,
      diff: v.excel != null ? v.excel - v.computed : 0,
      warnings: v.warnings.slice(0, 20), yearFixes: v.yearFixes.length, yearFixSamples: v.yearFixes.slice(0, 3),
    })),
    skipped: plan.skipped,
    hospital: plan.hospital && {
      entries: plan.hospital.entries.length, products: plan.hospital.products.length,
      opening: plan.hospital.opening, computed: plan.hospital.computed, excel: plan.hospital.excel,
      mismatch: plan.hospital.excel != null && plan.hospital.excel !== plan.hospital.computed,
      warnings: plan.hospital.warnings,
    },
    credits: plan.credits && {
      rows: plan.credits.rows.length, open: plan.credits.rows.filter((r) => !r.paid).length,
      openTotal: sum(plan.credits.rows.filter((r) => !r.paid)), warnings: plan.credits.warnings,
    },
  };
}

// ---- DB에 쓰기 -----------------------------------------------------------
export function commit(db, plan, { useComputed = [] } = {}) {
  const result = { vendors: 0, entries: 0, skippedExisting: [], hospital: false, credits: 0 };
  tx(db, () => {
    for (const v of plan.vendors) {
      const found = db.prepare('SELECT id FROM vendors WHERE name = ?').get(v.name);
      let vendorId = found?.id;
      if (vendorId && db.prepare('SELECT 1 FROM vendor_entries WHERE vendor_id = ? LIMIT 1').get(vendorId)) {
        result.skippedExisting.push(v.name);
        continue;
      }
      vendorId ??= Number(db.prepare('INSERT INTO vendors (name, sort) VALUES (?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM vendors))').run(v.name).lastInsertRowid);
      const ins = db.prepare('INSERT INTO vendor_entries (vendor_id, date, kind, description, amount, return_id) VALUES (?, ?, ?, ?, ?, ?)');
      if (v.opening) ins.run(vendorId, v.openingDate, 'adjust', '이월', v.opening, null);
      for (const e of v.entries) ins.run(vendorId, e.date, e.kind, e.description, e.amount, null);
      for (const r of v.returns) {
        const rid = Number(db.prepare('INSERT INTO vendor_returns (vendor_id, date, item, amount, done, done_date) VALUES (?, ?, ?, ?, 1, ?)')
          .run(vendorId, r.date, r.item, r.amount, r.date).lastInsertRowid);
        ins.run(vendorId, r.date, 'return', `반품 ${r.item}`, r.amount, rid);
      }
      if (v.excel != null && v.excel !== v.computed && !useComputed.includes(v.sheet)) {
        ins.run(vendorId, v.lastDate, 'adjust', '조정(엑셀 잔고 기준)', v.excel - v.computed, null);
      }
      result.vendors++;
      result.entries += v.entries.length + v.returns.length + 1;
    }
    const h = plan.hospital;
    if (h) {
      db.prepare('INSERT OR IGNORE INTO hospitals (name) VALUES (?)').run(h.name);
      const hid = db.prepare('SELECT id FROM hospitals WHERE name = ?').get(h.name).id;
      if (db.prepare('SELECT 1 FROM hospital_entries WHERE hospital_id = ? LIMIT 1').get(hid)) {
        result.skippedExisting.push(h.name);
      } else {
        const ins = db.prepare('INSERT INTO hospital_entries (hospital_id, date, kind, item, qty, billed, paid) VALUES (?, ?, ?, ?, ?, ?, ?)');
        if (h.opening) ins.run(hid, h.openingDate, 'adjust', '이월', null, h.opening, 0);
        for (const e of h.entries) ins.run(hid, e.date, e.kind, e.item, e.qty, e.billed, e.paid);
        if (h.excel != null && h.excel !== h.computed) ins.run(hid, h.lastDate, 'adjust', '조정(엑셀 잔고 기준)', null, h.excel - h.computed, 0);
        const prod = db.prepare('INSERT OR IGNORE INTO hospital_products (name, price) VALUES (?, ?)');
        for (const p of h.products) prod.run(p.name, p.price);
        result.hospital = true;
      }
    }
    const c = plan.credits;
    if (c && !db.prepare('SELECT 1 FROM credits LIMIT 1').get()) {
      const ins = db.prepare(`INSERT INTO credits (date, name, rrn_front, content, amount, memo_done, paid, paid_date, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of c.rows) ins.run(r.date, r.name, r.rrn_front, r.content, r.amount, r.memo_done, r.paid, r.paid ? r.date : null, r.note);
      result.credits = c.rows.length;
    } else if (c) {
      result.skippedExisting.push('환자 외상');
    }
    audit(db, 'import', JSON.stringify({ vendors: result.vendors, credits: result.credits, hospital: result.hospital }));
  });
  return result;
}
