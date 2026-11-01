import { h } from './lib.js';

// 엑셀 같은 내역표: 열 너비가 고정된 표 + 바로 아래에 붙는 입력 줄.
// 표가 길어도 입력 줄은 화면 아래쪽에 계속 붙어 있어서, 표 어디를 보고 있든 바로 추가할 수 있다.
//   cols      각 열의 너비 ('112px' 또는 남는 폭을 쓰는 'minmax(0, 1fr)')
//   heads     [열 이름, 숫자 열이면 true] 목록 (입력 줄의 칸과 같은 순서)
//   rows      표의 줄들 (오래된 순서)
//   addCells  입력 줄의 칸들 (cell()로 만든다). 없으면 입력 줄 없이 표만 보여 준다.
//   focusEl   "+ 행 추가" 버튼을 누르면 커서가 갈 곳 (폰)
export const cell = (label, ...kids) => h('div', { class: 'cell', 'data-label': label }, ...kids);

export function sheet({ cols, heads, rows, addCells, focusEl, className = '' }) {
  const colgroup = h('colgroup', {}, cols.map((w) => {
    const col = h('col');
    if (!w.startsWith('minmax')) col.style.width = w;
    return col;
  }));
  const table = h('table', { class: 'ledger fixed' },
    colgroup,
    h('thead', {}, h('tr', {}, heads.map(([text, num]) => h('th', { class: num ? 'num' : '' }, text)))),
    h('tbody', {}, rows));
  const card = h('div', { class: `card ledgercard ${className}` }, table);
  if (addCells) {
    const bar = h('div', { class: 'addbar' }, addCells);
    bar.style.gridTemplateColumns = cols.join(' ');
    card.append(bar, h('button', { type: 'button', class: 'btn addfab', onclick: () => {
      bar.scrollIntoView({ block: 'center', behavior: 'smooth' });
      focusEl?.focus({ preventScroll: true });
    } }, '+ 행 추가'));
  }
  return card;
}
