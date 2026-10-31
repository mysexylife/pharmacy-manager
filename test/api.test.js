import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { todayKST, addDays } from '../public/dates.js';

let server, base, db;
let cookie = '';

before(async () => {
  db = openDb(':memory:');
  server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function raw(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function call(method, path, body) {
  const res = await raw(method, path, body);
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.startsWith('sid=;') ? '' : set.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, res };
}

const ok = async (method, path, body, status = 200) => {
  const r = await call(method, path, body);
  assert.equal(r.status, status, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

// ---------------------------------------------------------------- 로그인
test('처음 한 번만 약사 계정을 만들 수 있고, 로그인 없이는 아무것도 못 본다', async () => {
  assert.equal((await ok('GET', '/api/me')).setup, true);
  assert.equal((await call('GET', '/api/vendors')).status, 401);
  assert.equal((await call('POST', '/api/setup', { username: 'boss', password: 'short' })).status, 400); // 10자 미만
  await ok('POST', '/api/setup', { username: 'boss', password: 'long-enough-pass' });
  assert.equal((await call('POST', '/api/setup', { username: 'evil', password: 'long-enough-pass2' })).status, 403);
  await ok('GET', '/api/vendors');
});

test('로그인 유지를 고르면 쿠키가 오래 남고, 안 고르면 브라우저를 닫을 때까지만', async () => {
  const keep = await call('POST', '/api/login', { username: 'boss', password: 'long-enough-pass', remember: true });
  assert.match(keep.res.headers.get('set-cookie'), /Max-Age=\d+/);
  const brief = await call('POST', '/api/login', { username: 'boss', password: 'long-enough-pass' });
  assert.doesNotMatch(brief.res.headers.get('set-cookie'), /Max-Age/);
  assert.equal((await call('POST', '/api/login', { username: 'boss', password: 'wrong' })).status, 401);
});

test('로그인을 여러 번 틀리면 잠시 잠긴다', async () => {
  let last;
  for (let i = 0; i < 9; i += 1) last = await call('POST', '/api/login', { username: 'lockme', password: 'x' });
  assert.equal(last.status, 429);
  cookie = '';
  await ok('POST', '/api/login', { username: 'boss', password: 'long-enough-pass', remember: true });
});

test('비밀번호를 바꾸면 다른 기기의 로그인은 풀린다', async () => {
  const phone = cookie;
  await ok('POST', '/api/login', { username: 'boss', password: 'long-enough-pass', remember: true });
  const pc = cookie;
  await ok('POST', '/api/password', { current: 'long-enough-pass', next: 'another-long-pass' });
  cookie = phone;
  assert.equal((await call('GET', '/api/vendors')).status, 401);
  cookie = pc;
  await ok('GET', '/api/vendors');
  await ok('POST', '/api/password', { current: 'another-long-pass', next: 'long-enough-pass' });
});

// ---------------------------------------------------------------- 제약회사 장부
let vid;
test('제약회사 장부: 날짜는 어떤 방식으로 써도 같고, 누락 내역은 날짜순으로 끼어든다', async () => {
  vid = (await ok('POST', '/api/vendors', { name: '고려제약' }, 201)).id;
  assert.equal((await call('POST', '/api/vendors', { name: '고려제약' })).status, 409);
  await ok('POST', `/api/vendors/${vid}/entries`, { kind: 'purchase', date: '26.03.10', description: '입고A', amount: '1,000' }, 201);
  await ok('POST', `/api/vendors/${vid}/entries`, { kind: 'purchase', date: '2026-03-20', description: '입고C', amount: 3000 }, 201);
  // 나중에 빠뜨린 것을 넣는다
  await ok('POST', `/api/vendors/${vid}/entries`, { kind: 'purchase', date: '3월 15일', description: '입고B', amount: 2000 }, 201);
  const l = await ok('GET', `/api/vendors/${vid}/ledger`);
  assert.deepEqual(l.entries.map((e) => e.description), ['입고C', '입고B', '입고A']); // 최근 것이 위
  assert.deepEqual(l.entries.map((e) => e.balance), [6000, 3000, 1000]);
  assert.equal(l.entries[0].date, '2026-03-20');
  assert.equal((await call('POST', `/api/vendors/${vid}/entries`, { kind: 'purchase', date: '엉터리', description: 'x', amount: 1 })).status, 400);
  assert.equal((await call('POST', `/api/vendors/${vid}/entries`, { kind: 'purchase', date: '26.03.10', description: 'x', amount: 'abc' })).status, 400);
});

test('기간을 줄여 보아도 이전 잔액을 합쳐 잔고가 맞는다', async () => {
  const l = await ok('GET', `/api/vendors/${vid}/ledger?from=26.03.16`);
  assert.equal(l.entries.length, 1);
  assert.equal(l.opening, 3000);
  assert.equal(l.hasEarlier, true);
  assert.equal(l.balance, 6000);
});

test('이번 달 결제 금액 = 6개월 전 월말 잔고 − 이후 결제액 − 이후 반품액', async () => {
  const v = (await ok('POST', '/api/vendors', { name: '결제계산제약' }, 201)).id;
  const add = (kind, date, amount, description) => ok('POST', `/api/vendors/${v}/entries`, { kind, date, amount, description: description ?? (kind === 'purchase' ? '입고' : '') }, 201);
  await add('purchase', '2026-01-10', 6000000);
  await add('purchase', '2026-04-20', 4000000);   // 4월 말 잔고 = 1,000만 원
  await add('payment', '2026-06-05', 5000000);
  await add('payment', '2026-08-10', 2000000);
  await add('purchase', '2026-09-01', 3000000);   // 4월 말 이후 입고는 이번 결제에 포함되지 않는다
  const find = (due) => due.rows.find((r) => r.id === v);

  let due = await ok('GET', '/api/due?month=2026-10');
  assert.equal(due.cutoff, '2026-04-30');
  assert.equal(find(due).pool, 10000000);
  assert.equal(find(due).paid, 7000000);
  assert.equal(find(due).due, 3000000);
  assert.equal(find(due).balance, 6000000);   // 입고 1,300만 − 결제 700만

  // 반품: 처리 완료를 체크하기 전에는 계산에 들어가지 않는다
  const ret = (await ok('POST', `/api/vendors/${v}/returns`, { date: '26.07.10', item: '콜로덤에스', amount: 500000 }, 201)).id;
  due = await ok('GET', '/api/due?month=2026-10');
  assert.equal(find(due).due, 3000000);
  assert.equal(find(due).pendingReturns, 1);
  assert.equal(due.pending.returns.length >= 1, true);

  await ok('PATCH', `/api/returns/${ret}`, { done: true, done_date: '26.07.20' });
  due = await ok('GET', '/api/due?month=2026-10');
  assert.equal(find(due).returned, 500000);
  assert.equal(find(due).due, 2500000);
  assert.equal(find(due).pendingReturns, 0);
  let ledger = await ok('GET', `/api/vendors/${v}/ledger`);
  const row = ledger.entries.find((e) => e.kind === 'return');
  assert.equal(row.date, '2026-07-20');     // 체크한 날짜로 장부에 들어간다
  assert.equal(row.amount, 500000);
  assert.equal(ledger.balance, 5500000);
  assert.equal(ledger.returns[0].done_date, '2026-07-20');

  // 체크를 풀면 장부에서 빠진다
  await ok('PATCH', `/api/returns/${ret}`, { done: false });
  ledger = await ok('GET', `/api/vendors/${v}/ledger`);
  assert.equal(ledger.entries.some((e) => e.kind === 'return'), false);
  assert.equal(ledger.balance, 6000000);
  await ok('PATCH', `/api/returns/${ret}`, { done: true, done_date: '26.07.20' });

  // 실제 결제액 입력: 예상과 달라도 결제로 기록되어 잔고에 반영된다
  await add('payment', '2026-10-30', 2000000, '결제');
  due = await ok('GET', '/api/due?month=2026-10');
  assert.equal(find(due).due, 500000);
  await add('payment', '2026-10-31', 900000, '결제');
  due = await ok('GET', '/api/due?month=2026-10');
  assert.equal(find(due).due, 0); // 마이너스는 0원으로 본다
  assert.equal(due.total >= 0, true);
});

test('반품: 금액이 없으면 처리 완료를 체크할 수 없고, 완료된 반품은 고칠 수 없다', async () => {
  const v = (await ok('POST', '/api/vendors', { name: '반품규칙제약' }, 201)).id;
  const ret = (await ok('POST', `/api/vendors/${v}/returns`, { date: '26.10.01', item: '약' }, 201)).id;
  assert.equal((await call('PATCH', `/api/returns/${ret}`, { done: true })).status, 400);
  await ok('PATCH', `/api/returns/${ret}`, { amount: 12000 });
  await ok('PATCH', `/api/returns/${ret}`, { done: true });
  assert.equal((await call('PATCH', `/api/returns/${ret}`, { amount: 99 })).status, 400);
  const led = await ok('GET', `/api/vendors/${v}/ledger`);
  const entry = led.entries.find((e) => e.kind === 'return');
  assert.equal((await call('DELETE', `/api/entries/${entry.id}`)).status, 400); // 반품 칸에서만 처리
});

test('차용: 반환 안 된 것은 모아 보이고, 반환하면 날짜가 기록된다', async () => {
  const v = (await ok('POST', '/api/vendors', { name: '차용제약' }, 201)).id;
  const loan = (await ok('POST', `/api/vendors/${v}/loans`, { date: '26.10.20', item: '타이레놀', qty: 3 }, 201)).id;
  let due = await ok('GET', '/api/due?month=2026-10');
  assert.equal(due.rows.find((r) => r.id === v).openLoans, 1);
  assert.equal(due.pending.loans.some((l) => l.id === loan && l.vendor === '차용제약' && l.qty === 3), true);
  await ok('PATCH', `/api/loans/${loan}`, { returned: true, returned_date: '26.10.25' });
  due = await ok('GET', '/api/due?month=2026-10');
  assert.equal(due.rows.find((r) => r.id === v).openLoans, 0);
  const led = await ok('GET', `/api/vendors/${v}/ledger`);
  assert.equal(led.loans[0].returned_date, '2026-10-25');
});

test('확인 메모는 장부와 결제 대상 화면에서 같은 데이터로 보인다', async () => {
  const v = (await ok('POST', '/api/vendors', { name: '메모제약' }, 201)).id;
  const note = (await ok('POST', `/api/vendors/${v}/notes`, { body: '제약사 잔고와 대조' }, 201)).id;
  assert.equal((await ok('GET', '/api/due')).notes.some((n) => n.id === note), true);
  await ok('PATCH', `/api/notes/${note}`, { done: true });
  assert.equal((await ok('GET', '/api/due')).notes.some((n) => n.id === note), false);
  assert.equal((await ok('GET', `/api/vendors/${v}/ledger`)).notes[0].done, 1);
});

test('차량번호 메모와 거래처 비활성화', async () => {
  const v = (await ok('POST', '/api/vendors', { name: '차량제약' }, 201)).id;
  await ok('PATCH', `/api/vendors/${v}`, { car_numbers: '12가3456, 78나9012' });
  assert.equal((await ok('GET', `/api/vendors/${v}/ledger`)).vendor.car_numbers, '12가3456, 78나9012');
  await ok('PATCH', `/api/vendors/${v}`, { active: false });
  assert.equal((await ok('GET', '/api/due')).rows.some((r) => r.id === v), false);
});

// ---------------------------------------------------------------- 병원 외상
test('병원 외상: 처방조제약은 5,000원 할인, 일반의약품은 단가표 × 수량, 단가가 바뀌어도 과거는 그대로', async () => {
  const h = (await ok('POST', '/api/hospitals', { name: '한사랑병원' }, 201)).id;
  const p = (await ok('POST', '/api/hospital-products', { name: '메디폼대', price: 24000 }, 201)).id;
  const rx = await ok('POST', `/api/hospitals/${h}/entries`, { kind: 'rx', date: '26.10.01', item: '홍길동', original: '30,000' }, 201);
  assert.equal(rx.billed, 25000);
  const otc = await ok('POST', `/api/hospitals/${h}/entries`, { kind: 'otc', date: '26.10.02', product_id: p, qty: 2 }, 201);
  assert.equal(otc.billed, 48000);
  await ok('PATCH', `/api/hospital-products/${p}`, { price: 30000 }); // 정가가 바뀐다
  const manual = await ok('POST', `/api/hospitals/${h}/entries`, { kind: 'otc', date: '26.10.03', item: '단가표에 없는 약', billed: 7000 }, 201);
  assert.equal(manual.billed, 7000);
  await ok('POST', `/api/hospitals/${h}/entries`, { kind: 'payment', date: '26.10.05', paid: 50000 }, 201);
  const l = await ok('GET', `/api/hospitals/${h}/ledger`);
  assert.equal(l.balance, 25000 + 48000 + 7000 - 50000);
  const otcRow = l.entries.find((e) => e.kind === 'otc' && e.qty === 2);
  assert.equal(otcRow.billed, 48000); // 단가표를 바꿔도 입력 당시 금액
  const rxRow = l.entries.find((e) => e.kind === 'rx');
  assert.equal(rxRow.original, 30000);
  assert.equal(rxRow.discount, 5000);
  assert.equal((await call('POST', `/api/hospitals/${h}/entries`, { kind: 'rx', date: '26.10.01', item: 'a', original: 1000, discount: 5000 })).status, 400);

  const recent = await ok('GET', `/api/hospitals/${h}/ledger?from=26.10.04`);
  assert.equal(recent.entries.length, 1);
  assert.equal(recent.opening, 80000);
  assert.equal(recent.balance, 30000);
});

test('처방조제약 할인액 기본값은 설정에서 바꾼다', async () => {
  await ok('PUT', '/api/settings', { rx_discount: 3000 });
  const h = (await ok('POST', '/api/hospitals', { name: '설정병원' }, 201)).id;
  const rx = await ok('POST', `/api/hospitals/${h}/entries`, { kind: 'rx', date: '26.10.01', item: '김', original: 10000 }, 201);
  assert.equal(rx.billed, 7000);
  await ok('PUT', '/api/settings', { rx_discount: 5000 });
});

// ---------------------------------------------------------------- 환자 외상
test('환자 외상: 환자별 합계, 연체(30일) 표시와 맨 위 정렬, 완불 체크', async () => {
  const today = todayKST();
  const mk = (body) => ok('POST', '/api/credits', { rrn_front: '900101', ...body }, 201);
  await mk({ date: addDays(today, -40), name: '연체환자', rrn_front: '800202', phone: '010-1111-2222', amount: 10000, content: '처방약' });
  await mk({ date: addDays(today, -5), name: '홍길동', amount: 5300, content: '처방약 + 쿨링시트' });
  await mk({ date: addDays(today, -2), name: '홍길동', amount: 4700 });
  await mk({ date: addDays(today, -1), name: '홍길동', rrn_front: '911111', amount: 1000 }); // 동명이인

  const r = await ok('GET', '/api/credits');
  assert.equal(r.items[0].name, '연체환자');
  assert.equal(r.items[0].overdue, true);
  assert.equal(r.overdueCount, 1);
  assert.equal(r.totalOpen, 21000);
  const hong = r.groups.find((g) => g.name === '홍길동' && g.rrn_front === '900101');
  assert.equal(hong.total, 10000);
  assert.equal(hong.count, 2);
  assert.equal(r.groups.find((g) => g.rrn_front === '911111').total, 1000); // 동명이인은 따로
  assert.equal(r.groups[0].name, '연체환자'); // 연체 환자가 맨 위
  assert.equal(r.groups[0].phone, '010-1111-2222');

  const target = r.items.find((i) => i.name === '연체환자');
  await ok('PATCH', `/api/credits/${target.id}`, { memo_done: true });
  await ok('PATCH', `/api/credits/${target.id}`, { paid: true });
  const after = await ok('GET', '/api/credits');
  assert.equal(after.items.some((i) => i.id === target.id), false);       // 기본은 미완불만
  const all = await ok('GET', '/api/credits?status=all');
  const done = all.items.find((i) => i.id === target.id);
  assert.equal(done.paid, 1);
  assert.equal(done.paid_date, today);
  assert.equal(done.memo_done, 1);
  assert.equal((await ok('GET', '/api/credits?q=길동')).items.every((i) => i.name === '홍길동'), true);
});

test('환자 외상 입력 검사: 주민번호 6자리, 연락처 형식, 일부 납부는 금액 수정', async () => {
  const bad = (b) => call('POST', '/api/credits', { date: '26.10.01', name: '가', amount: 1000, ...b });
  assert.equal((await bad({ rrn_front: '12' })).status, 400);
  assert.equal((await bad({ phone: 'abc' })).status, 400);
  assert.equal((await bad({ amount: 0 })).status, 400);
  const id = (await ok('POST', '/api/credits', { date: '26.10.01', name: '부분납부', amount: 50000 }, 201)).id;
  await ok('PATCH', `/api/credits/${id}`, { amount: 30000, note: '2만원 납부' });
  const row = (await ok('GET', '/api/credits?status=all')).items.find((i) => i.id === id);
  assert.equal(row.amount, 30000);
  assert.equal(row.note, '2만원 납부');
});

// ---------------------------------------------------------------- 휴지통 · 백업 · 내보내기
test('삭제하면 휴지통으로 가고 되살릴 수 있다. 완료된 반품을 지우면 장부의 반품 줄도 함께 빠진다', async () => {
  const v = (await ok('POST', '/api/vendors', { name: '휴지통제약' }, 201)).id;
  const e = (await ok('POST', `/api/vendors/${v}/entries`, { kind: 'purchase', date: '26.10.01', description: '입고', amount: 1000 }, 201)).id;
  await ok('DELETE', `/api/entries/${e}`);
  assert.equal((await ok('GET', `/api/vendors/${v}/ledger`)).entries.length, 0);
  let trash = await ok('GET', '/api/trash');
  assert.equal(trash.some((t) => t.table === 'vendor_entries' && t.id === e), true);
  await ok('POST', '/api/trash/restore', { table: 'vendor_entries', id: e });
  assert.equal((await ok('GET', `/api/vendors/${v}/ledger`)).balance, 1000);

  const ret = (await ok('POST', `/api/vendors/${v}/returns`, { date: '26.10.02', item: '반품약', amount: 400 }, 201)).id;
  await ok('PATCH', `/api/returns/${ret}`, { done: true });
  assert.equal((await ok('GET', `/api/vendors/${v}/ledger`)).balance, 600);
  await ok('DELETE', `/api/returns/${ret}`);
  assert.equal((await ok('GET', `/api/vendors/${v}/ledger`)).balance, 1000);   // 반품 줄도 빠진다
  trash = await ok('GET', '/api/trash');
  assert.equal(trash.some((t) => t.table === 'vendor_entries' && t.label.includes('반품약')), false); // 연결된 줄은 따로 안 보인다
  await ok('POST', '/api/trash/restore', { table: 'vendor_returns', id: ret });
  assert.equal((await ok('GET', `/api/vendors/${v}/ledger`)).balance, 600);   // 함께 돌아온다

  assert.equal((await call('POST', '/api/trash/restore', { table: 'users', id: 1 })).status, 400);
});

test('30일이 지난 휴지통 내역은 비워진다', async () => {
  const id = (await ok('POST', '/api/credits', { date: '26.10.01', name: '오래된삭제', amount: 100 }, 201)).id;
  await ok('DELETE', `/api/credits/${id}`);
  db.prepare('UPDATE credits SET deleted_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', id);
  const second = createApp(db); // 시작할 때 비운다
  second.close();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credits WHERE id = ?').get(id).n, 0);
});

test('백업 파일과 엑셀(CSV) 내보내기', async () => {
  const bk = await raw('GET', '/api/backup');
  assert.equal(bk.status, 200);
  const buf = Buffer.from(await bk.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');

  await ok('POST', '/api/credits', { date: '26.10.01', name: '=수식환자', amount: 100 }, 201);
  const c = await raw('GET', '/api/export/credits.csv');
  const bytes = Buffer.from(await c.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // 엑셀에서 한글이 깨지지 않게
  const text = bytes.toString('utf8');
  assert.match(text, /'=수식환자/);                      // 수식으로 실행되지 않게
  assert.equal((await raw('GET', '/api/export/vendors.csv')).status, 200);
  assert.equal((await raw('GET', '/api/export/hospitals.csv')).status, 200);
});

test('로그아웃하면 다시 로그인해야 한다', async () => {
  await ok('POST', '/api/logout', {});
  assert.equal((await call('GET', '/api/vendors')).status, 401);
});
