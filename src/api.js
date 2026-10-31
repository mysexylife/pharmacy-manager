import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audit, tx, getSetting, setSetting, DEFAULT_SETTINGS } from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, destroyOtherSessions,
} from './auth.js';
import {
  parseDate, todayKST, addMonths, endOfMonth, daysBetween, monthOf, formatDate,
} from '../public/dates.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- 입력 검사 -------------------------------------------------------
function date(v, label = '날짜') {
  const iso = parseDate(typeof v === 'string' ? v : '', todayKST());
  if (!iso) throw new HttpError(400, `${label} 형식이 올바르지 않습니다 (예: 26.10.31)`);
  return iso;
}

function money(v, label, { signed = false, optional = false, blank } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    if (blank !== undefined) return blank;
    throw new HttpError(400, `${label}을(를) 입력하세요`);
  }
  const n = typeof v === 'string' ? Number(v.replace(/[,\s원]/g, '')) : v;
  if (!Number.isSafeInteger(n)) throw new HttpError(400, `${label}은(는) 숫자(정수)여야 합니다`);
  if (!signed && n < 0) throw new HttpError(400, `${label}은(는) 0 이상이어야 합니다`);
  return n;
}

function str(v, label, { required = false, max = 200 } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${label}을(를) 입력하세요`);
  if (s.length > max) throw new HttpError(400, `${label}이(가) 너무 깁니다`);
  return s;
}

const flag = (v) => (v ? 1 : 0);
const id = (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, '찾을 수 없습니다');
  return n;
};
const now = () => new Date().toISOString();
const must = (row) => {
  if (!row) throw new HttpError(404, '찾을 수 없습니다');
  return row;
};

function password(v) {
  if (typeof v !== 'string' || v.length < 10) throw new HttpError(400, '비밀번호는 10자 이상이어야 합니다');
  return v;
}

// 잔고에 미치는 영향: 입고·조정은 더하고, 반품·결제는 뺀다.
const VENDOR_DELTA = `CASE kind WHEN 'purchase' THEN amount WHEN 'adjust' THEN amount ELSE -amount END`;

function uniqueName(fn) {
  try {
    return fn();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, '이미 있는 이름입니다');
    throw e;
  }
}

// ---- 장부 계산 -----------------------------------------------------------
// 날짜순으로 쌓아 잔고를 구한 뒤, from 이전 내역은 "이전 잔액" 한 줄로 접는다.
function foldLedger(rows, deltaOf, from) {
  let balance = 0;
  const all = rows.map((r) => ({ ...r, balance: (balance += deltaOf(r)) }));
  let start = from ? all.findIndex((e) => e.date >= from) : 0;
  if (start === -1) start = all.length;
  return {
    entries: all.slice(start).reverse(), // 화면에는 최근 것이 위에 온다
    opening: start > 0 ? all[start - 1].balance : 0,
    hasEarlier: start > 0,
    balance,
  };
}

function fromParam(query) {
  return query.get('from') ? date(query.get('from'), '시작 날짜') : null;
}

export function buildRoutes(db, ctx = {}) {
  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const q = (sql) => db.prepare(sql);

  const vendor = (v) => must(q('SELECT * FROM vendors WHERE id = ?').get(id(v)));
  const hospital = (v) => must(q('SELECT * FROM hospitals WHERE id = ?').get(id(v)));

  // ---- 제약회사: 목록용 요약 ------------------------------------------
  function pendingCounts() {
    const returns = q(`SELECT vendor_id, COUNT(*) AS n FROM vendor_returns
      WHERE done = 0 AND deleted_at IS NULL GROUP BY vendor_id`).all();
    const loans = q(`SELECT vendor_id, COUNT(*) AS n FROM vendor_loans
      WHERE returned = 0 AND deleted_at IS NULL GROUP BY vendor_id`).all();
    const notes = q(`SELECT vendor_id, COUNT(*) AS n FROM vendor_notes
      WHERE done = 0 AND deleted_at IS NULL GROUP BY vendor_id`).all();
    const map = (rows) => new Map(rows.map((r) => [r.vendor_id, r.n]));
    return { returns: map(returns), loans: map(loans), notes: map(notes) };
  }

  function pendingLists(vendorId) {
    const where = vendorId ? 'AND r.vendor_id = ?' : '';
    const args = vendorId ? [vendorId] : [];
    return {
      returns: q(`SELECT r.id, r.vendor_id, v.name AS vendor, r.date, r.item, r.amount
        FROM vendor_returns r JOIN vendors v ON v.id = r.vendor_id
        WHERE r.done = 0 AND r.deleted_at IS NULL ${where} ORDER BY r.date, r.id`).all(...args),
      loans: q(`SELECT r.id, r.vendor_id, v.name AS vendor, r.date, r.item, r.qty
        FROM vendor_loans r JOIN vendors v ON v.id = r.vendor_id
        WHERE r.returned = 0 AND r.deleted_at IS NULL ${where} ORDER BY r.date, r.id`).all(...args),
    };
  }

  // ---- 이번 달 결제 대상 ------------------------------------------------
  // 이번에 결제할 금액 = 6개월 전 월말 잔고 - 그 이후 결제액 - 그 이후 반품액 (음수면 0)
  function dueFor(month) {
    const monthStart = `${month}-01`;
    const monthEnd = endOfMonth(monthStart);
    const cutoff = endOfMonth(addMonths(monthStart, -6));
    const rows = q(`
      SELECT v.id, v.name,
        COALESCE(SUM(CASE WHEN e.date <= :cutoff THEN e.delta END), 0) AS pool,
        COALESCE(SUM(CASE WHEN e.date > :cutoff AND e.date <= :end AND e.kind = 'payment' THEN e.amount END), 0) AS paid,
        COALESCE(SUM(CASE WHEN e.date > :cutoff AND e.date <= :end AND e.kind = 'return' THEN e.amount END), 0) AS returned,
        COALESCE(SUM(e.delta), 0) AS balance
      FROM vendors v
      LEFT JOIN (SELECT vendor_id, date, kind, amount, ${VENDOR_DELTA} AS delta
                 FROM vendor_entries WHERE deleted_at IS NULL) e ON e.vendor_id = v.id
      WHERE v.active = 1
      GROUP BY v.id ORDER BY v.sort, v.name`).all({ cutoff, end: monthEnd });
    const counts = pendingCounts();
    const out = rows.map((r) => ({
      ...r,
      due: Math.max(0, r.pool - r.paid - r.returned),
      pendingReturns: counts.returns.get(r.id) ?? 0,
      openLoans: counts.loans.get(r.id) ?? 0,
      openNotes: counts.notes.get(r.id) ?? 0,
    }));
    return {
      month, cutoff, monthEnd, rows: out,
      total: out.reduce((s, r) => s + r.due, 0),
      pending: pendingLists(null),
      notes: q(`SELECT n.id, n.vendor_id, v.name AS vendor, n.body, n.done, n.done_date
        FROM vendor_notes n JOIN vendors v ON v.id = n.vendor_id
        WHERE n.done = 0 AND n.deleted_at IS NULL ORDER BY n.id`).all(),
    };
  }

  // ---- 환자 외상 ---------------------------------------------------------
  function creditRow(r, today, overdueDays) {
    const days = daysBetween(r.date, today);
    return { ...r, days, overdue: !r.paid && days >= overdueDays };
  }

  // ---- 휴지통 ------------------------------------------------------------
  const TRASH = {
    vendor_entries: {
      sql: `SELECT t.id, t.deleted_at, t.date, v.name || ' · ' || t.description || ' ' || t.amount AS label
            FROM vendor_entries t JOIN vendors v ON v.id = t.vendor_id WHERE t.deleted_at IS NOT NULL AND t.return_id IS NULL`,
    },
    vendor_returns: {
      sql: `SELECT t.id, t.deleted_at, t.date, v.name || ' · 반품 ' || t.item AS label
            FROM vendor_returns t JOIN vendors v ON v.id = t.vendor_id WHERE t.deleted_at IS NOT NULL`,
    },
    vendor_loans: {
      sql: `SELECT t.id, t.deleted_at, t.date, v.name || ' · 차용 ' || t.item AS label
            FROM vendor_loans t JOIN vendors v ON v.id = t.vendor_id WHERE t.deleted_at IS NOT NULL`,
    },
    vendor_notes: {
      sql: `SELECT t.id, t.deleted_at, t.created_at AS date, v.name || ' · 메모 ' || t.body AS label
            FROM vendor_notes t JOIN vendors v ON v.id = t.vendor_id WHERE t.deleted_at IS NOT NULL`,
    },
    hospital_entries: {
      sql: `SELECT t.id, t.deleted_at, t.date, h.name || ' · ' || t.item || ' ' || (t.billed + t.paid) AS label
            FROM hospital_entries t JOIN hospitals h ON h.id = t.hospital_id WHERE t.deleted_at IS NOT NULL`,
    },
    credits: {
      sql: `SELECT t.id, t.deleted_at, t.date, '환자 외상 · ' || t.name || ' ' || t.amount AS label
            FROM credits t WHERE t.deleted_at IS NOT NULL`,
    },
  };

  function softDelete(table, rowId) {
    const stamp = now();
    const res = q(`UPDATE ${table} SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).run(stamp, rowId);
    if (!res.changes) throw new HttpError(404, '찾을 수 없습니다');
    if (table === 'vendor_returns') {
      q('UPDATE vendor_entries SET deleted_at = ? WHERE return_id = ? AND deleted_at IS NULL').run(stamp, rowId);
    }
    return stamp;
  }

  function purgeTrash() {
    const limit = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    tx(db, () => {
      q('DELETE FROM vendor_entries WHERE deleted_at < ?').run(limit);
      for (const t of ['vendor_returns', 'vendor_loans', 'vendor_notes', 'hospital_entries', 'credits']) {
        q(`DELETE FROM ${t} WHERE deleted_at < ?`).run(limit);
      }
    });
  }
  ctx.purgeTrash = purgeTrash;

  // ---- CSV (엑셀에서 바로 열린다) ------------------------------------------
  const csvCell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // 엑셀 수식으로 해석되지 않게
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = (headers, rows) =>
    '﻿' + [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const csvResult = (name, text) => ({ raw: Buffer.from(text, 'utf8'), contentType: 'text/csv; charset=utf-8', filename: name });

  return [
    // ===== 인증 ===========================================================
    {
      method: 'GET', path: '/api/me', access: 'public',
      handler: ({ user }) => ({ body: { user, setup: !user && userCount() === 0 } }),
    },
    {
      method: 'POST', path: '/api/setup', access: 'public',
      handler: ({ body }) => {
        if (userCount() > 0) throw new HttpError(403, '이미 설정되었습니다');
        const username = str(body.username, '아이디', { required: true, max: 40 });
        const r = q('INSERT INTO users (username, pw_hash) VALUES (?, ?)').run(username, hashPassword(password(body.password)));
        const user = { id: Number(r.lastInsertRowid), username };
        audit(db, 'setup', username);
        return { body: { user }, session: createSession(db, user, true) };
      },
    },
    {
      method: 'POST', path: '/api/login', access: 'public',
      handler: ({ body, rateLimit }) => {
        const username = str(body.username, '아이디', { max: 40 });
        rateLimit(username);
        const row = q('SELECT * FROM users WHERE username = ?').get(username);
        // 아이디가 없어도 같은 비용의 계산을 해서 응답 시간 차이를 줄인다.
        const ok = row
          ? verifyPassword(String(body.password ?? ''), row.pw_hash)
          : (verifyPassword('x', hashPassword('y')), false);
        if (!ok) throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다');
        const user = { id: row.id, username: row.username };
        audit(db, 'login', username);
        return { body: { user }, session: createSession(db, user, Boolean(body.remember)) };
      },
    },
    {
      method: 'POST', path: '/api/logout', access: 'user',
      handler: ({ token }) => {
        destroySession(db, token);
        return { body: { ok: true }, clearSession: true };
      },
    },
    {
      method: 'POST', path: '/api/password', access: 'user',
      handler: ({ user, token, body }) => {
        const row = q('SELECT * FROM users WHERE id = ?').get(user.id);
        if (!verifyPassword(String(body.current ?? ''), row.pw_hash)) throw new HttpError(400, '현재 비밀번호가 맞지 않습니다');
        q('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPassword(password(body.next)), user.id);
        destroyOtherSessions(db, user.id, token); // 다른 기기는 다시 로그인해야 한다
        audit(db, 'password', user.username);
        return { body: { ok: true } };
      },
    },

    // ===== 설정 ===========================================================
    {
      method: 'GET', path: '/api/settings', access: 'user',
      handler: () => ({
        body: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, getSetting(db, k)])),
      }),
    },
    {
      method: 'PUT', path: '/api/settings', access: 'user',
      handler: ({ body }) => {
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (body[key] === undefined) continue;
          const n = money(body[key], key);
          if (key === 'overdue_days' && n < 1) throw new HttpError(400, '연체 기준은 1일 이상이어야 합니다');
          setSetting(db, key, n);
        }
        audit(db, 'settings', JSON.stringify(body));
        return { body: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, getSetting(db, k)])) };
      },
    },

    // ===== 제약회사 ========================================================
    {
      method: 'GET', path: '/api/vendors', access: 'user',
      handler: () => {
        const counts = pendingCounts();
        const rows = q(`
          SELECT v.id, v.name, v.car_numbers, v.active, COALESCE(SUM(e.delta), 0) AS balance
          FROM vendors v
          LEFT JOIN (SELECT vendor_id, ${VENDOR_DELTA} AS delta FROM vendor_entries WHERE deleted_at IS NULL) e
            ON e.vendor_id = v.id
          GROUP BY v.id ORDER BY v.active DESC, v.sort, v.name`).all();
        return {
          body: rows.map((r) => ({
            ...r,
            pendingReturns: counts.returns.get(r.id) ?? 0,
            openLoans: counts.loans.get(r.id) ?? 0,
            openNotes: counts.notes.get(r.id) ?? 0,
          })),
        };
      },
    },
    {
      method: 'POST', path: '/api/vendors', access: 'user',
      handler: ({ body }) => {
        const name = str(body.name, '제약회사 이름', { required: true, max: 60 });
        return uniqueName(() => {
          const r = q('INSERT INTO vendors (name, sort) VALUES (?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM vendors))').run(name);
          audit(db, 'vendor.create', name);
          return { status: 201, body: { id: Number(r.lastInsertRowid), name } };
        });
      },
    },
    {
      method: 'PATCH', path: '/api/vendors/:id', access: 'user',
      handler: ({ params, body }) => {
        const v = vendor(params.id);
        uniqueName(() => {
          if (body.name !== undefined) q('UPDATE vendors SET name = ? WHERE id = ?').run(str(body.name, '이름', { required: true, max: 60 }), v.id);
        });
        if (body.car_numbers !== undefined) q('UPDATE vendors SET car_numbers = ? WHERE id = ?').run(str(body.car_numbers, '차량번호', { max: 300 }), v.id);
        if (body.active !== undefined) q('UPDATE vendors SET active = ? WHERE id = ?').run(flag(body.active), v.id);
        audit(db, 'vendor.update', `${v.name} ${JSON.stringify(body)}`);
        return { body: { ok: true } };
      },
    },
    {
      method: 'GET', path: '/api/vendors/:id/ledger', access: 'user',
      handler: ({ params, query }) => {
        const v = vendor(params.id);
        const from = fromParam(query);
        const rows = q(`SELECT id, date, kind, description, amount, return_id FROM vendor_entries
          WHERE vendor_id = ? AND deleted_at IS NULL ORDER BY date, id`).all(v.id);
        const folded = foldLedger(rows, (r) => (r.kind === 'purchase' || r.kind === 'adjust' ? r.amount : -r.amount), from);
        const since = from ?? '0000-00-00';
        const returns = q(`SELECT id, date, item, amount, done, done_date FROM vendor_returns
          WHERE vendor_id = ? AND deleted_at IS NULL AND (done = 0 OR COALESCE(done_date, date) >= ?)
          ORDER BY done, date DESC, id DESC`).all(v.id, since);
        const loans = q(`SELECT id, date, item, qty, returned, returned_date FROM vendor_loans
          WHERE vendor_id = ? AND deleted_at IS NULL AND (returned = 0 OR COALESCE(returned_date, date) >= ?)
          ORDER BY returned, date DESC, id DESC`).all(v.id, since);
        const notes = q(`SELECT id, body, done, done_date FROM vendor_notes
          WHERE vendor_id = ? AND deleted_at IS NULL ORDER BY done, id DESC`).all(v.id);
        return { body: { vendor: v, ...folded, returns, loans, notes } };
      },
    },
    {
      method: 'POST', path: '/api/vendors/:id/entries', access: 'user',
      handler: ({ params, body }) => {
        const v = vendor(params.id);
        const kind = body.kind;
        if (!['purchase', 'payment', 'adjust'].includes(kind)) throw new HttpError(400, '구분이 올바르지 않습니다');
        const row = {
          date: date(body.date),
          description: str(body.description, '내용', { required: kind === 'purchase' }) || (kind === 'payment' ? '결제' : '조정'),
          amount: money(body.amount, '금액', { signed: kind === 'adjust' }),
        };
        if (kind !== 'adjust' && row.amount === 0) throw new HttpError(400, '금액은 0보다 커야 합니다');
        const r = q('INSERT INTO vendor_entries (vendor_id, date, kind, description, amount) VALUES (?, ?, ?, ?, ?)')
          .run(v.id, row.date, kind, row.description, row.amount);
        audit(db, 'entry.create', `${v.name} ${kind} ${row.date} ${row.amount}`);
        return { status: 201, body: { id: Number(r.lastInsertRowid) } };
      },
    },
    {
      method: 'PATCH', path: '/api/entries/:id', access: 'user',
      handler: ({ params, body }) => {
        const e = must(q('SELECT * FROM vendor_entries WHERE id = ? AND deleted_at IS NULL').get(id(params.id)));
        if (e.return_id) throw new HttpError(400, '반품은 반품 칸에서 고쳐 주세요');
        const next = {
          date: body.date !== undefined ? date(body.date) : e.date,
          description: body.description !== undefined ? str(body.description, '내용', { max: 200 }) : e.description,
          amount: body.amount !== undefined ? money(body.amount, '금액', { signed: e.kind === 'adjust' }) : e.amount,
        };
        q('UPDATE vendor_entries SET date = ?, description = ?, amount = ? WHERE id = ?').run(next.date, next.description, next.amount, e.id);
        audit(db, 'entry.update', `${e.id} ${JSON.stringify(next)}`);
        return { body: { ok: true } };
      },
    },
    {
      method: 'DELETE', path: '/api/entries/:id', access: 'user',
      handler: ({ params }) => {
        const e = must(q('SELECT * FROM vendor_entries WHERE id = ? AND deleted_at IS NULL').get(id(params.id)));
        if (e.return_id) throw new HttpError(400, '반품은 반품 칸에서 처리 완료 체크를 풀어 주세요');
        softDelete('vendor_entries', e.id);
        audit(db, 'entry.delete', `${e.id} ${e.date} ${e.description} ${e.amount}`);
        return { body: { ok: true } };
      },
    },

    // ---- 반품 칸 -------------------------------------------------------
    {
      method: 'POST', path: '/api/vendors/:id/returns', access: 'user',
      handler: ({ params, body }) => {
        const v = vendor(params.id);
        const r = q('INSERT INTO vendor_returns (vendor_id, date, item, amount) VALUES (?, ?, ?, ?)').run(
          v.id, date(body.date), str(body.item, '품목명', { required: true }), money(body.amount, '반품액', { blank: 0 }),
        );
        audit(db, 'return.create', `${v.name} ${body.item}`);
        return { status: 201, body: { id: Number(r.lastInsertRowid) } };
      },
    },
    {
      method: 'PATCH', path: '/api/returns/:id', access: 'user',
      handler: ({ params, body }) => tx(db, () => {
        const r = must(q('SELECT * FROM vendor_returns WHERE id = ? AND deleted_at IS NULL').get(id(params.id)));
        const editing = ['date', 'item', 'amount'].some((k) => body[k] !== undefined);
        if (editing) {
          if (r.done) throw new HttpError(400, '처리 완료를 풀고 고쳐 주세요');
          q('UPDATE vendor_returns SET date = ?, item = ?, amount = ? WHERE id = ?').run(
            body.date !== undefined ? date(body.date) : r.date,
            body.item !== undefined ? str(body.item, '품목명', { required: true }) : r.item,
            body.amount !== undefined ? money(body.amount, '반품액') : r.amount, r.id,
          );
        }
        if (body.done !== undefined) {
          const fresh = q('SELECT * FROM vendor_returns WHERE id = ?').get(r.id);
          if (body.done && !fresh.done) {
            if (!fresh.amount) throw new HttpError(400, '반품액을 먼저 입력하세요');
            const doneDate = body.done_date ? date(body.done_date, '처리 날짜') : todayKST();
            q('UPDATE vendor_returns SET done = 1, done_date = ? WHERE id = ?').run(doneDate, r.id);
            q('INSERT INTO vendor_entries (vendor_id, date, kind, description, amount, return_id) VALUES (?, ?, ?, ?, ?, ?)')
              .run(r.vendor_id, doneDate, 'return', fresh.item, fresh.amount, r.id);
          } else if (!body.done && fresh.done) {
            q('UPDATE vendor_returns SET done = 0, done_date = NULL WHERE id = ?').run(r.id);
            q('DELETE FROM vendor_entries WHERE return_id = ?').run(r.id); // 체크를 풀면 장부에서 빠진다
          }
        }
        audit(db, 'return.update', `${r.id} ${JSON.stringify(body)}`);
        return { body: { ok: true } };
      }),
    },
    {
      method: 'DELETE', path: '/api/returns/:id', access: 'user',
      handler: ({ params }) => tx(db, () => {
        softDelete('vendor_returns', id(params.id));
        return { body: { ok: true } };
      }),
    },

    // ---- 차용 ----------------------------------------------------------
    {
      method: 'POST', path: '/api/vendors/:id/loans', access: 'user',
      handler: ({ params, body }) => {
        const v = vendor(params.id);
        const qty = money(body.qty, '개수', { blank: 1 });
        if (qty < 1) throw new HttpError(400, '개수는 1 이상이어야 합니다');
        const r = q('INSERT INTO vendor_loans (vendor_id, date, item, qty) VALUES (?, ?, ?, ?)')
          .run(v.id, date(body.date), str(body.item, '품목', { required: true }), qty);
        audit(db, 'loan.create', `${v.name} ${body.item} ${qty}`);
        return { status: 201, body: { id: Number(r.lastInsertRowid) } };
      },
    },
    {
      method: 'PATCH', path: '/api/loans/:id', access: 'user',
      handler: ({ params, body }) => {
        const l = must(q('SELECT * FROM vendor_loans WHERE id = ? AND deleted_at IS NULL').get(id(params.id)));
        if (body.returned !== undefined) {
          const when = body.returned ? (body.returned_date ? date(body.returned_date, '반환 날짜') : todayKST()) : null;
          q('UPDATE vendor_loans SET returned = ?, returned_date = ? WHERE id = ?').run(flag(body.returned), when, l.id);
        }
        if (body.item !== undefined || body.qty !== undefined || body.date !== undefined) {
          q('UPDATE vendor_loans SET date = ?, item = ?, qty = ? WHERE id = ?').run(
            body.date !== undefined ? date(body.date) : l.date,
            body.item !== undefined ? str(body.item, '품목', { required: true }) : l.item,
            body.qty !== undefined ? money(body.qty, '개수') : l.qty, l.id,
          );
        }
        audit(db, 'loan.update', `${l.id} ${JSON.stringify(body)}`);
        return { body: { ok: true } };
      },
    },
    {
      method: 'DELETE', path: '/api/loans/:id', access: 'user',
      handler: ({ params }) => {
        softDelete('vendor_loans', id(params.id));
        return { body: { ok: true } };
      },
    },

    // ---- 확인 메모 -----------------------------------------------------------
    {
      method: 'POST', path: '/api/vendors/:id/notes', access: 'user',
      handler: ({ params, body }) => {
        const v = vendor(params.id);
        const r = q('INSERT INTO vendor_notes (vendor_id, body) VALUES (?, ?)').run(v.id, str(body.body, '메모', { required: true, max: 500 }));
        return { status: 201, body: { id: Number(r.lastInsertRowid) } };
      },
    },
    {
      method: 'PATCH', path: '/api/notes/:id', access: 'user',
      handler: ({ params, body }) => {
        const n = must(q('SELECT * FROM vendor_notes WHERE id = ? AND deleted_at IS NULL').get(id(params.id)));
        if (body.body !== undefined) q('UPDATE vendor_notes SET body = ? WHERE id = ?').run(str(body.body, '메모', { required: true, max: 500 }), n.id);
        if (body.done !== undefined) q('UPDATE vendor_notes SET done = ?, done_date = ? WHERE id = ?').run(flag(body.done), body.done ? todayKST() : null, n.id);
        return { body: { ok: true } };
      },
    },
    {
      method: 'DELETE', path: '/api/notes/:id', access: 'user',
      handler: ({ params }) => {
        softDelete('vendor_notes', id(params.id));
        return { body: { ok: true } };
      },
    },

    // ---- 이번 달 결제 대상 ----------------------------------------------------
    {
      method: 'GET', path: '/api/due', access: 'user',
      handler: ({ query }) => {
        const month = query.get('month') || monthOf(todayKST());
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, '월 형식이 올바르지 않습니다 (YYYY-MM)');
        return { body: dueFor(month) };
      },
    },

    // ===== 병원 =============================================================
    {
      method: 'GET', path: '/api/hospitals', access: 'user',
      handler: () => ({
        body: q(`SELECT h.id, h.name, h.active,
            COALESCE(SUM(e.billed - e.paid), 0) AS balance
          FROM hospitals h LEFT JOIN hospital_entries e ON e.hospital_id = h.id AND e.deleted_at IS NULL
          GROUP BY h.id ORDER BY h.active DESC, h.name`).all(),
      }),
    },
    {
      method: 'POST', path: '/api/hospitals', access: 'user',
      handler: ({ body }) => {
        const name = str(body.name, '병원 이름', { required: true, max: 60 });
        return uniqueName(() => {
          const r = q('INSERT INTO hospitals (name) VALUES (?)').run(name);
          audit(db, 'hospital.create', name);
          return { status: 201, body: { id: Number(r.lastInsertRowid), name } };
        });
      },
    },
    {
      method: 'GET', path: '/api/hospitals/:id/ledger', access: 'user',
      handler: ({ params, query }) => {
        const h = hospital(params.id);
        const rows = q(`SELECT id, date, kind, item, qty, original, discount, billed, paid FROM hospital_entries
          WHERE hospital_id = ? AND deleted_at IS NULL ORDER BY date, id`).all(h.id);
        return { body: { hospital: h, ...foldLedger(rows, (r) => r.billed - r.paid, fromParam(query)) } };
      },
    },
    {
      method: 'POST', path: '/api/hospitals/:id/entries', access: 'user',
      handler: ({ params, body }) => {
        const h = hospital(params.id);
        const kind = body.kind;
        const row = { date: date(body.date), kind, item: '', qty: null, original: null, discount: null, billed: 0, paid: 0 };
        if (kind === 'rx') {
          // 처방조제약: 원래 금액을 직접 입력하고, 할인액(기본 5,000원)은 자동으로 뺀다.
          row.item = str(body.item, '환자명', { required: true });
          row.original = money(body.original, '원래 금액');
          row.discount = money(body.discount, '할인액', { blank: getSetting(db, 'rx_discount') });
          if (row.discount > row.original) throw new HttpError(400, '할인액이 원래 금액보다 클 수 없습니다');
          row.billed = row.original - row.discount;
        } else if (kind === 'otc') {
          // 일반의약품: 단가표에서 고르면 단가 × 수량. 단가표에 없으면 외상액을 직접 입력한다.
          row.qty = money(body.qty, '수량', { blank: 1 });
          if (body.product_id) {
            const p = must(q('SELECT * FROM hospital_products WHERE id = ?').get(id(body.product_id)));
            row.item = str(body.item, '품목') || p.name;
            row.billed = body.billed !== undefined && body.billed !== '' ? money(body.billed, '외상액') : p.price * row.qty;
          } else {
            row.item = str(body.item, '품목', { required: true });
            row.billed = money(body.billed, '외상액');
          }
        } else if (kind === 'payment') {
          row.item = str(body.item, '내용') || '결제';
          row.paid = money(body.paid, '결제액');
        } else if (kind === 'adjust') {
          row.item = str(body.item, '내용') || '조정';
          row.billed = money(body.billed, '조정 금액', { signed: true });
        } else {
          throw new HttpError(400, '구분이 올바르지 않습니다');
        }
        const r = q(`INSERT INTO hospital_entries (hospital_id, date, kind, item, qty, original, discount, billed, paid)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(h.id, row.date, row.kind, row.item, row.qty, row.original, row.discount, row.billed, row.paid);
        audit(db, 'hospital.entry', `${h.name} ${kind} ${row.date} ${row.billed} ${row.paid}`);
        return { status: 201, body: { id: Number(r.lastInsertRowid), billed: row.billed } };
      },
    },
    {
      method: 'DELETE', path: '/api/hospital-entries/:id', access: 'user',
      handler: ({ params }) => {
        const rowId = id(params.id);
        softDelete('hospital_entries', rowId);
        audit(db, 'hospital.entry.delete', String(rowId));
        return { body: { ok: true } };
      },
    },
    {
      method: 'GET', path: '/api/hospital-products', access: 'user',
      handler: () => ({ body: q('SELECT id, name, price FROM hospital_products ORDER BY name').all() }),
    },
    {
      method: 'POST', path: '/api/hospital-products', access: 'user',
      handler: ({ body }) => uniqueName(() => {
        const r = q('INSERT INTO hospital_products (name, price) VALUES (?, ?)')
          .run(str(body.name, '제품명', { required: true, max: 80 }), money(body.price, '단가'));
        return { status: 201, body: { id: Number(r.lastInsertRowid) } };
      }),
    },
    {
      method: 'PATCH', path: '/api/hospital-products/:id', access: 'user',
      handler: ({ params, body }) => uniqueName(() => {
        const p = must(q('SELECT * FROM hospital_products WHERE id = ?').get(id(params.id)));
        q('UPDATE hospital_products SET name = ?, price = ? WHERE id = ?').run(
          body.name !== undefined ? str(body.name, '제품명', { required: true, max: 80 }) : p.name,
          body.price !== undefined ? money(body.price, '단가') : p.price, p.id,
        );
        return { body: { ok: true } };
      }),
    },
    {
      method: 'DELETE', path: '/api/hospital-products/:id', access: 'user',
      handler: ({ params }) => {
        q('DELETE FROM hospital_products WHERE id = ?').run(id(params.id));
        return { body: { ok: true } };
      },
    },

    // ===== 환자 외상 ==========================================================
    {
      method: 'GET', path: '/api/credits', access: 'user',
      handler: ({ query }) => {
        const today = todayKST();
        const overdueDays = getSetting(db, 'overdue_days');
        const all = query.get('status') === 'all';
        const search = (query.get('q') || '').trim();
        let rows = q(`SELECT id, date, name, rrn_front, phone, content, amount, memo_done, paid, paid_date, note
          FROM credits WHERE deleted_at IS NULL ${all ? '' : 'AND paid = 0'}`).all();
        if (search) rows = rows.filter((r) => r.name.includes(search) || r.rrn_front.includes(search));
        const items = rows.map((r) => creditRow(r, today, overdueDays));
        // 연체가 맨 위(오래된 것부터), 그다음은 최근 외상부터
        items.sort((a, b) => (b.overdue - a.overdue) || (a.overdue ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)) || b.id - a.id);
        const groups = new Map();
        for (const r of items.filter((i) => !i.paid)) {
          const key = `${r.name}|${r.rrn_front}`;
          const g = groups.get(key) ?? { key, name: r.name, rrn_front: r.rrn_front, phone: '', total: 0, count: 0, overdueCount: 0, oldest: r.date };
          g.total += r.amount;
          g.count += 1;
          g.overdueCount += r.overdue ? 1 : 0;
          g.phone = g.phone || r.phone;
          if (r.date < g.oldest) g.oldest = r.date;
          groups.set(key, g);
        }
        const open = items.filter((i) => !i.paid);
        return {
          body: {
            items,
            groups: [...groups.values()].sort((a, b) => (b.overdueCount > 0) - (a.overdueCount > 0) || a.oldest.localeCompare(b.oldest)),
            overdueDays,
            totalOpen: open.reduce((s, r) => s + r.amount, 0),
            openCount: open.length,
            overdueCount: open.filter((i) => i.overdue).length,
          },
        };
      },
    },
    {
      method: 'POST', path: '/api/credits', access: 'user',
      handler: ({ body }) => {
        const rrn = str(body.rrn_front, '주민번호 앞자리', { max: 6 });
        if (rrn && !/^\d{6}$/.test(rrn)) throw new HttpError(400, '주민번호 앞자리는 숫자 6자리입니다');
        const phone = str(body.phone, '연락처', { max: 20 });
        if (phone && !/^[0-9+\-() ]+$/.test(phone)) throw new HttpError(400, '연락처는 숫자와 - 만 쓸 수 있습니다');
        const amount = money(body.amount, '외상액');
        if (amount === 0) throw new HttpError(400, '외상액은 0보다 커야 합니다');
        const r = q(`INSERT INTO credits (date, name, rrn_front, phone, content, amount, memo_done, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          date(body.date), str(body.name, '환자명', { required: true, max: 60 }), rrn, phone,
          str(body.content, '외상 내용'), amount, flag(body.memo_done), str(body.note, '비고'),
        );
        audit(db, 'credit.create', `${body.name} ${amount}`);
        return { status: 201, body: { id: Number(r.lastInsertRowid) } };
      },
    },
    {
      method: 'PATCH', path: '/api/credits/:id', access: 'user',
      handler: ({ params, body }) => {
        const c = must(q('SELECT * FROM credits WHERE id = ? AND deleted_at IS NULL').get(id(params.id)));
        if (body.memo_done !== undefined) q('UPDATE credits SET memo_done = ? WHERE id = ?').run(flag(body.memo_done), c.id);
        if (body.paid !== undefined) {
          const when = body.paid ? (body.paid_date ? date(body.paid_date, '완불 날짜') : todayKST()) : null;
          q('UPDATE credits SET paid = ?, paid_date = ? WHERE id = ?').run(flag(body.paid), when, c.id);
        }
        if (body.amount !== undefined) q('UPDATE credits SET amount = ? WHERE id = ?').run(money(body.amount, '외상액'), c.id);
        if (body.note !== undefined) q('UPDATE credits SET note = ? WHERE id = ?').run(str(body.note, '비고'), c.id);
        if (body.content !== undefined) q('UPDATE credits SET content = ? WHERE id = ?').run(str(body.content, '외상 내용'), c.id);
        if (body.phone !== undefined) {
          const phone = str(body.phone, '연락처', { max: 20 });
          if (phone && !/^[0-9+\-() ]+$/.test(phone)) throw new HttpError(400, '연락처는 숫자와 - 만 쓸 수 있습니다');
          q('UPDATE credits SET phone = ? WHERE id = ?').run(phone, c.id);
        }
        audit(db, 'credit.update', `${c.name} ${JSON.stringify(body)}`);
        return { body: { ok: true } };
      },
    },
    {
      method: 'DELETE', path: '/api/credits/:id', access: 'user',
      handler: ({ params }) => {
        const rowId = id(params.id);
        softDelete('credits', rowId);
        audit(db, 'credit.delete', String(rowId));
        return { body: { ok: true } };
      },
    },

    // ===== 휴지통 · 백업 · 내보내기 ===============================================
    {
      method: 'GET', path: '/api/trash', access: 'user',
      handler: () => {
        const items = Object.entries(TRASH).flatMap(([table, t]) =>
          q(t.sql).all().map((r) => ({ table, id: r.id, label: r.label, date: r.date, deleted_at: r.deleted_at })));
        items.sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
        return { body: items };
      },
    },
    {
      method: 'POST', path: '/api/trash/restore', access: 'user',
      handler: ({ body }) => tx(db, () => {
        const table = body.table;
        if (!Object.hasOwn(TRASH, table)) throw new HttpError(400, '종류가 올바르지 않습니다');
        const row = must(q(`SELECT deleted_at FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`).get(id(body.id)));
        q(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`).run(id(body.id));
        if (table === 'vendor_returns') {
          q('UPDATE vendor_entries SET deleted_at = NULL WHERE return_id = ? AND deleted_at = ?').run(id(body.id), row.deleted_at);
        }
        audit(db, 'trash.restore', `${table} ${body.id}`);
        return { body: { ok: true } };
      }),
    },
    {
      method: 'GET', path: '/api/backup', access: 'user',
      handler: () => {
        const tmp = join(tmpdir(), `pharmacy-backup-${randomUUID()}.db`);
        try {
          db.exec(`VACUUM INTO '${tmp}'`);
          audit(db, 'backup');
          return { raw: readFileSync(tmp), contentType: 'application/octet-stream', filename: `pharmacy-backup-${todayKST()}.db` };
        } finally {
          try { unlinkSync(tmp); } catch { /* 이미 없으면 그만 */ }
        }
      },
    },
    {
      method: 'GET', path: '/api/export/vendors.csv', access: 'user',
      handler: () => {
        const rows = q(`SELECT v.name, e.date, e.kind, e.description, e.amount FROM vendor_entries e
          JOIN vendors v ON v.id = e.vendor_id WHERE e.deleted_at IS NULL ORDER BY v.name, e.date, e.id`).all();
        const label = { purchase: '입고', payment: '결제', return: '반품', adjust: '조정' };
        return csvResult(`제약회사장부-${todayKST()}.csv`, csv(['제약회사', '날짜', '구분', '내용', '금액'],
          rows.map((r) => [r.name, formatDate(r.date), label[r.kind], r.description, r.amount])));
      },
    },
    {
      method: 'GET', path: '/api/export/hospitals.csv', access: 'user',
      handler: () => {
        const rows = q(`SELECT h.name, e.date, e.kind, e.item, e.qty, e.original, e.discount, e.billed, e.paid FROM hospital_entries e
          JOIN hospitals h ON h.id = e.hospital_id WHERE e.deleted_at IS NULL ORDER BY h.name, e.date, e.id`).all();
        const label = { rx: '처방조제약', otc: '일반의약품', payment: '결제', adjust: '조정' };
        return csvResult(`병원외상장부-${todayKST()}.csv`, csv(['병원', '날짜', '구분', '환자명·품목', '수량', '원래금액', '할인액', '외상액', '결제액'],
          rows.map((r) => [r.name, formatDate(r.date), label[r.kind], r.item, r.qty, r.original, r.discount, r.billed, r.paid])));
      },
    },
    {
      method: 'GET', path: '/api/export/credits.csv', access: 'user',
      handler: () => {
        const rows = q(`SELECT date, name, rrn_front, phone, content, amount, memo_done, paid, paid_date, note
          FROM credits WHERE deleted_at IS NULL ORDER BY date, id`).all();
        return csvResult(`환자외상장부-${todayKST()}.csv`, csv(
          ['날짜', '환자명', '주민번호 앞자리', '연락처', '외상 내용', '외상액', '메모장 작성', '완불', '완불 날짜', '비고'],
          rows.map((r) => [formatDate(r.date), r.name, r.rrn_front, r.phone, r.content, r.amount,
            r.memo_done ? 'O' : '', r.paid ? 'O' : '', formatDate(r.paid_date), r.note])));
      },
    },
  ];
}

