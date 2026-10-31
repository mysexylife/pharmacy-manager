// 날짜 처리. 서버와 화면이 같은 파일을 쓴다.
// 저장은 YYYY-MM-DD, 화면 표시는 YY.MM.DD (예: 26.10.31). 날짜는 한국 시간 기준이다.
const pad = (n) => String(n).padStart(2, '0');

function build(y, m, d) {
  if (![y, m, d].every(Number.isInteger)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function todayKST(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 어떤 방식으로 써도 같은 날짜로 읽는다: 26.10.31, 2026-10-31, 26/10/31, 10.31, 10월 31일, 261031, 1031 ...
// 연도를 생략하면 올해로 본다.
export function parseDate(input, today = todayKST()) {
  if (typeof input !== 'string') return null;
  const thisYear = String(today.slice(0, 4));
  let s = input.trim().replace(/\s+/g, '');
  if (!s) return null;
  s = s.replace(/[년월]/g, '.').replace(/일/g, '').replace(/[/-]/g, '.').replace(/\.+$/, '');
  let parts;
  if (/^\d+$/.test(s)) {
    if (s.length === 8) parts = [s.slice(0, 4), s.slice(4, 6), s.slice(6)];
    else if (s.length === 6) parts = [s.slice(0, 2), s.slice(2, 4), s.slice(4)];
    else if (s.length === 4) parts = [thisYear, s.slice(0, 2), s.slice(2)];
    else return null;
  } else if (/^\d+(\.\d+){1,2}$/.test(s)) {
    parts = s.split('.');
    if (parts.length === 2) parts.unshift(thisYear);
  } else {
    return null;
  }
  if (parts[0].length !== 4 && parts[0].length > 2) return null;
  let [y, m, d] = parts.map(Number);
  if (parts[0].length <= 2) y += 2000;
  return build(y, m, d);
}

export function formatDate(iso) {
  return iso ? iso.slice(2).replace(/-/g, '.') : '';
}

const parts = (iso) => iso.split('-').map(Number);

export function addMonths(iso, n) {
  const [y, m, d] = parts(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}

export function endOfMonth(iso) {
  const [y, m] = parts(iso);
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

export function addDays(iso, n) {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  const a = Date.UTC(...parts(fromIso).map((v, i) => (i === 1 ? v - 1 : v)));
  const b = Date.UTC(...parts(toIso).map((v, i) => (i === 1 ? v - 1 : v)));
  return Math.round((b - a) / 86400000);
}

export const monthOf = (iso) => iso.slice(0, 7);
