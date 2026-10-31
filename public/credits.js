import {
  h, api, won, errorBox, guard, submit, field, moneyField, dateField, collapsible, segmented, badge,
  confirmDelete, formatDate, toast, telLink,
} from './lib.js';

// 환자 외상 장부: 미완불만, 환자별 합계로 묶어 보여 주고 연체는 맨 위에 모은다.
export function creditsView() {
  const err = errorBox();
  const summary = h('div', { class: 'summary' });
  const list = h('div');
  const expanded = new Set();
  let status = 'open';
  let query = '';

  const load = guard(err, async () => {
    const d = await api('GET', `/api/credits?status=${status}&q=${encodeURIComponent(query.trim())}`);
    summary.replaceChildren(
      h('div', {}, h('span', { class: 'muted' }, '미수금 합계'), h('b', {}, `${won(d.totalOpen)}원`)),
      h('div', {}, h('span', { class: 'muted' }, '미완불'), h('b', {}, `${d.openCount}건`)),
      h('div', {}, h('span', { class: 'muted' }, `연체 (${d.overdueDays}일 이상)`), h('b', { class: d.overdueCount ? 'neg' : '' }, `${d.overdueCount}건`)));
    list.replaceChildren(...render(d));
  });

  const act = (fn, message) => guard(err, async (...a) => {
    await fn(...a);
    if (message) toast(message);
    await load();
  });

  // 서버가 이미 연체를 앞으로 정렬해 주므로, 처음 나온 순서대로 환자를 묶는다.
  function render(d) {
    const groups = new Map();
    for (const item of d.items) {
      const key = `${item.name}|${item.rrn_front}`;
      if (!groups.has(key)) groups.set(key, { key, name: item.name, rrn: item.rrn_front, items: [] });
      groups.get(key).items.push(item);
    }
    if (!groups.size) return [h('p', { class: 'muted' }, '표시할 내역이 없습니다.')];
    return [...groups.values()].map((g) => {
      const unpaid = g.items.filter((i) => !i.paid);
      const total = unpaid.reduce((s, i) => s + i.amount, 0);
      const overdue = unpaid.some((i) => i.overdue);
      const phone = g.items.map((i) => i.phone).find(Boolean);
      const isOpen = expanded.has(g.key) || query.trim() !== '' || overdue;
      return h('div', { class: `group ${overdue ? 'overdue' : ''}` },
        h('button', { type: 'button', class: 'grouphead', 'aria-expanded': String(isOpen), onclick: () => {
          if (expanded.has(g.key)) expanded.delete(g.key); else expanded.add(g.key);
          if (isOpen && !expanded.has(g.key) && overdue) expanded.add(g.key); // 연체는 항상 펼쳐 둔다
          load();
        } },
        h('span', { class: 'gname' }, g.name, g.rrn && h('small', {}, ` ${g.rrn}`),
          overdue && badge('연체', 'danger'), unpaid.length > 0 && badge(`${unpaid.length}건`, 'quiet')),
        h('b', { class: unpaid.length ? '' : 'muted' }, unpaid.length ? `${won(total)}원` : '완불')),
        phone && h('div', { class: 'phone' }, '연락처 ', telLink(phone)),
        isOpen && itemsTable(g.items));
    });
  }

  function itemsTable(items) {
    return h('table', {},
      h('thead', {}, h('tr', {}, ['날짜', '외상 내용'].map((t) => h('th', {}, t)), h('th', { class: 'num' }, '외상액'),
        h('th', {}, '메모장 작성'), h('th', {}, '완불'), h('th', {}, '비고'), h('th'))),
      h('tbody', {}, items.map((i) => h('tr', { class: `${i.paid ? 'paid' : ''} ${i.overdue ? 'overdue-row' : ''}` },
        h('td', { 'data-label': '날짜' }, formatDate(i.date), i.overdue && badge(`${i.days}일`, 'danger')),
        h('td', { 'data-label': '외상 내용' }, i.content),
        h('td', { class: 'num', 'data-label': '외상액' }, i.paid
          ? won(i.amount)
          : h('input', { class: 'amt', type: 'text', inputmode: 'numeric', 'aria-label': '외상액', value: String(i.amount),
            onchange: act((e) => api('PATCH', `/api/credits/${i.id}`, { amount: e.target.value }), '외상액을 고쳤어요') })),
        h('td', { 'data-label': '메모장 작성' }, h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: !!i.memo_done, onchange: act((e) => api('PATCH', `/api/credits/${i.id}`, { memo_done: e.target.checked })) }),
          h('small', {}, 'PM+20 고객 메모장에 기록'))),
        h('td', { 'data-label': i.paid && i.paid_date ? `완불 (${formatDate(i.paid_date)})` : '완불' }, h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: !!i.paid, 'aria-label': `${i.name} 완불`, onchange: act((e) => api('PATCH', `/api/credits/${i.id}`, { paid: e.target.checked }), '완불로 기록했어요') }),
          h('small', {}, '메모장에서 지움'))),
        h('td', { 'data-label': '비고' }, h('input', { class: 'note', type: 'text', 'aria-label': '비고', value: i.note, placeholder: '비고',
          onchange: act((e) => api('PATCH', `/api/credits/${i.id}`, { note: e.target.value })) })),
        h('td', {}, h('button', { type: 'button', class: 'btn danger small', onclick: act(async () => {
          if (confirmDelete(`${i.name} ${won(i.amount)}원 외상`)) await api('DELETE', `/api/credits/${i.id}`);
        }) }, '삭제'))))));
  }

  const addForm = collapsible('외상 추가', ({ close }) => h('form', { onsubmit: submit(err, async (fd, form) => {
    const body = Object.fromEntries(fd);
    body.memo_done = fd.has('memo_done');
    await api('POST', '/api/credits', body);
    form.reset();
    close();
    toast('외상을 추가했어요');
    await load();
  }) }, h('div', { class: 'row' },
    dateField('날짜'),
    field('환자명', 'name', { required: true }),
    field('주민번호 앞자리', 'rrn_front', { inputmode: 'numeric', maxLength: 6, pattern: '\\d{6}|', cls: 'narrow' }),
    field('연락처', 'phone', { type: 'tel', inputmode: 'tel', placeholder: '010-0000-0000' }),
    field('외상 내용', 'content', { cls: 'wide' }),
    moneyField('외상액(원)', 'amount', { required: true }),
    h('label', { class: 'f narrow' }, '메모장 작성', h('span', { class: 'check' }, h('input', { type: 'checkbox', name: 'memo_done' }), h('small', {}, 'PM+20 고객 메모장에 기록'))),
    h('button', { class: 'btn', type: 'submit' }, '추가'))));

  const segBox = h('div');
  const drawSeg = () => segBox.replaceChildren(segmented('보기', [['open', '미완불만'], ['all', '완불 내역 보기']], status, (s) => {
    status = s;
    drawSeg();
    load();
  }));
  drawSeg();

  load();
  return h('div', {},
    h('div', { class: 'card' }, h('h2', {}, '환자 외상 장부'), summary, addForm, err),
    h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('label', { class: 'f wide' }, '검색 (환자명·주민번호 앞자리)', h('input', { type: 'search', oninput: (e) => { query = e.target.value; load(); } })),
        segBox),
      list));
}
