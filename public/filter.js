import { h, parseDate, todayKST } from './lib.js';

// 엑셀 같은 열 필터. 열 제목의 ▾를 누르면 그 열의 값으로 줄이 걸러진다.
// 필터는 이 브라우저 화면이 열려 있는 동안 기억한다 (표가 다시 그려져도 유지).
const saved = new Map(); // key -> { 열번호: { q, values, min, max, from, to } }

function cellValue(td) {
  if (!td) return '';
  const cb = td.querySelector('input[type=checkbox]');
  if (cb) return cb.checked ? '예' : '아니오';
  const input = td.querySelector('input');
  if (input) return input.value.trim();
  return td.textContent.trim().replace(/\s+/g, ' ');
}
const toNumber = (v) => {
  const s = String(v).replace(/[,\s원+]/g, '');
  return s === '' || !Number.isFinite(Number(s)) ? null : Number(s);
};
const toDate = (v) => parseDate(String(v).split(' ')[0], todayKST());

function typeOf([label, num]) {
  if (label === '') return null;
  if (num) return 'num';
  if (/날짜$/.test(label)) return 'date';
  return 'text';
}

function matches(f, type, raw) {
  if (!f) return true;
  if (type === 'text') {
    if (f.q && !raw.toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.values && !f.values.has(raw)) return false;
  } else if (type === 'num') {
    const n = toNumber(raw);
    if ((f.min != null || f.max != null) && n == null) return false;
    if (f.min != null && n < f.min) return false;
    if (f.max != null && n > f.max) return false;
  } else if (type === 'date') {
    const d = toDate(raw);
    if ((f.from || f.to) && !d) return false;
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
  }
  return true;
}

const isEmpty = (f) => !f || (!f.q && !f.values && f.min == null && f.max == null && !f.from && !f.to);

export function attachFilters(card, key, heads) {
  const table = card.querySelector('table');
  const tbody = table.querySelector('tbody');
  const ths = [...table.querySelectorAll('thead th')];
  const types = heads.map(typeOf);
  const state = saved.get(key) ?? {};
  saved.set(key, state);
  let find = '';
  let popover = null;

  const dataRows = () => [...tbody.querySelectorAll('tr')].filter((tr) => !tr.classList.contains('opening') && !tr.classList.contains('emptyrow'));
  const bar = h('div', { class: 'filterbar' });
  const finder = h('input', { type: 'search', class: 'stackfind', placeholder: '표에서 찾기', 'aria-label': '표에서 찾기' });
  finder.addEventListener('input', () => { find = finder.value.trim(); apply(); });
  card.prepend(bar);
  bar.append(finder);
  const status = h('div', { class: 'filterstatus', hidden: true });
  bar.append(status);

  function apply() {
    const rows = dataRows();
    let shown = 0;
    for (const tr of rows) {
      const tds = [...tr.children];
      let ok = true;
      for (const [i, f] of Object.entries(state)) {
        if (isEmpty(f)) continue;
        if (!matches(f, types[i], cellValue(tds[i]))) { ok = false; break; }
      }
      if (ok && find && !tr.textContent.toLowerCase().includes(find.toLowerCase())) ok = false;
      tr.hidden = !ok;
      if (ok) shown += 1;
    }
    ths.forEach((th, i) => th.querySelector('.fbtn')?.classList.toggle('on', !isEmpty(state[i])));
    const active = Object.values(state).some((f) => !isEmpty(f)) || find !== '';
    status.hidden = !active;
    status.replaceChildren(h('span', {}, `필터 적용 중 · ${shown} / ${rows.length}줄`),
      h('button', { type: 'button', class: 'linklike', onclick: () => { for (const k of Object.keys(state)) delete state[k]; find = ''; finder.value = ''; apply(); } }, '필터 모두 지우기'));
  }

  function closePopover() {
    popover?.remove();
    popover = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  }
  const outside = (e) => { if (popover && !popover.contains(e.target) && !e.target.closest?.('.fbtn')) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') closePopover(); };

  function open(i, th) {
    closePopover();
    const type = types[i];
    const f = state[i] ?? (state[i] = {});
    const body = [];
    const set = () => { if (isEmpty(f)) delete state[i]; apply(); };

    if (type === 'text') {
      const q = h('input', { type: 'text', placeholder: '포함하는 글자', value: f.q ?? '', 'aria-label': '포함하는 글자' });
      q.addEventListener('input', () => { f.q = q.value.trim(); set(); });
      body.push(q);
      const all = new Set(dataRows().map((tr) => cellValue(tr.children[i])));
      if (all.size <= 100) {
        const vals = [...all].sort((a, b) => a.localeCompare(b, 'ko'));
        const checked = () => f.values ?? new Set(vals);
        const list = h('div', { class: 'fvalues' }, vals.map((v) => {
          const cb = h('input', { type: 'checkbox', checked: checked().has(v) });
          cb.addEventListener('change', () => {
            const cur = new Set(checked());
            if (cb.checked) cur.add(v); else cur.delete(v);
            f.values = cur.size === vals.length ? null : cur;
            set();
          });
          return h('label', { class: 'check' }, cb, v === '' ? '(비어 있음)' : v);
        }));
        body.push(list,
          h('div', { class: 'frow' },
            h('button', { type: 'button', class: 'linklike', onclick: () => { f.values = null; set(); open(i, th); } }, '모두 선택'),
            h('button', { type: 'button', class: 'linklike', onclick: () => { f.values = new Set(); set(); open(i, th); } }, '모두 해제')));
      }
    } else if (type === 'num') {
      const mk = (label, prop) => {
        const el = h('input', { type: 'text', inputmode: 'numeric', placeholder: label, value: f[prop] != null ? String(f[prop]) : '', 'aria-label': label });
        el.addEventListener('input', () => { f[prop] = toNumber(el.value); set(); });
        return el;
      };
      body.push(h('div', { class: 'frow2' }, mk('이상', 'min'), h('span', {}, '~'), mk('이하', 'max')));
    } else if (type === 'date') {
      const mk = (label, prop) => {
        const el = h('input', { type: 'text', placeholder: label, value: f[prop] ? f[prop].slice(2).replace(/-/g, '.') : '', 'aria-label': label });
        el.addEventListener('input', () => { f[prop] = el.value.trim() ? toDate(el.value) : null; set(); });
        return el;
      };
      body.push(h('div', { class: 'frow2' }, mk('시작 (예: 26.10.01)', 'from'), h('span', {}, '~'), mk('끝', 'to')));
    }
    body.push(h('div', { class: 'frow' }, h('button', { type: 'button', class: 'linklike', onclick: () => { delete state[i]; apply(); closePopover(); } }, '이 열 필터 지우기')));
    popover = h('div', { class: 'fpop', role: 'dialog', 'aria-label': `${heads[i][0]} 필터` }, ...body);
    th.append(popover);
    // 오른쪽 끝 열이면 왼쪽으로 열어 화면 밖으로 나가지 않게 한다
    const r = th.getBoundingClientRect();
    if (r.left + 260 > window.innerWidth) popover.classList.add('right');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    popover.querySelector('input[type=text]')?.focus();
  }

  ths.forEach((th, i) => {
    if (!types[i]) return;
    th.classList.add('hasfilter');
    th.append(h('button', { type: 'button', class: 'fbtn', 'aria-label': `${heads[i][0]} 필터`, title: '이 열 필터', onclick: (e) => { e.stopPropagation(); popover && th.contains(popover) ? closePopover() : open(i, th); } }, '▾'));
  });
  apply();
}
