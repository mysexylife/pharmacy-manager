import { h } from './lib.js';
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
document.addEventListener('pointerdown', (e) => { if (reveal && !reveal.contains(e.target) && !e.target.closest?.('.ledger td')) closeReveal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReveal(); });
window.addEventListener('scroll', closeReveal, { passive: true });

// 열 너비: '120px'(고정) 또는 'minmax(최소px, 비율fr)'(남는 폭을 비율대로 나눔, 최소 폭 아래로는 줄지 않음)
function parseCols(cols) {
  return cols.map((w) => {
    const px = /^(\d+)px$/.exec(w);
    if (px) return { fixed: Number(px[1]) };
    const m = /^minmax\((\d+)px,\s*([\d.]+)fr\)$/.exec(w);
    return m ? { min: Number(m[1]), weight: Number(m[2]) } : { min: 0, weight: 1 };
  });
}

// 전체 폭을 고정 열 + 비율 열로 나눈 px 너비 목록
function widthsFor(specs, total) {
  const widths = specs.map((c) => c.fixed ?? c.min);
  let free = total - specs.reduce((n, c) => n + (c.fixed ?? 0), 0);
  let flex = specs.map((c, i) => (c.fixed == null ? i : -1)).filter((i) => i >= 0);
  for (let round = 0; round < specs.length && flex.length; round++) {
    const weightSum = flex.reduce((n, i) => n + specs[i].weight, 0);
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

export function sheet({ cols, heads, rows, addCells, focusEl, className = '', filterKey = null }) {
  const specs = parseCols(cols);
  const colEls = cols.map(() => h('col'));
  const table = h('table', { class: 'ledger fixed' },
    h('colgroup', {}, colEls),
    h('thead', {}, h('tr', {}, heads.map(([text, num, left]) => h('th', { class: `${num ? 'num' : ''} ${left ? 'ltext' : ''} ${text === '잔고' ? 'balhead' : ''}` }, text)))),
    h('tbody', {}, rows));
  const card = h('div', { class: `card ledgercard ${className}` }, table);
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
    closeReveal();
    if (card.classList.contains('stack') || td.scrollWidth <= td.clientWidth + 1) return;
    const r = td.getBoundingClientRect();
    reveal = h('div', { class: 'reveal', role: 'tooltip' }, td.textContent.trim());
    reveal.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 380))}px`;
    reveal.style.top = `${r.bottom + 2}px`;
    document.body.append(reveal);
  });
  // 카드 폭이 열들이 들어갈 최소 폭보다 좁아지면 "카드형"(폰 모양)으로 바꾼다. 창 크기가 아니라 실제 표 폭을 기준으로 한다.
  const minWidth = specs.reduce((n, c) => n + (c.fixed ?? c.min), 0) + 24;
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
