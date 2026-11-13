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
    h('thead', {}, h('tr', {}, heads.map(([text, num, left]) => h('th', { class: `${num ? 'num' : ''} ${left ? 'ltext' : ''}` }, text)))),
    h('tbody', {}, rows));
  const card = h('div', { class: `card ledgercard ${className}` }, table);
  // 글자 열(내용·품목 등)은 왼쪽, 나머지는 가운데 정렬. 길어서 잘린 글자는 마우스를 올리면 전체가 보인다.
  const leftCols = new Set(heads.map((hd, i) => (hd[2] ? i : -1)).filter((i) => i >= 0));
  for (const tr of table.tBodies[0].rows) {
    [...tr.cells].forEach((td, i) => {
      if (leftCols.has(i)) td.classList.add('ltext');
      if (!td.title && td.textContent.trim().length > 12) td.title = td.textContent.trim();
    });
  }
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
