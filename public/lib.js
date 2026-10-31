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
export function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
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
