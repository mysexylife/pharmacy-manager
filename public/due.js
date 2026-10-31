import {
  h, api, won, errorBox, guard, submit, dateField, moneyField, field, badge, formatDate, todayKST, toast,
} from './lib.js';
import { addMonths, monthOf } from './dates.js';

// 이번 달 결제 대상: 거래처별 결제 금액만 보여 주고, 눌러야 자세한 계산이 나온다.
export function dueView() {
  const err = errorBox();
  const body = h('div');
  const open = new Set();
  let month = monthOf(todayKST());

  const load = guard(err, async () => {
    const d = await api('GET', `/api/due?month=${month}`);
    body.replaceChildren(...render(d));
  });

  const patch = (path, data, message) => guard(err, async () => {
    await api('PATCH', path, data);
    if (message) toast(message);
    await load();
  });

  function render(d) {
    const shift = (n) => { month = monthOf(addMonths(`${month}-01`, n)); load(); };
    return [
      h('div', { class: 'card' },
        h('div', { class: 'row between' },
          h('button', { type: 'button', class: 'btn ghost small', onclick: () => shift(-1) }, '이전 달'),
          h('h2', { class: 'tight' }, `${month.slice(2).replace('-', '.')} 결제 대상`),
          h('button', { type: 'button', class: 'btn ghost small', onclick: () => shift(1) }, '다음 달')),
        h('p', { class: 'muted' }, `${formatDate(d.cutoff)}(6개월 전 월말) 잔고에서 그 이후 결제액과 반품액을 뺀 금액입니다.`),
        h('div', { class: 'summary' }, h('div', {}, h('span', { class: 'muted' }, '결제할 금액 합계'), h('b', {}, `${won(d.total)}원`)))),
      pendingCard(d),
      h('div', { class: 'card' }, h('h2', {}, '제약회사별 결제 금액'), ...d.rows.map((r) => dueRow(r, d)),
        h('div', { class: 'duetotal' }, h('span', {}, '합계'), h('b', {}, `${won(d.total)}원`))),
    ];
  }

  // 모든 제약회사의 처리 중인 반품과 반환 안 된 차용을 한 목록으로 모은다.
  function pendingCard(d) {
    const { returns, loans } = d.pending;
    if (!returns.length && !loans.length) {
      return h('div', { class: 'card' }, h('h2', {}, '처리 중'), h('p', { class: 'muted' }, '처리 중인 반품과 반환 안 된 차용이 없습니다.'));
    }
    const rows = [
      ...returns.map((r) => ({ ...r, kind: '반품', detail: r.amount ? `${won(r.amount)}원` : '금액 미입력', check: '처리 완료', path: `/api/returns/${r.id}`, data: { done: true } })),
      ...loans.map((l) => ({ ...l, kind: '차용', detail: `${l.qty}개`, check: '반환 완료', path: `/api/loans/${l.id}`, data: { returned: true } })),
    ];
    return h('div', { class: 'card pending' },
      h('h2', {}, `처리 중 ${rows.length}건`),
      h('table', {},
        h('thead', {}, h('tr', {}, ['제약회사', '구분', '날짜', '품목', '금액·개수', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map((r) => h('tr', {},
          h('td', { 'data-label': '제약회사' }, r.vendor),
          h('td', { 'data-label': '구분' }, badge(r.kind, r.kind === '반품' ? 'warn' : 'info')),
          h('td', { 'data-label': '날짜' }, formatDate(r.date)),
          h('td', { 'data-label': '품목' }, r.item),
          h('td', { class: 'num', 'data-label': '금액·개수' }, r.detail),
          h('td', {}, h('label', { class: 'check' },
            h('input', { type: 'checkbox', onchange: patch(r.path, r.data, `${r.check}로 기록했어요`) }), r.check)))))));
  }

  function dueRow(r, d) {
    const isOpen = open.has(r.id);
    const head = h('button', {
      type: 'button', class: 'duehead', 'aria-expanded': String(isOpen),
      onclick: () => { if (open.has(r.id)) open.delete(r.id); else open.add(r.id); load(); },
    },
    h('span', { class: 'dname' }, r.name,
      r.pendingReturns > 0 && badge(`반품 처리 중 ${r.pendingReturns}건`, 'warn'),
      r.openLoans > 0 && badge(`차용 미반환 ${r.openLoans}건`, 'info'),
      r.pendingReturns === 0 && badge('반품 없음', 'quiet')),
    h('b', { class: r.due ? '' : 'muted' }, r.due ? `${won(r.due)}원` : '결제 없음'));
    if (!isOpen) return h('div', { class: 'duerow' }, head);

    const notes = d.notes.filter((n) => n.vendor_id === r.id);
    return h('div', { class: 'duerow open' }, head,
      h('div', { class: 'duebody' },
        h('dl', { class: 'facts' },
          h('dt', {}, `${formatDate(d.cutoff)} 잔고`), h('dd', {}, `${won(r.pool)}원`),
          h('dt', {}, '이후 결제액'), h('dd', {}, `${won(r.paid)}원`),
          h('dt', {}, '이후 반품액'), h('dd', {}, `${won(r.returned)}원`),
          h('dt', {}, '현재 잔고'), h('dd', {}, `${won(r.balance)}원`)),
        h('form', { class: 'row', onsubmit: submit(err, async (fd) => {
          await api('POST', `/api/vendors/${r.id}/entries`, { kind: 'payment', date: fd.get('date'), amount: fd.get('amount'), description: '결제' });
          toast('결제를 기록했어요');
          await load();
        }) },
        dateField('결제 날짜'),
        moneyField('실제 결제액(원)', 'amount', { required: true, value: r.due ? String(r.due) : '' }),
        h('button', { class: 'btn', type: 'submit' }, '결제 기록')),
        h('p', { class: 'muted small' }, '예상 금액과 달라도 실제로 낸 금액을 적으면 그 제약회사 장부에 결제로 기록됩니다.'),
        notes.length > 0 && h('ul', { class: 'notes' }, notes.map((n) => noteItem(n))),
        h('form', { class: 'row', onsubmit: submit(err, async (fd, form) => {
          await api('POST', `/api/vendors/${r.id}/notes`, { body: fd.get('body') });
          form.reset();
          await load();
        }) }, field('확인 메모', 'body', { cls: 'wide', required: true, placeholder: '예: 제약사 잔고와 대조' }),
        h('button', { class: 'btn ghost', type: 'submit' }, '메모 추가'))));
  }

  function noteItem(n) {
    return h('li', {}, h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: !!n.done, onchange: patch(`/api/notes/${n.id}`, { done: true }) }), n.body));
  }

  load();
  return h('div', {}, err, body);
}
