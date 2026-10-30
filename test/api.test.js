import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

let server, base;
const jar = {}; // 사용자별 쿠키

before(async () => {
  server = createApp(openDb(':memory:'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(who, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) jar[who] = set.split(';')[0];
  return { status: res.status, data: await res.json() };
}

test('첫 설정 후에는 /api/setup이 막힌다', async () => {
  assert.equal((await call('x', 'GET', '/api/me')).data.setup, true);
  const r = await call('pharm', 'POST', '/api/setup', { username: 'boss', name: '약사', password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal((await call('x', 'POST', '/api/setup', { username: 'evil', name: 'x', password: 'password123' })).status, 403);
});

test('직원 계정 생성 및 로그인', async () => {
  const r = await call('pharm', 'POST', '/api/users', { username: 'staff1', name: '직원', password: 'password123', role: 'staff' });
  assert.equal(r.status, 201);
  assert.equal((await call('staff', 'POST', '/api/login', { username: 'staff1', password: 'wrong-password' })).status, 401);
  assert.equal((await call('staff', 'POST', '/api/login', { username: 'staff1', password: 'password123' })).status, 200);
});

test('직원은 제약회사 장부를 볼 수도 쓸 수도 없다', async () => {
  const v = await call('pharm', 'POST', '/api/parties', { type: 'vendor', name: '고려제약' });
  const id = v.data.id;
  await call('pharm', 'POST', `/api/parties/${id}/entries`, { date: '2025-01-10', description: '입고', billed: 1000 });
  assert.equal((await call('staff', 'GET', '/api/parties?type=vendor')).status, 403);
  assert.equal((await call('staff', 'GET', `/api/parties/${id}/entries`)).status, 403);
  assert.equal((await call('staff', 'POST', `/api/parties/${id}/entries`, { date: '2025-01-11', description: 'x', billed: 1 })).status, 403);
  assert.equal((await call('staff', 'POST', '/api/parties', { type: 'vendor', name: 'x' })).status, 403);
  assert.equal((await call('x', 'GET', '/api/parties?type=vendor')).status, 401); // 비로그인
});

test('직원은 병원 외상 장부는 입력·조회할 수 있지만 삭제는 못 한다', async () => {
  const h = await call('pharm', 'POST', '/api/parties', { type: 'hospital', name: '한사랑' });
  const id = h.data.id;
  const e = await call('staff', 'POST', `/api/parties/${id}/entries`, { date: '2025-11-01', description: '약', billed: 5000 });
  assert.equal(e.status, 201);
  assert.equal((await call('staff', 'GET', `/api/parties/${id}/entries`)).status, 200);
  assert.equal((await call('staff', 'DELETE', `/api/entries/${e.data.id}`)).status, 403);
});

test('기간을 줄여 조회해도 잔고는 이월 포함 누적으로 맞다', async () => {
  const v = await call('pharm', 'POST', '/api/parties', { type: 'vendor', name: '동아제약' });
  const id = v.data.id;
  for (const [d, billed, paid] of [['2020-01-05', 5000, 0], ['2024-03-01', 3000, 0], ['2025-06-01', 0, 2000], ['2026-02-01', 1000, 0]]) {
    await call('pharm', 'POST', `/api/parties/${id}/entries`, { date: d, description: 'e', billed, paid });
  }
  const all = (await call('pharm', 'GET', `/api/parties/${id}/entries`)).data;
  const recent = (await call('pharm', 'GET', `/api/parties/${id}/entries?from=2025-01-01`)).data;
  assert.equal(all.entries.length, 4);
  assert.equal(recent.entries.length, 2);
  assert.equal(recent.opening, 8000);          // 2025-01-01 이전까지의 잔액
  assert.equal(recent.entries[0].balance, 6000);
  assert.equal(recent.balance, all.balance);   // 최종 잔고 동일
  assert.equal(all.balance, 7000);
});

test('금액 칸을 비워도 입력되고, 숫자가 아니면 거부한다', async () => {
  const id = (await call('pharm', 'POST', '/api/parties', { type: 'hospital', name: '빈칸병원' })).data.id;
  const ok = await call('pharm', 'POST', `/api/parties/${id}/entries`, { date: '2025-05-01', description: '입고만', qty: '', billed: '1200', paid: '' });
  assert.equal(ok.status, 201);
  const bad = await call('pharm', 'POST', `/api/parties/${id}/entries`, { date: '2025-05-01', description: 'x', billed: 'abc' });
  assert.equal(bad.status, 400);
  assert.equal((await call('pharm', 'GET', `/api/parties/${id}/entries`)).data.balance, 1200);
});

test('환자 외상: 직원이 입력·완불 체크, 삭제는 약사만', async () => {
  const c = await call('staff', 'POST', '/api/credits', { date: '2025-11-01', name: '테스트환자', rrn_front: '900101', amount: 5300, content: '처방약' });
  assert.equal(c.status, 201);
  assert.equal((await call('staff', 'POST', '/api/credits', { date: '2025-11-01', name: 'a', rrn_front: '12', amount: 1 })).status, 400);
  assert.equal((await call('staff', 'GET', '/api/credits')).data.length, 1);
  await call('staff', 'PATCH', `/api/credits/${c.data.id}`, { paid: true });
  assert.equal((await call('staff', 'GET', '/api/credits')).data.length, 0);          // 미완불만
  assert.equal((await call('staff', 'GET', '/api/credits?status=all')).data.length, 1);
  assert.equal((await call('staff', 'DELETE', `/api/credits/${c.data.id}`)).status, 403);
});

test('직원 비활성화하면 기존 세션도 즉시 끊긴다', async () => {
  const users = (await call('pharm', 'GET', '/api/users')).data;
  const staff = users.find((u) => u.username === 'staff1');
  await call('pharm', 'PATCH', `/api/users/${staff.id}`, { active: false });
  assert.equal((await call('staff', 'GET', '/api/credits')).status, 401);
});
