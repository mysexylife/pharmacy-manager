import {
  h, api, won, signed, errorBox, guard, submit, field, moneyField, dateField, collapsible, segmented, badge,
  confirmDelete, formatDate, todayKST, toast, state,
} from './lib.js';
import { addMonths } from './dates.js';

// 제약회사 장부: 왼쪽에 거래처, 오른쪽에 장부(입고·결제·반품)와 반품·차용 칸.
export function vendorsView() {
  const err = errorBox();
  const listBox = h('div', { class: 'card' });
  const detail = h('div');
  let selected = state.vendorId ?? null;
  let months = 6; // 6 = 최근 6개월, 0 = 전체

  const from = () => (months ? addMonths(todayKST(), -months) : null);
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
    listBox.replaceChildren(
      h('h2', {}, '제약회사'),
      h('p', { class: 'muted' }, `전체 잔고 ${won(vendors.reduce((s, v) => s + (v.active ? v.balance : 0), 0))}원`),
      h('ul', { class: 'partylist' }, vendors.map((v) => h('li', {},
        h('button', { type: 'button', class: v.active ? '' : 'inactive', 'aria-current': String(v.id === selected), onclick: () => { selected = v.id; state.vendorId = v.id; refresh(); } },
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
  }

  async function loadDetail() {
    if (!selected) {
      detail.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'muted' }, '제약회사를 먼저 추가하세요.')));
      return;
    }
    const f = from();
    const d = await api('GET', `/api/vendors/${selected}/ledger${f ? `?from=${f}` : ''}`);
    detail.replaceChildren(...buildDetail(d));
  }

  function buildDetail(d) {
    const v = d.vendor;
    const openReturns = d.returns.filter((r) => !r.done);
    const openLoans = d.loans.filter((l) => !l.returned);
    const openNotes = d.notes.filter((n) => !n.done);

    // 맨 위: 이 거래처에서 처리 중인 것
    const alerts = [
      ...openReturns.map((r) => h('li', {}, badge('반품 처리 중', 'warn'), ` ${r.item} ${r.amount ? `${won(r.amount)}원` : '(금액 미입력)'}`)),
      ...openLoans.map((l) => h('li', {}, badge('차용 미반환', 'info'), ` ${l.item} ${l.qty}개 (${formatDate(l.date)})`)),
      ...openNotes.map((n) => h('li', {}, badge('확인', 'quiet'), ` ${n.body}`)),
    ];

    const bar = h('div', { class: 'stickybar' }, h('strong', {}, v.name),
      h('span', {}, '현재 잔고 ', h('b', { class: d.balance < 0 ? 'neg' : '' }, `${won(d.balance)}원`)));
    const head = h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('h2', { class: 'tight' }, '장부'),
        segmented('기간', [[6, '최근 6개월'], [0, '전체']], months, (m) => { months = m; refresh(); })),
      alerts.length > 0 && h('ul', { class: 'alerts' }, alerts));

    const entryForm = collapsible('입고·결제 추가', ({ close }) => h('form', { onsubmit: submit(err, async (fd, form) => {
      await api('POST', `/api/vendors/${v.id}/entries`, Object.fromEntries(fd));
      form.reset();
      close();
      toast('장부에 추가했어요');
      await refresh();
    }) }, h('div', { class: 'row' },
      h('label', { class: 'f narrow' }, '구분', h('select', { name: 'kind' },
        h('option', { value: 'purchase' }, '입고'), h('option', { value: 'payment' }, '결제'), h('option', { value: 'adjust' }, '조정(±)'))),
      dateField('날짜'),
      field('내용', 'description', { cls: 'wide', placeholder: '거래명세서 맨 위 품목명 (결제는 비워도 됨)' }),
      moneyField('금액(원)', 'amount', { required: true }),
      h('button', { class: 'btn', type: 'submit' }, '추가'))));

    return [
      bar,
      head,
      h('div', { class: 'card' }, entryForm, memoBlock(v, d)),
      h('div', { class: 'ledgergrid' },
        h('div', { class: 'card' }, ledgerTable(d)),
        h('div', {}, returnsPanel(v, d), loansPanel(v, d))),
    ];
  }

  function memoBlock(v, d) {
    return h('div', { class: 'memos' },
      h('label', { class: 'f' }, '차량번호 메모 (제약회사 직원 차량, 여러 대 가능)',
        h('input', { type: 'text', value: v.car_numbers, placeholder: '예: 12가3456, 78나9012', onchange: act((e) => api('PATCH', `/api/vendors/${v.id}`, { car_numbers: e.target.value }), '저장했어요') })),
      h('h3', {}, '확인 메모'),
      d.notes.length > 0 && h('ul', { class: 'notes' }, d.notes.map((n) => h('li', {},
        h('label', { class: `check ${n.done ? 'done' : ''}` },
          h('input', { type: 'checkbox', checked: !!n.done, onchange: act((e) => api('PATCH', `/api/notes/${n.id}`, { done: e.target.checked })) }),
          n.body, n.done && n.done_date ? ` (${formatDate(n.done_date)})` : ''),
        h('button', { type: 'button', class: 'btn danger small', onclick: act(async () => { if (confirmDelete('메모')) await api('DELETE', `/api/notes/${n.id}`); }) }, '삭제')))),
      h('form', { class: 'row', onsubmit: submit(err, async (fd, form) => {
        await api('POST', `/api/vendors/${v.id}/notes`, { body: fd.get('body') });
        form.reset();
        await refresh();
      }) }, field('메모 추가', 'body', { cls: 'wide', required: true, placeholder: '예: 반품 처리 확인, 제약사 잔고와 대조' }),
      h('button', { class: 'btn ghost', type: 'submit' }, '추가')));
  }

  function ledgerTable(d) {
    const rows = d.entries.map((e) => {
      const isIn = e.kind === 'purchase' || e.kind === 'adjust';
      return h('tr', {},
        h('td', { 'data-label': '날짜' }, formatDate(e.date)),
        h('td', { 'data-label': '내용' }, e.description || (e.kind === 'payment' ? '결제' : '')),
        h('td', { class: 'num', 'data-label': '입고액' }, isIn ? (e.kind === 'adjust' ? signed(e.amount) : won(e.amount)) : ''),
        h('td', { class: 'num', 'data-label': '반품액' }, e.kind === 'return' ? won(e.amount) : ''),
        h('td', { class: 'num', 'data-label': '결제액' }, e.kind === 'payment' ? won(e.amount) : ''),
        h('td', { class: `num ${e.balance < 0 ? 'neg' : ''}`, 'data-label': '잔고' }, won(e.balance)),
        h('td', {}, !e.return_id && h('button', { type: 'button', class: 'btn danger small', onclick: act(async () => {
          if (confirmDelete(`${formatDate(e.date)} ${e.description || '결제'}`)) await api('DELETE', `/api/entries/${e.id}`);
        }) }, '삭제')));
    });
    if (d.hasEarlier) {
      rows.push(h('tr', { class: 'opening' },
        h('td', { 'data-label': '기준' }, '이전 잔액'), h('td', {}, '(이전 내역 합계)'), h('td'), h('td'), h('td'),
        h('td', { class: 'num', 'data-label': '잔고' }, won(d.opening)), h('td')));
    }
    if (!rows.length) return h('p', { class: 'muted' }, '아직 내역이 없습니다.');
    return h('table', { class: 'ledger' },
      h('thead', {}, h('tr', {}, ['날짜', '내용'].map((t) => h('th', {}, t)),
        ['입고액', '반품액', '결제액', '잔고'].map((t) => h('th', { class: 'num' }, t)), h('th'))),
      h('tbody', {}, rows));
  }

  function returnsPanel(v, d) {
    return h('div', { class: 'card' }, h('h2', {}, '반품'),
      h('p', { class: 'muted small' }, '처리 완료를 체크한 날짜로 왼쪽 장부에 들어갑니다. 체크를 풀면 장부에서 빠집니다.'),
      collapsible('반품 추가', ({ close }) => h('form', { onsubmit: submit(err, async (fd, form) => {
        await api('POST', `/api/vendors/${v.id}/returns`, Object.fromEntries(fd));
        form.reset();
        close();
        await refresh();
      }) }, h('div', { class: 'row' },
        dateField('요청일'), field('품목명', 'item', { required: true, cls: 'wide' }),
        moneyField('반품액(원)', 'amount', { placeholder: '모르면 비워 두기' }),
        h('button', { class: 'btn', type: 'submit' }, '추가')))),
      d.returns.length === 0 ? h('p', { class: 'muted' }, '반품이 없습니다.') : h('ul', { class: 'items' }, d.returns.map((r) => h('li', { class: r.done ? 'done' : '' },
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: !!r.done, onchange: act((e) => api('PATCH', `/api/returns/${r.id}`, { done: e.target.checked })) }),
          h('span', {}, '처리 완료', r.done && r.done_date ? h('small', {}, ` ${formatDate(r.done_date)}`) : '')),
        h('span', { class: 'iname' }, `${formatDate(r.date)} ${r.item}`),
        r.done
          ? h('b', {}, `${won(r.amount)}원`)
          : h('input', { class: 'amt', type: 'text', inputmode: 'numeric', 'aria-label': `${r.item} 반품액`, value: r.amount || '', placeholder: '반품액',
            onchange: act((e) => api('PATCH', `/api/returns/${r.id}`, { amount: e.target.value })) }),
        h('button', { type: 'button', class: 'btn danger small', onclick: act(async () => { if (confirmDelete(`반품 ${r.item}`)) await api('DELETE', `/api/returns/${r.id}`); }) }, '삭제')))));
  }

  function loansPanel(v, d) {
    return h('div', { class: 'card' }, h('h2', {}, '차용'),
      h('p', { class: 'muted small' }, '제약회사에서 빌린 물품입니다. 반환하지 않은 것은 맨 위와 결제 대상 화면에 보입니다.'),
      collapsible('차용 추가', ({ close }) => h('form', { onsubmit: submit(err, async (fd, form) => {
        await api('POST', `/api/vendors/${v.id}/loans`, Object.fromEntries(fd));
        form.reset();
        close();
        await refresh();
      }) }, h('div', { class: 'row' },
        dateField('차용 날짜'), field('품목', 'item', { required: true, cls: 'wide' }),
        moneyField('개수', 'qty', { value: '1' }),
        h('button', { class: 'btn', type: 'submit' }, '추가')))),
      d.loans.length === 0 ? h('p', { class: 'muted' }, '차용이 없습니다.') : h('ul', { class: 'items' }, d.loans.map((l) => h('li', { class: l.returned ? 'done' : '' },
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: !!l.returned, onchange: act((e) => api('PATCH', `/api/loans/${l.id}`, { returned: e.target.checked })) }),
          h('span', {}, '반환 완료', l.returned && l.returned_date ? h('small', {}, ` ${formatDate(l.returned_date)}`) : '')),
        h('span', { class: 'iname' }, `${formatDate(l.date)} ${l.item}`),
        h('b', {}, `${l.qty}개`),
        h('button', { type: 'button', class: 'btn danger small', onclick: act(async () => { if (confirmDelete(`차용 ${l.item}`)) await api('DELETE', `/api/loans/${l.id}`); }) }, '삭제')))));
  }

  refresh();
  return h('div', { class: 'split' }, listBox, h('div', {}, err, detail));
}
