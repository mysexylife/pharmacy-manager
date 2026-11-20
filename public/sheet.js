import { h, toast, startInlineEdit } from './lib.js';
import { attachFilters } from './filter.js';

// 엑셀 같은 내역표: 열 너비가 고정된 표 + 바로 아래에 붙는 입력 줄.
// 표가 길어도 입력 줄은 화면 아래쪽에 계속 붙어 있어서, 표 어디를 보고 있든 바로 추가할 수 있다.
//   cols      각 열의 너비 ('112px' 또는 남는 폭을 쓰는 'minmax(0, 1fr)')
//   heads     [열 이름, 숫자 열이면 true] 목록 (입력 줄의 칸과 같은 순서)
//   rows      표의 줄들 (오래된 순서)
//   addCells  입력 줄의 칸들 (cell()로 만든다). 없으면 입력 줄 없이 표만 보여 준다.
//   focusEl   "+ 행 추가" 버튼을 누르면 커서가 갈 곳 (폰)
export const cell = (label, ...kids) => h('div', { class: 'cell', 'data-label': label }, ...kids);

// 잘린 칸의 전체 글자 보기 창 (한 번에 하나만, 바깥을 누르거나 Esc·스크롤하면 닫힘)
let reveal = null;
function closeReveal() { reveal?.remove(); reveal = null; }
function openReveal(anchor, text) {
  closeReveal();
  const r = anchor.getBoundingClientRect();
  reveal = h('div', { class: 'reveal', role: 'tooltip' }, text);
  reveal.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 380))}px`;
  reveal.style.top = `${r.bottom + 2}px`;
  document.body.append(reveal);
}
document.addEventListener('pointerdown', (e) => { if (reveal && !reveal.contains(e.target) && !e.target.closest?.('.ledger td')) closeReveal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReveal(); });
window.addEventListener('scroll', closeReveal, { passive: true });

// 방금 추가한 줄(data-id)로 화면을 옮기고 잠깐 강조한다
export function revealRow(id) {
  if (id == null) return;
  setTimeout(() => {
    const tr = document.querySelector(`.ledger tbody tr[data-id="${id}"]`);
    if (!tr) return;
    tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
    tr.classList.add('justadded');
    setTimeout(() => tr.classList.remove('justadded'), 2200);
  }, 60);
}

// ---- 칸 선택: 한 번 누르면 칸이 선택된다 (←→↑↓·Tab 이동, Enter = 고치기, Esc = 선택 해제) ----
const selected = new Map(); // 표 종류 -> { id: 줄 id, col: 칸 번호 }
function selectCell(card, key, td) {
  card.querySelectorAll('tbody td.selected').forEach((x) => x.classList.remove('selected'));
  td.classList.add('selected');
  selected.set(key, { id: td.parentElement.dataset.id, col: td.cellIndex });
}
document.addEventListener('keydown', (e) => {
  const td = document.querySelector('.ledgercard tbody td.selected');
  if (!td || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const t = document.activeElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const card = td.closest('.ledgercard');
  const tr = td.parentElement;
  const rows = [...card.querySelectorAll('tbody tr[data-id]')].filter((x) => !x.hidden);
  const move = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }[e.key];
  if (move) {
    const row = rows[rows.indexOf(tr) + move[0]];
    const next = row?.cells[td.cellIndex + move[1]];
    if (!next) return;
    e.preventDefault();
    selectCell(card, card.dataset.selkey, next);
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } else if (e.key === 'Tab') { // Tab = 다음 칸(줄 끝이면 다음 줄 처음), Shift+Tab = 이전 칸
    const cells = rows.flatMap((r) => [...r.cells]);
    const next = cells[cells.indexOf(td) + (e.shiftKey ? -1 : 1)];
    if (!next) return; // 표의 처음·끝이면 원래 Tab 동작
    e.preventDefault();
    selectCell(card, card.dataset.selkey, next);
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (td.dataset.edit) td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    else td.querySelector('input[type=text]')?.focus();
  } else if (e.key === 'Escape') {
    td.classList.remove('selected');
    selected.delete(card.dataset.selkey);
  }
});

// 열 너비: '120px'(고정) / 'minmax(최소px, 비율fr)'(남는 폭을 비율대로 나눔, 최소 폭 아래로는 줄지 않음)
//          / 'minmax(최소px, 최대px)'(최소~최대 사이에서 쓰고, 넓어져도 최대를 넘지 않음)
function parseCols(cols) {
  return cols.map((w) => {
    const px = /^(\d+)px$/.exec(w);
    if (px) return { fixed: Number(px[1]) };
    const m = /^minmax\((\d+)px,\s*([\d.]+)fr\)$/.exec(w);
    if (m) return { min: Number(m[1]), weight: Number(m[2]) };
    const c = /^minmax\((\d+)px,\s*(\d+)px\)$/.exec(w);
    return c ? { min: Number(c[1]), max: Number(c[2]), weight: 1 } : { min: 0, weight: 1 };
  });
}

// 폭이 모자라도 표를 유지하기 위해, 비율 열의 최소 폭은 60%까지 줄어들 수 있다(그보다 좁으면 카드형으로 바꾼다)
const SHRINK = 0.6;

// 전체 폭을 고정 열 + 비율 열로 나눈 px 너비 목록
function widthsFor(specs, total) {
  const fixedSum = specs.reduce((n, c) => n + (c.fixed ?? 0), 0);
  const minSum = specs.reduce((n, c) => n + (c.fixed == null ? c.min : 0), 0);
  const k = minSum ? Math.min(1, Math.max(SHRINK, (total - fixedSum) / minSum)) : 1;
  specs = specs.map((c) => (c.fixed == null ? { ...c, min: c.min * k } : c));
  const widths = specs.map((c) => c.fixed ?? c.min);
  let free = total - fixedSum;
  let flex = specs.map((c, i) => (c.fixed == null ? i : -1)).filter((i) => i >= 0);
  for (let round = 0; round < specs.length && flex.length; round++) {
    const weightSum = flex.reduce((n, i) => n + specs[i].weight, 0);
    const tooBig = flex.filter((i) => specs[i].max != null && (free * specs[i].weight) / weightSum > specs[i].max);
    if (tooBig.length) {
      for (const i of tooBig) { widths[i] = specs[i].max; free -= specs[i].max; }
      flex = flex.filter((i) => !tooBig.includes(i));
      continue;
    }
    const tooSmall = flex.filter((i) => (free * specs[i].weight) / weightSum < specs[i].min);
    if (!tooSmall.length) {
      for (const i of flex) widths[i] = Math.floor((free * specs[i].weight) / weightSum);
      break;
    }
    for (const i of tooSmall) { widths[i] = specs[i].min; free -= specs[i].min; }
    flex = flex.filter((i) => !tooSmall.includes(i));
  }
  return widths;
}

// 모든 열이 고정 또는 최대 폭이 있으면, 표가 가질 수 있는 가장 넓은 폭(카드 여백 포함). 남는 열이 있으면 null.
export function idealWidth(cols) {
  const specs = parseCols(cols);
  if (specs.some((c) => c.fixed == null && c.max == null)) return null;
  return specs.reduce((n, c) => n + (c.fixed ?? c.max), 0) + 18;
}

export function sheet({ cols, heads, rows, addCells, focusEl, className = '', filterKey = null, onEdit = null }) {
  const selKey = filterKey ?? className;
  const specs = parseCols(cols);
  const colEls = cols.map(() => h('col'));
  const table = h('table', { class: 'ledger fixed' },
    h('colgroup', {}, colEls),
    h('thead', {}, h('tr', {}, heads.map(([text, num, left]) => h('th', { class: `${num ? 'num' : ''} ${left ? 'ltext' : ''} ${text === '잔고' ? 'balhead' : ''}` }, text)))),
    h('tbody', {}, rows));
  const card = h('div', { class: `card ledgercard ${className}` }, table);
  card.dataset.selkey = selKey;
  const ideal = idealWidth(cols);
  if (ideal) card.style.maxWidth = `${ideal}px`; // 모든 열에 최대 폭이 있으면 표를 그 폭에서 멈추고 더 넓히지 않는다
  // 글자 열(내용·품목 등)은 왼쪽, 나머지는 가운데 정렬. 길어서 잘린 글자는 마우스를 올리면 전체가 보인다.
  const leftCols = new Set(heads.map((hd, i) => (hd[2] ? i : -1)).filter((i) => i >= 0));
  for (const tr of table.tBodies[0].rows) {
    [...tr.cells].forEach((td, i) => {
      if (leftCols.has(i)) td.classList.add('ltext');
    });
  }
  // 잘려 보이는 칸을 누르면 전체 글자가 떠서 보인다 (줄 높이는 그대로)
  table.tBodies[0].addEventListener('click', (e) => {
    const td = e.target.closest('td');
    if (!td || e.target.closest('input, button, label, a, select')) return;
    if (td.closest('tr[data-id]')) selectCell(card, selKey, td);
    closeReveal();
    if (card.classList.contains('stack') || td.scrollWidth <= td.clientWidth + 1) return;
    openReveal(td, td.textContent.trim());
  });
  // 직접 고치는 글자 칸(비고 등)은 눌러서 글을 고치는 동안 전체 글자를 아래에 띄워 보여 준다
  table.tBodies[0].addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.tagName !== 'INPUT' || el.type !== 'text' || el.scrollWidth <= el.clientWidth + 1 || card.classList.contains('stack')) return;
    openReveal(el, el.value);
    const sync = () => { if (el.scrollWidth > el.clientWidth + 1 || el.value) openReveal(el, el.value); };
    el.addEventListener('input', sync);
    el.addEventListener('blur', () => { el.removeEventListener('input', sync); closeReveal(); }, { once: true });
  });
  // 칸을 두 번 누르면 그 자리에서 고친다 (Enter = 저장, Esc = 취소, 다른 곳을 누르면 저장).
  // 고칠 수 있는 칸은 data-edit(칸 이름)과 data-raw(고칠 때 보여 줄 글자)를 가진다.
  if (onEdit) {
    card.classList.add('editable');
    table.tBodies[0].addEventListener('dblclick', (e) => {
      const td = e.target.closest('td[data-edit]');
      const tr = td?.closest('tr');
      if (!td || !tr?.dataset.id) return;
      closeReveal();
      const before = td.dataset.raw ?? td.textContent.trim();
      startInlineEdit(td, before, (next) => onEdit(tr.dataset.id, td.dataset.edit, next, before, tr), `${td.dataset.edit} 고치기`);
    });
    card.prepend(h('div', { class: 'edithint' }, '칸을 두 번 누르면 고칠 수 있어요'));
  }
  // 카드 폭이 열들이 들어갈 최소 폭보다 좁아지면 "카드형"(폰 모양)으로 바꾼다. 창 크기가 아니라 실제 표 폭을 기준으로 한다.
  const minWidth = specs.reduce((n, c) => n + (c.fixed ?? c.min * SHRINK), 0) + 24;
  let bar = null;
  const fit = () => {
    const stacked = card.clientWidth > 0 && card.clientWidth < minWidth;
    card.classList.toggle('stack', stacked);
    if (stacked || !card.clientWidth) { if (bar) bar.style.gridTemplateColumns = ''; return; }
    const widths = widthsFor(specs, card.clientWidth - 16);
    widths.forEach((w, i) => { colEls[i].style.width = `${w}px`; });
    if (bar) bar.style.gridTemplateColumns = widths.map((w) => `${w}px`).join(' ');
  };
  new ResizeObserver(fit).observe(card);
  if (addCells) {
    bar = h('div', { class: 'addbar' }, addCells);
    addCells.forEach((c, i) => { if (leftCols.has(i)) c.classList.add('ltext'); });
    // 엑셀처럼 방향키(← →)로 칸 이동: 글자 맨 앞/맨 뒤에서 누르면 옆 칸으로 가고, 칸에 들어가면 글자가 전체 선택된다.
    // ↓ 방향키도 Enter처럼 입력한 내용을 추가한다
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      bar.querySelector('.btn.small')?.click();
    });
    bar.addEventListener('keydown', (e) => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const el = e.target;
      if (el.tagName !== 'INPUT') return;
      const isText = el.type === 'text';
      if (isText && (el.selectionStart !== el.selectionEnd
        || (e.key === 'ArrowLeft' && el.selectionStart > 0)
        || (e.key === 'ArrowRight' && el.selectionEnd < el.value.length))) return; // 글자 사이에서는 커서 이동
      const fields = [...bar.querySelectorAll('input')].filter((x) => x.type !== 'date' && x.type !== 'hidden' && x.tabIndex >= 0 && !x.disabled);
      const next = fields[fields.indexOf(el) + (e.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      next.focus();
      if (next.type === 'text') next.select();
    });
    card.append(bar, h('button', { type: 'button', class: 'btn addfab', onclick: () => {
      bar.scrollIntoView({ block: 'center', behavior: 'smooth' });
      focusEl?.focus({ preventScroll: true });
    } }, '+ 행 추가'));
  }
  if (selected.get(selKey)) { // 다시 그려도 선택한 칸은 그대로 선택된 상태로
    const sel = selected.get(selKey);
    table.tBodies[0].querySelector(`tr[data-id="${sel.id}"]`)?.cells[sel.col]?.classList.add('selected');
  }
  if (filterKey) attachFilters(card, filterKey, heads);
  requestAnimationFrame(() => {
    fit();
    // 위쪽에 붙어 다니는 제목 막대(제약회사 이름 등)가 있으면 열 제목은 그 아래에 붙는다
    const stickyBar = document.querySelector('.stickybar');
    if (stickyBar) {
      const place = () => card.style.setProperty('--thead-top', `${Math.round((parseFloat(getComputedStyle(stickyBar).top) || 0) + stickyBar.offsetHeight)}px`);
      place();
      new ResizeObserver(place).observe(stickyBar);
    }
  });
  return card;
}
