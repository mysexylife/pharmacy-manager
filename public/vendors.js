import {
  h, api, won, signed, errorBox, guard, submit, field, moneyField, dateField, foldPair, collapsible, tabs, badge,
  confirmDelete, formatDate, parseDate, todayKST, toast, state, pageHead, searchBox, rowMenu, dateInput,
} from './lib.js';
import { addMonths } from './dates.js';

const moneyOf = (text) => {
  const s = String(text ?? '').replace(/[,\s원]/g, '');
  if (s === '') return 0;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error('금액은 숫자로 입력하세요');
  return n;
};

// 제약회사 장부: 엑셀처럼 오래된 내역이 위, 최근 내역이 아래. 표 맨 아래의 입력 행에 바로 쓴다.
export function vendorsView() {
  const err = errorBox();
  const listBox = h('div', { class: 'card listbox' });
  const detail = h('div');
  let selected = state.vendorId ?? null;
  let months = 6; // 6 = 최근 6개월, 0 = 전체
  let vq = '';
  let lastDate = todayKST(); // 입력 행의 날짜는 마지막으로 쓴 날짜를 이어 간다 (같은 날 여러 건을 입력할 때 편하다)
  let refocus = false;
  let refs = {};
  const showAllDone = { returns: false, loans: false, notes: false };

  const from = () => (months ? addMonths(todayKST(), -months) : null);
  const applyFilter = () => listBox.querySelectorAll('.partylist li').forEach((li) => { li.hidden = vq !== '' && !li.textContent.includes(vq); });
  const refresh = guard(err, async () => { await loadList(); await loadDetail(); });
  const act = (fn, message) => guard(err, async (...a) => {
    await fn(...a);
    if (message) toast(message);
    await refresh();
  });

  async function loadList() {
    const vendors = await api('GET', '/api/vendors');
    if (!vendors.some((v) => v.id === selected)) selected = vendors.find((v) => v.active)?.id ?? null;
    state.vendorId = selected;
    const current = vendors.find((v) => v.id === selected);
    listBox.replaceChildren(
      h('button', { type: 'button', class: 'btn ghost vendortoggle', onclick: () => listBox.classList.toggle('open') },
        current ? `${current.name} · 제약회사 바꾸기` : '제약회사 고르기'),
      h('h2', {}, '제약회사'),
      h('p', { class: 'muted' }, `전체 잔고 ${won(vendors.reduce((s, v) => s + (v.active ? v.balance : 0), 0))}원`),
      h('ul', { class: 'partylist' }, vendors.map((v) => h('li', {},
        h('button', { type: 'button', class: v.active ? '' : 'inactive', 'aria-current': String(v.id === selected), onclick: () => { selected = v.id; state.vendorId = v.id; listBox.classList.remove('open'); refresh(); } },
          h('span', { class: 'pname' }, v.name + (v.active ? '' : ' (사용 안 함)'),
            v.pendingReturns > 0 && badge(`반품 ${v.pendingReturns}`, 'warn'),
            v.openLoans > 0 && badge(`차용 ${v.openLoans}`, 'info')),
          h('span', { class: `num ${v.balance < 0 ? 'neg' : ''}` }, won(v.balance)))))),
      collapsible('제약회사 추가', ({ close }) => h('form', { class: 'row', onsubmit: submit(err, async (fd, form) => {
        const created = await api('POST', '/api/vendors', { name: fd.get('name') });
        selected = created.id;
        form.reset();
        close();
        toast('제약회사를 추가했어요');
        await refresh();
      }) }, field('제약회사 이름', 'name', { required: true, cls: 'wide' }), h('button', { class: 'btn', type: 'submit' }, '추가')), { ghost: true }));
    applyFilter();
  }

  async function loadDetail() {
    if (!selected) {
      detail.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'muted' }, '제약회사를 먼저 추가하세요.')));
      return;
    }
    const f = from();
    const d = await api('GET', `/api/vendors/${selected}/ledger${f ? `?from=${f}` : ''}`);
    detail.replaceChildren(...buildDetail(d));
    if (refocus) { refs.description?.focus(); refocus = false; }
  }

  function buildDetail(d) {
    const v = d.vendor;
    const bar = h('div', { class: 'stickybar' },
      h('strong', {}, v.name),
      h('div', { class: 'barright' },
        tabs('기간', [[6, '최근 6개월'], [0, '전체']], months, (m) => { months = m; refresh(); }),
        h('span', {}, '현재 잔고 ', h('b', { class: d.balance < 0 ? 'neg' : '' }, `${won(d.balance)}원`))));
    return [bar, processPanel(v, d), ledgerCard(v, d)];
  }

  // ---- 반품 · 차용 · 확인 메모: 내역표 위에 작게 ---------------------------------
  // 끝난 것은 최근 2건만 흐리게 보이고, 나머지는 눌러야 보인다.
  function compactList(items, isDone, render, key) {
    const open = items.filter((x) => !isDone(x));
    const done = items.filter(isDone);
    const shown = showAllDone[key] ? done : done.slice(0, 2);
    return h('div', {},
      (open.length + shown.length) > 0 && h('ul', { class: 'plist items' }, [...open, ...shown].map(render)),
      done.length > 2 && h('button', { type: 'button', class: 'linklike', onclick: () => { showAllDone[key] = !showAllDone[key]; loadDetail(); } },
        showAllDone[key] ? '지난 내역 접기' : `지난 ${done.length - 2}건 더 보기`));
  }

  function column(title, hint, pair, list) {
    return h('section', { class: 'pcol' },
      h('div', { class: 'phead' }, h('strong', {}, title), hint && h('small', { class: 'hint' }, hint), h('span', { class: 'grow' }), pair.trigger),
      pair.body, list);
  }

  function processPanel(v, d) {
    const addReturn = foldPair('반품', ({ close }) => h('form', { onsubmit: submit(err, async (fd, form) => {
      await api('POST', `/api/vendors/${v.id}/returns`, Object.fromEntries(fd));
      form.reset();
      close();
      await refresh();
    }) }, h('div', { class: 'row' },
      dateField('요청일'), field('품목명', 'item', { required: true, cls: 'wide' }),
      moneyField('반품액(원)', 'amount', { placeholder: '모르면 비워 두기' }),
      h('button', { class: 'btn', type: 'submit' }, '추가'))));
    const addLoan = foldPair('차용', ({ close }) => h('form', { onsubmit: submit(err, async (fd, form) => {
      await api('POST', `/api/vendors/${v.id}/loans`, Object.fromEntries(fd));
      form.reset();
      close();
      await refresh();
    }) }, h('div', { class: 'row' },
      dateField('차용 날짜'), field('품목', 'item', { required: true, cls: 'wide' }),
      moneyField('개수', 'qty', { value: '1' }),
      h('button', { class: 'btn', type: 'submit' }, '추가'))));
    const addNote = foldPair('메모', ({ close }) => h('form', { class: 'row', onsubmit: submit(err, async (fd, form) => {
      await api('POST', `/api/vendors/${v.id}/notes`, { body: fd.get('body') });
      form.reset();
      close();
      await refresh();
    }) }, field('확인 메모', 'body', { cls: 'wide', required: true, placeholder: '예: 반품 처리 확인, 제약사 잔고와 대조' }),
    h('button', { class: 'btn', type: 'submit' }, '추가')));

    const returns = compactList(d.returns, (r) => r.done, (r) => h('li', { class: r.done ? 'done' : '' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: !!r.done, 'aria-label': `${r.item} 처리 완료`, onchange: act((e) => api('PATCH', `/api/returns/${r.id}`, { done: e.target.checked })) }),
        h('span', { class: 'ptext' }, `${formatDate(r.date)} ${r.item}`, r.done && r.done_date ? h('small', {}, ` · 완료 ${formatDate(r.done_date)}`) : null)),
      r.done
        ? h('b', {}, won(r.amount))
        : h('input', { class: 'amt', type: 'text', inputmode: 'numeric', 'aria-label': `${r.item} 반품액`, value: r.amount || '', placeholder: '반품액',
          onchange: act((e) => api('PATCH', `/api/returns/${r.id}`, { amount: e.target.value })) }),
      rowMenu(act(async () => { if (confirmDelete(`반품 ${r.item}`)) await api('DELETE', `/api/returns/${r.id}`); }))), 'returns');

    const loans = compactList(d.loans, (l) => l.returned, (l) => h('li', { class: l.returned ? 'done' : '' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: !!l.returned, 'aria-label': `${l.item} 반환 완료`, onchange: act((e) => api('PATCH', `/api/loans/${l.id}`, { returned: e.target.checked })) }),
        h('span', { class: 'ptext' }, `${formatDate(l.date)} ${l.item}`, l.returned && l.returned_date ? h('small', {}, ` · 반환 ${formatDate(l.returned_date)}`) : null)),
      h('b', {}, `${l.qty}개`),
      rowMenu(act(async () => { if (confirmDelete(`차용 ${l.item}`)) await api('DELETE', `/api/loans/${l.id}`); }))), 'loans');

    const notes = compactList(d.notes, (n) => n.done, (n) => h('li', { class: n.done ? 'done' : '' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: !!n.done, 'aria-label': `${n.body} 완료`, onchange: act((e) => api('PATCH', `/api/notes/${n.id}`, { done: e.target.checked })) }),
        h('span', { class: 'ptext' }, n.body, n.done && n.done_date ? h('small', {}, ` · ${formatDate(n.done_date)}`) : null)),
      rowMenu(act(async () => { if (confirmDelete('메모')) await api('DELETE', `/api/notes/${n.id}`); }))), 'notes');

    return h('div', { class: 'card process' },
      column('반품', '체크 = 처리 완료', addReturn, returns),
      column('차용', '체크 = 반환 완료', addLoan, loans),
      column('확인 메모', null, addNote, notes));
  }

  // ---- 내역표: 오래된 순서, 맨 아래에 입력 행 ------------------------------------
  function ledgerCard(v, d) {
    const entries = d.entries.slice().reverse(); // 서버는 최근 것부터 주므로 뒤집어 오래된 순서로
    const rows = [];
    if (d.hasEarlier) {
      rows.push(h('tr', { class: 'opening' },
        h('td', { 'data-label': '기준' }, '이전 잔액'), h('td', {}, '(이전 내역 합계)'), h('td'), h('td'), h('td'),
        h('td', { class: 'num', 'data-label': '잔고' }, won(d.opening)), h('td')));
    }
    for (const e of entries) {
      const isIn = e.kind === 'purchase' || e.kind === 'adjust';
      rows.push(h('tr', {},
        h('td', { 'data-label': '날짜' }, formatDate(e.date)),
        h('td', { 'data-label': '내용' }, e.description || (e.kind === 'payment' ? '결제' : '')),
        h('td', { class: 'num', 'data-label': '입고액' }, isIn ? (e.kind === 'adjust' ? signed(e.amount) : won(e.amount)) : ''),
        h('td', { class: 'num', 'data-label': '반품액' }, e.kind === 'return' ? won(e.amount) : ''),
        h('td', { class: 'num', 'data-label': '결제액' }, e.kind === 'payment' ? won(e.amount) : ''),
        h('td', { class: `num ${e.balance < 0 ? 'neg' : ''}`, 'data-label': '잔고' }, won(e.balance)),
        h('td', {}, !e.return_id && rowMenu(act(async () => {
          if (confirmDelete(`${formatDate(e.date)} ${e.description || '결제'}`)) await api('DELETE', `/api/entries/${e.id}`);
        })))));
    }
    const addRow = buildAddRow(v, d);
    const fab = h('button', { type: 'button', class: 'btn addfab', onclick: () => {
      addRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
      refs.description?.focus({ preventScroll: true });
    } }, '+ 행 추가');
    return h('div', { class: 'card ledgercard' },
      h('table', { class: 'ledger fixed' },
        h('colgroup', {}, ['date', 'desc', 'in', 'ret', 'pay', 'bal', 'menu'].map((c) => h('col', { class: `c-${c}` }))),
        h('thead', {}, h('tr', {}, ['날짜', '내용'].map((t) => h('th', {}, t)),
          ['입고액', '반품액', '결제액', '잔고'].map((t) => h('th', { class: 'num' }, t)), h('th'))),
        h('tbody', {}, rows)),
      addRow,
      fab);
  }

  // 엑셀의 마지막 빈 줄처럼 쓴다. 입고액이나 결제액 중 하나만 적고 Enter. 음수 입고액은 조정으로 기록된다.
  function buildAddRow(v, d) {
    const date = dateInput('date', lastDate);
    const description = h('input', { name: 'description', type: 'text', autocomplete: 'off', placeholder: '품목명', title: '결제는 비워도 됩니다', 'aria-label': '내용' });
    const billed = h('input', { name: 'billed', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '입고액', 'aria-label': '입고액' });
    const paid = h('input', { name: 'paid', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '결제액', 'aria-label': '결제액' });
    const preview = h('span', { class: 'dim' }, '');
    refs = { date: date.input, description, billed, paid };

    const update = () => {
      try {
        const next = d.balance + moneyOf(billed.value) - moneyOf(paid.value);
        preview.textContent = billed.value.trim() || paid.value.trim() ? `→ ${won(next)}` : '';
      } catch { preview.textContent = ''; }
    };
    const send = guard(err, async () => {
      try {
        const b = moneyOf(billed.value);
        const p = moneyOf(paid.value);
        if (b && p) throw new Error('입고액과 결제액 중 하나만 입력하세요');
        if (!b && !p) throw new Error('입고액이나 결제액을 입력하세요');
        const iso = parseDate(date.input.value);
        if (!iso) throw new Error('날짜를 다시 확인하세요 (예: 26.10.31)');
        await api('POST', `/api/vendors/${v.id}/entries`, {
          kind: p ? 'payment' : (b < 0 ? 'adjust' : 'purchase'), date: iso, description: description.value, amount: p || b,
        });
        lastDate = iso;
        refocus = true;
        await refresh();
      } catch (ex) {
        toast(ex.message, 'error');
        throw ex;
      }
    });
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } };
    for (const el of [date.input, description, billed, paid]) el.addEventListener('keydown', onKey);
    for (const el of [billed, paid]) el.addEventListener('input', update);

    const cell = (label, ...kids) => h('div', { class: 'cell', 'data-label': label }, ...kids);
    return h('div', { class: 'addbar' },
      cell('날짜', date.node),
      cell('내용', description),
      cell('입고액', billed),
      h('div', { class: 'cell dim hide-sm' }, '반품은 위에서'),
      cell('결제액', paid),
      cell('예상 잔고', preview),
      h('div', { class: 'cell' }, h('button', { type: 'button', class: 'btn small', onclick: send }, '추가')));
  }

  refresh();
  return h('div', {},
    pageHead('제약회사 장부', searchBox('제약회사 검색', (v) => { vq = v.trim(); applyFilter(); })),
    h('div', { class: 'split' }, listBox, h('div', {}, err, detail)));
}
