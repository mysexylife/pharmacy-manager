import { parseDate, formatDate, todayKST } from './dates.js';

export { formatDate, parseDate, todayKST };

export const state = { me: null, setup: false, tab: 'due', onLogout: () => {} };

// 요소를 만든다. 글자는 항상 텍스트로 넣어서 입력값이 화면 코드로 해석되지 않는다.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && state.me) state.onLogout();
    throw new Error(data?.error ?? `오류 (${res.status})`);
  }
  return data;
}

export const won = (n) => (n == null ? '' : Number(n).toLocaleString('ko-KR'));
export const signed = (n) => (n > 0 ? `+${won(n)}` : won(n));

export function errorBox() {
  const box = h('div', { class: 'error', role: 'alert', hidden: true });
  box.show = (msg) => { box.textContent = msg; box.hidden = false; };
  box.clear = () => { box.hidden = true; };
  return box;
}

let toastTimer;
export function toast(message, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 4500 : 2200);
}

// 폼 제출을 감싸 오류 표시와 중복 제출 방지를 한 번에 처리한다.
export function submit(err, fn) {
  return async (e) => {
    e.preventDefault();
    err.clear();
    const btn = e.submitter;
    if (btn) btn.disabled = true;
    try {
      await fn(new FormData(e.currentTarget), e.currentTarget);
    } catch (ex) {
      err.show(ex.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

// 실패해도 화면이 멈추지 않게 오류만 보여 준다.
export const guard = (err, fn) => async (...args) => {
  err.clear();
  try { await fn(...args); } catch (ex) { err.show(ex.message); }
};

export function field(label, name, opts = {}) {
  const { cls = '', hint, ...input } = opts;
  return h('label', { class: `f ${cls}` }, label, h('input', { name, type: 'text', autocomplete: 'off', ...input }), hint && h('small', {}, hint));
}

export const moneyField = (label, name, opts = {}) => field(label, name, { inputmode: 'numeric', cls: 'narrow', ...opts });

// 날짜 칸: 어떻게 쓰든 26.10.31 형식으로 바뀐다. 달력으로도 고를 수 있다.
export function dateField(label, name = 'date', { value = todayKST(), cls = 'narrow' } = {}) {
  const input = h('input', { name, type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '26.10.31', required: true });
  input.defaultValue = formatDate(value);
  input.value = formatDate(value);
  const picker = h('input', { type: 'date', class: 'datepick', tabindex: '-1', 'aria-hidden': 'true' });
  picker.addEventListener('change', () => {
    if (picker.value) { input.value = formatDate(picker.value); input.setCustomValidity(''); }
  });
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('blur', () => {
    const iso = parseDate(input.value);
    if (iso) input.value = formatDate(iso);
    else if (input.value.trim()) input.setCustomValidity('날짜를 다시 확인하세요 (예: 26.10.31)');
  });
  const cal = h('button', { type: 'button', class: 'btn ghost small', 'aria-label': '달력으로 고르기', onclick: () => picker.showPicker?.() }, '달력');
  return h('label', { class: `f ${cls} datecell` }, label, h('span', { class: 'datewrap' }, input, cal, picker));
}

// 평소에는 접어 두고 버튼을 눌렀을 때만 입력 칸을 연다.
export function collapsible(label, build, { open = false, ghost = false } = {}) {
  const body = h('div', { class: 'fold-body', hidden: !open });
  const btn = h('button', {
    type: 'button', class: `btn${ghost ? ' ghost' : ''}`, 'aria-expanded': String(open),
    onclick: () => (body.hidden ? show() : hide()),
  }, label);
  const show = () => { body.hidden = false; btn.setAttribute('aria-expanded', 'true'); body.querySelector('input:not([type=checkbox]),select')?.focus(); };
  const hide = () => { body.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  body.append(build({ close: hide }));
  return h('div', { class: 'fold' }, btn, body);
}

export function segmented(label, options, current, onPick) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([value, text]) => h('button', {
      type: 'button', 'aria-pressed': String(value === current),
      onclick: () => onPick(value),
    }, text)));
}

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);

export function confirmDelete(what) {
  return confirm(`${what}을(를) 삭제할까요?\n삭제해도 30일 동안은 설정의 휴지통에서 되살릴 수 있어요.`);
}

export function telLink(phone) {
  return phone ? h('a', { class: 'tel', href: `tel:${phone.replace(/[^0-9+]/g, '')}` }, phone) : null;
}

// ---- 화면 꾸밈 부품 ------------------------------------------------------
const ICONS = {
  due: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  vendors: '<path d="M16.5 9.4l-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  hospitals: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  credits: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
};

// 아이콘은 위의 고정된 도형만 쓴다 (입력값이 들어가지 않는다).
export function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

// 페이지 맨 위: 제목은 왼쪽, 검색·주요 버튼은 오른쪽.
export function pageHead(title, ...actions) {
  return h('div', { class: 'pagehead' }, h('h1', {}, title), h('div', { class: 'actions' }, ...actions));
}

export function searchBox(label, onInput, value = '') {
  const input = h('input', { type: 'search', placeholder: label, 'aria-label': label, value, oninput: (e) => onInput(e.target.value) });
  return h('label', { class: 'searchbox' }, icon('search'), input);
}

// 밑줄 탭. counts가 있으면 이름 옆에 건수를 붙인다.
export function tabs(label, items, current, onPick) {
  return h('div', { class: 'tabstrip', role: 'tablist', 'aria-label': label },
    items.map(([value, text, count]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(value === current), onclick: () => onPick(value),
    }, count == null ? text : `${text} (${count})`)));
}

// 행 끝의 "…" 메뉴. 지금은 삭제 하나만 있다.
export function rowMenu(onDelete) {
  const menu = h('div', { class: 'menu', hidden: true, role: 'menu' },
    h('button', { type: 'button', role: 'menuitem', class: 'danger', onclick: (e) => { menu.hidden = true; onDelete(e); } }, '삭제'));
  const trigger = h('button', { type: 'button', class: 'kebab', 'aria-label': '더 보기', 'aria-haspopup': 'menu', onclick: (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
    menu.hidden = !willOpen;
  } }, '⋯');
  return h('span', { class: 'menuwrap' }, trigger, menu);
}
document.addEventListener('click', () => document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; }));

// 페이지 제목 줄 오른쪽에 둘 버튼과, 눌렀을 때 아래에 펼쳐질 입력 카드를 짝으로 만든다.
export function foldPair(label, build) {
  const body = h('div', { class: 'card foldcard', hidden: true });
  const trigger = h('button', { type: 'button', class: 'btn', 'aria-expanded': 'false', onclick: () => (body.hidden ? show() : hide()) }, `+ ${label}`);
  const show = () => { body.hidden = false; trigger.setAttribute('aria-expanded', 'true'); body.querySelector('input:not([type=checkbox]),select')?.focus(); };
  const hide = () => { body.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
  body.append(build({ close: hide }));
  return { trigger, body };
}

// 빨간 십자 로고 (고정된 도형만 쓴다).
export function logo() {
  const span = document.createElement('span');
  span.className = 'logo';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 2.5h6a1 1 0 0 1 1 1V8h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H16v4.5a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V16H3.5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1H8V3.5a1 1 0 0 1 1-1z" fill="#e5322d"/></svg>';
  return span;
}

// 표 한 칸에 들어가는 작은 날짜 입력: 어떻게 쓰든 26.10.31 형식으로 바뀌고, 달력으로도 고를 수 있다.
export function dateInput(name, value = todayKST()) {
  const input = h('input', { name, type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '26.10.31', 'aria-label': '날짜' });
  input.defaultValue = formatDate(value);
  input.value = formatDate(value);
  const picker = h('input', { type: 'date', class: 'datepick', tabindex: '-1', 'aria-hidden': 'true' });
  picker.addEventListener('change', () => { if (picker.value) { input.value = formatDate(picker.value); input.setCustomValidity(''); } });
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('blur', () => {
    const iso = parseDate(input.value);
    if (iso) input.value = formatDate(iso);
    else if (input.value.trim()) input.setCustomValidity('날짜를 다시 확인하세요 (예: 26.10.31)');
  });
  const cal = h('button', { type: 'button', class: 'iconbtn small', tabindex: '-1', 'aria-label': '달력으로 고르기', onclick: () => picker.showPicker?.() }, icon('calendar'));
  return { input, node: h('span', { class: 'datewrap cell' }, input, cal, picker) };
}
