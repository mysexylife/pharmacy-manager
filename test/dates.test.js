import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, formatDate, addMonths, endOfMonth, daysBetween, todayKST } from '../public/dates.js';

const T = '2026-10-31';

test('어떤 방식으로 써도 같은 날짜로 읽는다', () => {
  for (const s of ['26.10.31', '2026-10-31', '2026.10.31', '26/10/31', '26-10-31', '10월 31일', '26년 10월 31일',
    '261031', '20261031', '1031', '10.31', '10/31', ' 26.10.31. ']) {
    assert.equal(parseDate(s, T), '2026-10-31', s);
  }
});

test('연도를 생략하면 올해로 본다', () => {
  assert.equal(parseDate('3.5', '2026-10-31'), '2026-03-05');
  assert.equal(parseDate('3/5', '2027-01-02'), '2027-03-05');
});

test('없는 날짜와 이상한 입력은 거부한다', () => {
  for (const s of ['', 'abc', '26.13.01', '26.02.30', '2026.2', '99999', '26.10.31.1', null, 20261031]) {
    assert.equal(parseDate(s, T), null, String(s));
  }
  assert.equal(parseDate('24.02.29', T), '2024-02-29'); // 윤년
});

test('표시 형식은 YY.MM.DD', () => {
  assert.equal(formatDate('2026-10-31'), '26.10.31');
  assert.equal(formatDate('2026-01-05'), '26.01.05');
});

test('월 계산', () => {
  assert.equal(addMonths('2026-10-31', -6), '2026-04-30');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-01-15', -2), '2025-11-15');
  assert.equal(endOfMonth('2026-02-10'), '2026-02-28');
  assert.equal(endOfMonth(addMonths('2026-10-01', -6)), '2026-04-30');
  assert.equal(daysBetween('2026-10-01', '2026-10-31'), 30);
});

test('오늘은 한국 시간 기준', () => {
  assert.equal(todayKST(new Date('2026-10-30T16:00:00Z')), '2026-10-31');
  assert.equal(todayKST(new Date('2026-10-30T14:59:00Z')), '2026-10-30');
});
