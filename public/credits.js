import {
  h, api, won, errorBox, guard, tabs, badge, confirmDelete, formatDate, parseDate, todayKST, toast, telLink, pageHead, searchBox, rowMenu, dateInput,
} from './lib.js';
import { sheet, cell } from './sheet.js';
import { created, deleted, patched } from './undo.js';

const moneyOf = (text) => {
  const s = String(text ?? '').replace(/[,\s원]/g, '');
  if (s === '') return 0;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error('금액은 숫자로 입력하세요');
  return n;
};

// 환자 외상: 한 줄이 한 건. 오래된 순서이고 맨 아래 입력 행에 쓴다.
// 완불 처리한 건은 "완불 내역" 탭에서 따로 본다. 환자 이름을 누르면 그 환자의 전체 외상 목록이 열린다.
export function creditsView() {
  const err = errorBox();
  const stats = h('div', { class: 'stats' });
  const body = h('div', { class: 'card flush' });
  const tabBox = h('div');
  const list = h('div');
  let tab = 'open'; // open(미완불) | overdue(연체) | paid(완불 내역)
  let query = '';
  let counts = { open: 0, overdue: 0 };
  let lastDate = todayKST();
  let refocus = false;
  let refs = {};

  const load = guard(err, async () => {
    const d = await api('GET', `/api/credits?status=${tab === 'paid' ? 'paid' : 'open'}&q=${encodeURIComponent(query.trim())}`);
    counts = { open: d.openCount, overdue: d.overdueCount };
    const items = tab === 'overdue' ? d.items.filter((i) => i.overdue) : d.items;
    stats.replaceChildren(
      h('div', { class: 'stat' }, h('span', {}, '미수금 합계'), h('b', {}, `${won(d.totalOpen)}원`)),
      h('div', { class: 'stat' }, h('span', {}, '미완불'), h('b', {}, `${d.openCount}건`)),
      h('div', { class: 'stat' }, h('span', {}, `연체 (${d.overdueDays}일 이상)`), h('b', { class: d.overdueCount ? 'neg' : '' }, `${d.overdueCount}건`)));
    drawTabs();
    list.replaceChildren(table(items, d));
    if (refocus) { refs.name?.focus(); refocus = false; }
  });
  const act = (fn, message) => guard(err, async (...a) => {
    await fn(...a);
    if (message) toast(message);
    await load();
  });

  function drawTabs() {
    tabBox.replaceChildren(tabs('보기', [['open', '미완불', counts.open], ['overdue', '연체', counts.overdue], ['paid', '완불 내역']], tab, (v) => {
      tab = v;
      load();
    }));
  }

  const COLS = ['140px', 'minmax(84px, 0.9fr)', '92px', '116px', 'minmax(90px, 1.2fr)', 'minmax(84px, 0.9fr)', '104px', '76px', 'minmax(90px, 1.2fr)', '44px'];

  function table(items) {
    const paidTab = tab === 'paid';
    const rows = items.map((i) => h('tr', { class: `${i.paid ? 'paid' : ''} ${i.overdue ? 'overdue-row' : ''}` },
      h('td', { 'data-label': '날짜' }, formatDate(i.date), i.overdue && badge(`${i.days}일`, 'danger')),
      h('td', { 'data-label': '환자명' }, h('button', { type: 'button', class: 'namebtn', onclick: () => openHistory(i.name, i.rrn_front) }, i.name)),
      h('td', { 'data-label': '주민번호 앞' }, i.rrn_front),
      h('td', { 'data-label': '연락처' }, telLink(i.phone)),
      h('td', { 'data-label': '외상 내용' }, i.content),
      h('td', { class: 'num', 'data-label': '외상액' }, i.paid
        ? won(i.amount)
        : h('input', { class: 'amt', type: 'text', inputmode: 'numeric', 'aria-label': '외상액', value: String(i.amount),
          onchange: act((e) => patched(`/api/credits/${i.id}`, { amount: i.amount }, { amount: e.target.value }, `${i.name} 외상액`), '외상액을 고쳤어요') })),
      paidTab
        ? h('td', { 'data-label': '완불 날짜' }, i.paid_date ? formatDate(i.paid_date) : '')
        : h('td', { 'data-label': '메모장 작성' }, h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: !!i.memo_done, 'aria-label': `${i.name} 메모장 작성`, onchange: act((e) => patched(`/api/credits/${i.id}`, { memo_done: !e.target.checked }, { memo_done: e.target.checked }, `${i.name} 메모장 표시`)) }),
          h('small', { class: 'rowhint' }, 'PM+20 고객 메모장에 기록'))),
      h('td', { 'data-label': '완불' }, h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: !!i.paid, 'aria-label': `${i.name} 완불`,
          onchange: act((e) => patched(`/api/credits/${i.id}`, { paid: !e.target.checked }, { paid: e.target.checked }, `${i.name} 완불 표시`), '완불로 기록했어요 (완불 내역으로 이동)') }),
        h('small', { class: 'rowhint' }, '메모장에서 지움'))),
      h('td', { 'data-label': '비고' }, h('input', { class: 'note', type: 'text', 'aria-label': '비고', value: i.note, placeholder: '비고',
        onchange: act((e) => patched(`/api/credits/${i.id}`, { note: i.note }, { note: e.target.value }, `${i.name} 비고`)) })),
      h('td', {}, rowMenu(act(async () => {
        if (confirmDelete(`${i.name} ${won(i.amount)}원 외상`)) await deleted('credits', i.id, `${i.name} 외상`);
      })))));
    const heads = [['날짜'], ['환자명'], ['주민번호 앞'], ['연락처'], ['외상 내용', false, true], ['외상액', true],
      [paidTab ? '완불 날짜' : '메모장 작성'], ['완불'], ['비고', false, true], ['']];
    const card = sheet({
      cols: COLS, heads, rows, addCells: paidTab ? null : buildAddRow(), focusEl: refs.name, className: 'creditsheet', filterKey: `credits-${tab}`,
    });
    // 열 제목 아래에 체크 칸 설명을 한 번만 보여 준다 (직원이 헷갈리지 않도록)
    const ths = card.querySelectorAll('thead th');
    if (!paidTab) ths[6].append(h('small', { class: 'hint' }, 'PM+20 고객 메모장에 기록'));
    ths[7].append(h('small', { class: 'hint' }, '메모장에서 지움'));
    if (!rows.length) card.querySelector('tbody').append(h('tr', { class: 'emptyrow' }, h('td', { colspan: COLS.length }, paidTab ? '완불한 내역이 없습니다.' : '')));
    return card;
  }

  // 입력 줄: 새 외상은 항상 미완불로 들어간다.
  function buildAddRow() {
    const date = dateInput('date', lastDate);
    const text = (name, label, extra = {}) => h('input', { name, type: 'text', autocomplete: 'off', placeholder: label, 'aria-label': label, ...extra });
    const name = text('name', '환자명');
    const rrn = text('rrn_front', '주민번호 앞', { inputmode: 'numeric', maxLength: 6 });
    const phone = text('phone', '연락처', { inputmode: 'tel' });
    const content = text('content', '외상 내용');
    const amount = text('amount', '외상액', { inputmode: 'numeric' });
    const memo = h('input', { type: 'checkbox', name: 'memo_done', 'aria-label': '메모장 작성' });
    const note = text('note', '비고');
    refs = { name };
    const send = guard(err, async () => {
      try {
        const iso = date.value();
        if (!iso) throw new Error('날짜를 다시 확인하세요 (예: 26.10.31)');
        moneyOf(amount.value);
        await created('credits', `${name.value} 외상`, api('POST', '/api/credits', {
          date: iso, name: name.value, rrn_front: rrn.value, phone: phone.value, content: content.value,
          amount: amount.value, memo_done: memo.checked, note: note.value,
        }));
        lastDate = iso;
        refocus = true;
        toast('외상을 추가했어요');
        await load();
      } catch (ex) {
        toast(ex.message, 'error');
        throw ex;
      }
    });
    for (const el of [date.input, name, rrn, phone, content, amount, note]) {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    }
    return [
      cell('날짜', date.node), cell('환자명', name), cell('주민번호 앞', rrn), cell('연락처', phone),
      cell('외상 내용', content), cell('외상액', amount),
      cell('메모장 작성', h('label', { class: 'check' }, memo, h('small', { class: 'rowhint' }, 'PM+20 고객 메모장에 기록'))),
      h('div', { class: 'cell hide-sm' }), cell('비고', note),
      h('div', { class: 'cell' }, h('button', { type: 'button', class: 'btn small', onclick: send }, '추가')),
    ];
  }

  // ---- 환자 이름을 누르면: 그 환자의 전체 외상 목록 (완불 포함) ----------------------
  async function openHistory(patient, rrnFront) {
    try {
      const d = await api('GET', `/api/credits?status=all&q=${encodeURIComponent(patient)}`);
      const items = d.items.filter((i) => i.name === patient && i.rrn_front === rrnFront);
      const open = items.filter((i) => !i.paid);
      const phone = items.map((i) => i.phone).reverse().find(Boolean);
      const dlg = h('dialog', { class: 'history', 'aria-label': `${patient} 전체 외상 목록` },
        h('div', { class: 'row between' },
          h('h2', { class: 'tight' }, patient, rrnFront && h('small', { class: 'muted' }, ` ${rrnFront}`)),
          h('button', { type: 'button', class: 'btn ghost small', onclick: () => dlg.close() }, '닫기')),
        h('p', { class: 'muted' }, '미완불 합계 ', h('b', { class: 'ink' }, `${won(open.reduce((s, i) => s + i.amount, 0))}원`),
          ` · 전체 ${items.length}건`, phone && h('span', {}, ' · ', telLink(phone))),
        h('div', { class: 'tablewrap' }, h('table', { class: 'plain' },
          h('thead', {}, h('tr', {}, ['날짜', '외상 내용'].map((t) => h('th', {}, t)), h('th', { class: 'num' }, '외상액'), h('th', {}, '상태'), h('th', {}, '비고'))),
          h('tbody', {}, items.map((i) => h('tr', { class: i.paid ? 'paid' : '' },
            h('td', { 'data-label': '날짜' }, formatDate(i.date)),
            h('td', { 'data-label': '외상 내용' }, i.content),
            h('td', { class: 'num', 'data-label': '외상액' }, won(i.amount)),
            h('td', { 'data-label': '상태' }, i.paid ? badge(`완불 ${formatDate(i.paid_date)}`, 'quiet') : i.overdue ? badge(`연체 ${i.days}일`, 'danger') : badge('미완불', 'warn')),
            h('td', { 'data-label': '비고' }, i.note)))))));
      dlg.addEventListener('close', () => dlg.remove());
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
      document.body.append(dlg);
      dlg.showModal();
    } catch (ex) { err.show(ex.message); }
  }

  body.append(tabBox, list);
  load();
  return h('div', {},
    pageHead('환자 외상', searchBox('환자명·주민번호 앞자리 검색', (v) => { query = v; load(); })),
    err, stats, body);
}
