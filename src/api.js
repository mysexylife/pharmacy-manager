import { audit } from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, destroyUserSessions,
} from './auth.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function date(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new HttpError(400, '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)');
  }
  return v;
}

// 금액 칸을 비워 두면 0으로 본다. 수량처럼 비어 있어도 되는 값은 optional로 null 처리.
function int(v, label, { optional = false, blank = undefined } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    if (blank !== undefined) return blank;
  }
  const n = Number(v);
  if (v === '' || v === null || !Number.isSafeInteger(n)) throw new HttpError(400, `${label}은(는) 정수여야 합니다`);
  return n;
}

function str(v, label, { required = false, max = 200 } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${label}을(를) 입력하세요`);
  if (s.length > max) throw new HttpError(400, `${label}이(가) 너무 깁니다`);
  return s;
}

const bool = (v) => (v ? 1 : 0);

// 제약회사 장부는 약사만 볼 수 있다. 권한은 반드시 서버에서 확인한다.
function assertPartyAccess(user, party) {
  if (!party) throw new HttpError(404, '찾을 수 없습니다');
  if (party.type === 'vendor' && user.role !== 'pharmacist') throw new HttpError(403, '권한이 없습니다');
}

export function buildRoutes(db) {
  const getParty = (id) => db.prepare('SELECT * FROM parties WHERE id = ?').get(id);
  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  function loginAs(user) {
    const { token, maxAge } = createSession(db, user);
    return { token, maxAge };
  }

  function createUser({ username, name, password, role }) {
    username = str(username, '아이디', { required: true, max: 40 });
    name = str(name, '이름', { required: true, max: 40 });
    if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다');
    if (!['pharmacist', 'staff'].includes(role)) throw new HttpError(400, '권한이 올바르지 않습니다');
    try {
      const r = db.prepare('INSERT INTO users (username, name, role, pw_hash) VALUES (?, ?, ?, ?)')
        .run(username, name, role, hashPassword(password));
      return { id: Number(r.lastInsertRowid), username, name, role };
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, '이미 있는 아이디입니다');
      throw e;
    }
  }

  return [
    // ---- 인증 ----
    {
      method: 'GET', path: '/api/me', access: 'public',
      handler: ({ user }) => ({ body: { user, setup: !user && userCount() === 0 } }),
    },
    {
      method: 'POST', path: '/api/setup', access: 'public',
      handler: ({ body }) => {
        if (userCount() > 0) throw new HttpError(403, '이미 설정되었습니다');
        const user = createUser({ ...body, role: 'pharmacist' });
        audit(db, user.id, 'setup', user.username);
        return { body: { user }, session: loginAs(user) };
      },
    },
    {
      method: 'POST', path: '/api/login', access: 'public',
      handler: ({ body, rateLimit }) => {
        const username = str(body.username, '아이디', { max: 40 });
        rateLimit(username);
        const row = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
        // 아이디가 없어도 같은 비용의 해시 계산을 해서 응답 시간 차이를 줄인다.
        const ok = row
          ? verifyPassword(String(body.password ?? ''), row.pw_hash)
          : (verifyPassword('x', hashPassword('y')), false);
        if (!ok) throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다');
        const user = { id: row.id, username: row.username, name: row.name, role: row.role };
        audit(db, user.id, 'login');
        return { body: { user }, session: loginAs(user) };
      },
    },
    {
      method: 'POST', path: '/api/logout', access: 'user',
      handler: ({ token }) => {
        destroySession(db, token);
        return { body: { ok: true }, clearSession: true };
      },
    },

    // ---- 직원 관리 (약사 전용) ----
    {
      method: 'GET', path: '/api/users', access: 'pharmacist',
      handler: () => ({
        body: db.prepare('SELECT id, username, name, role, active FROM users ORDER BY id').all(),
      }),
    },
    {
      method: 'POST', path: '/api/users', access: 'pharmacist',
      handler: ({ user, body }) => {
        const created = createUser(body);
        audit(db, user.id, 'user.create', `${created.username}/${created.role}`);
        return { status: 201, body: created };
      },
    },
    {
      method: 'PATCH', path: '/api/users/:id', access: 'pharmacist',
      handler: ({ user, params, body }) => {
        const id = int(params.id, 'id');
        const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (!target) throw new HttpError(404, '찾을 수 없습니다');
        if (body.active !== undefined) {
          if (id === user.id) throw new HttpError(400, '본인 계정은 비활성화할 수 없습니다');
          db.prepare('UPDATE users SET active = ? WHERE id = ?').run(bool(body.active), id);
          if (!body.active) destroyUserSessions(db, id);
        }
        if (body.password !== undefined) {
          if (typeof body.password !== 'string' || body.password.length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다');
          db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPassword(body.password), id);
          destroyUserSessions(db, id);
        }
        audit(db, user.id, 'user.update', `${target.username}`);
        return { body: { ok: true } };
      },
    },

    // ---- 거래처 (제약회사 / 병원) ----
    {
      method: 'GET', path: '/api/parties', access: 'user',
      handler: ({ user, query }) => {
        const type = query.get('type');
        if (!['vendor', 'hospital'].includes(type)) throw new HttpError(400, 'type이 올바르지 않습니다');
        assertPartyAccess(user, { type });
        const rows = db.prepare(`
          SELECT p.id, p.name, COALESCE(SUM(e.billed - e.paid), 0) AS balance
          FROM parties p LEFT JOIN ledger_entries e ON e.party_id = p.id
          WHERE p.type = ? GROUP BY p.id ORDER BY p.name`).all(type);
        return { body: rows };
      },
    },
    {
      method: 'POST', path: '/api/parties', access: 'pharmacist',
      handler: ({ user, body }) => {
        if (!['vendor', 'hospital'].includes(body.type)) throw new HttpError(400, 'type이 올바르지 않습니다');
        const name = str(body.name, '이름', { required: true, max: 60 });
        try {
          const r = db.prepare('INSERT INTO parties (type, name) VALUES (?, ?)').run(body.type, name);
          audit(db, user.id, 'party.create', `${body.type}/${name}`);
          return { status: 201, body: { id: Number(r.lastInsertRowid), name, balance: 0 } };
        } catch (e) {
          if (String(e.message).includes('UNIQUE')) throw new HttpError(409, '이미 있는 이름입니다');
          throw e;
        }
      },
    },

    // ---- 원장 ----
    {
      // from 이전 내역은 보내지 않지만, 잔고는 전체 누적으로 계산해서 틀리지 않게 한다.
      method: 'GET', path: '/api/parties/:id/entries', access: 'user',
      handler: ({ user, params, query }) => {
        const party = getParty(int(params.id, 'id'));
        assertPartyAccess(user, party);
        const from = query.get('from') ? date(query.get('from')) : null;
        const all = db.prepare(`
          SELECT id, date, description, qty, billed, paid,
                 SUM(billed - paid) OVER (ORDER BY date, id) AS balance
          FROM ledger_entries WHERE party_id = ? ORDER BY date, id`).all(party.id);
        const idx = from ? all.findIndex((e) => e.date >= from) : 0;
        const start = idx === -1 ? all.length : idx;
        const opening = start > 0 ? all[start - 1].balance : 0;
        return {
          body: {
            party: { id: party.id, name: party.name, type: party.type },
            opening: from ? opening : null,
            entries: all.slice(start),
            balance: all.length ? all[all.length - 1].balance : 0,
          },
        };
      },
    },
    {
      method: 'POST', path: '/api/parties/:id/entries', access: 'user',
      handler: ({ user, params, body }) => {
        const party = getParty(int(params.id, 'id'));
        assertPartyAccess(user, party);
        const row = {
          date: date(body.date),
          description: str(body.description, '내용', { required: true }),
          qty: int(body.qty, '수량', { optional: true }),
          billed: int(body.billed, '금액', { blank: 0 }),
          paid: int(body.paid, '결제액', { blank: 0 }),
        };
        const r = db.prepare(`INSERT INTO ledger_entries (party_id, date, description, qty, billed, paid, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(party.id, row.date, row.description, row.qty, row.billed, row.paid, user.id);
        audit(db, user.id, 'entry.create', `${party.name}/${row.date}/${row.description}/${row.billed}/${row.paid}`);
        return { status: 201, body: { id: Number(r.lastInsertRowid) } };
      },
    },
    {
      method: 'DELETE', path: '/api/entries/:id', access: 'pharmacist',
      handler: ({ user, params }) => {
        const id = int(params.id, 'id');
        const e = db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id);
        if (!e) throw new HttpError(404, '찾을 수 없습니다');
        db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(id);
        audit(db, user.id, 'entry.delete', `${e.party_id}/${e.date}/${e.description}/${e.billed}/${e.paid}`);
        return { body: { ok: true } };
      },
    },

    // ---- 환자 외상 ----
    {
      method: 'GET', path: '/api/credits', access: 'user',
      handler: ({ query }) => {
        const where = query.get('status') === 'all' ? '' : 'WHERE paid = 0';
        const rows = db.prepare(`SELECT id, date, name, rrn_front, content, amount, memo_done, paid, paid_date, note
          FROM credits ${where} ORDER BY date DESC, id DESC`).all();
        return { body: rows };
      },
    },
    {
      method: 'POST', path: '/api/credits', access: 'user',
      handler: ({ user, body }) => {
        const rrn = str(body.rrn_front, '주민번호 앞자리', { max: 6 });
        if (rrn && !/^\d{6}$/.test(rrn)) throw new HttpError(400, '주민번호 앞자리는 숫자 6자리입니다');
        const row = {
          date: date(body.date),
          name: str(body.name, '환자명', { required: true, max: 60 }),
          content: str(body.content, '외상 내용'),
          amount: int(body.amount, '외상액'),
          note: str(body.note, '비고'),
          memo_done: bool(body.memo_done),
        };
        const r = db.prepare(`INSERT INTO credits (date, name, rrn_front, content, amount, memo_done, note, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.date, row.name, rrn, row.content, row.amount, row.memo_done, row.note, user.id);
        audit(db, user.id, 'credit.create', `${row.name}/${row.amount}`);
        return { status: 201, body: { id: Number(r.lastInsertRowid) } };
      },
    },
    {
      method: 'PATCH', path: '/api/credits/:id', access: 'user',
      handler: ({ user, params, body }) => {
        const id = int(params.id, 'id');
        const c = db.prepare('SELECT * FROM credits WHERE id = ?').get(id);
        if (!c) throw new HttpError(404, '찾을 수 없습니다');
        if (body.memo_done !== undefined) {
          db.prepare('UPDATE credits SET memo_done = ? WHERE id = ?').run(bool(body.memo_done), id);
        }
        if (body.paid !== undefined) {
          const paidDate = body.paid ? date(body.paid_date ?? new Date().toLocaleDateString('sv-SE')) : null;
          db.prepare('UPDATE credits SET paid = ?, paid_date = ? WHERE id = ?').run(bool(body.paid), paidDate, id);
        }
        if (body.note !== undefined) {
          db.prepare('UPDATE credits SET note = ? WHERE id = ?').run(str(body.note, '비고'), id);
        }
        audit(db, user.id, 'credit.update', `${c.name}/${JSON.stringify(body)}`);
        return { body: { ok: true } };
      },
    },
    {
      method: 'DELETE', path: '/api/credits/:id', access: 'pharmacist',
      handler: ({ user, params }) => {
        const id = int(params.id, 'id');
        const c = db.prepare('SELECT * FROM credits WHERE id = ?').get(id);
        if (!c) throw new HttpError(404, '찾을 수 없습니다');
        db.prepare('DELETE FROM credits WHERE id = ?').run(id);
        audit(db, user.id, 'credit.delete', `${c.name}/${c.amount}`);
        return { body: { ok: true } };
      },
    },
  ];
}
