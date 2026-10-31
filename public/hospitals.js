import {
  h, api, won, signed, errorBox, guard, submit, field, moneyField, dateField, collapsible, confirmDelete,
  formatDate, todayKST, toast, state,
} from './lib.js';
import { addMonths } from './dates.js';

// 병원 외상 장부: 기본은 최근 한 달만 보이고, 이전 내역은 달 단위로 더 불러온다.
export function hospitalsView() {
  const err = errorBox();
  const listBox = h('div', { class: 'card' });
  const detail = h('div');
  let selected = state.hospitalId ?? null;
  let back = 1; // 몇 달 전부터 보이는지
  let settings = { rx_discount: 5000 };

  const refresh = guard(err, async () => { await loadList(); await loadDetail(); });
  const act = (fn, message) => guard(err, async (...a) => {
    await fn(...a);
    if (message) toast(message);
    await refresh();
  });

  async function loadList() {
    const hospitals = await api('GET', '/api/hospitals');
    if (!hospitals.some((x) => x.id === selected)) selected = hospitals[0]?.id ?? null;
    state.hospitalId = selected;
    listBox.replaceChildren(
      h('h2', {}, '병원'),
      h('p', { class: 'muted' }, `전체 잔고 ${won(hospitals.reduce((s, x) => s + x.balance, 0))}원`),
      h('ul', { class: 'partylist' }, hospitals.map((x) => h('li', {},
        h('button', { type: 'button', 'aria-current': String(x.id === selected), onclick: () => { selected = x.id; state.hospitalId = x.id; back = 1; refresh(); } },
          h('span', { class: 'pname' }, x.name), h('span', { class: `num ${x.balance < 0 ? 'neg' : ''}` }, won(x.balance)))))),
      collapsible('병원 추가', ({ close }) => h('form', { class: 'row', onsubmit: submit(err, async (fd, form) => {
        const created = await api('POST', '/api/hospitals', { name: fd.get('name') });
        selected = created.id;
        form.reset();
        close();
        await refresh();
      }) }, field('병원 이름', 'name', { required: true, cls: 'wide' }), h('button', { class: 'btn', type: 'submit' }, '추가')), { ghost: true }));
  }

  async function loadDetail() {
    if (!selected) {
      detail.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'muted' }, '병원을 먼저 추가하세요.')));
      return;
    }
    const [d, products, s] = await Promise.all([
      api('GET', `/api/hospitals/${selected}/ledger?from=${addMonths(todayKST(), -back)}`),
      api('GET', '/api/hospital-products'),
      api('GET', '/api/settings'),
    ]);
    settings = s;
    detail.replaceChildren(
      h('div', { class: 'stickybar' }, h('strong', {}, d.hospital.name),
        h('span', {}, '현재 잔고 ', h('b', { class: d.balance < 0 ? 'neg' : '' }, `${won(d.balance)}원`))),
      h('div', { class: 'card' }, entryForm(d.hospital.id, products), h('div', { class: 'gap' }, productsPanel(products))),
      h('div', { class: 'card' }, h('h2', {}, '장부'), ledgerTable(d)));
  }

  function entryForm(hid, products) {
    let kind = 'rx';
    const fields = h('div', { class: 'row' });
    const preview = h('p', { class: 'preview' });
    const kindSelect = h('select', { name: 'kind_ui', 'aria-label': '구분', onchange: (e) => { kind = e.target.value; draw(); } },
      h('option', { value: 'rx' }, '처방조제약'), h('option', { value: 'otc' }, '일반의약품'),
      h('option', { value: 'payment' }, '결제'), h('option', { value: 'adjust' }, '조정(±)'));

    const num = (el) => Number(String(el?.value ?? '').replace(/[,\s원]/g, '')) || 0;
    function update(form) {
      if (kind === 'rx') {
        const original = num(form.elements.original);
        const discount = form.elements.discount.value.trim() === '' ? settings.rx_discount : num(form.elements.discount);
        preview.textContent = original ? `외상액 ${won(Math.max(0, original - discount))}원 (원래 금액 ${won(original)} − 할인 ${won(discount)})` : '';
      } else if (kind === 'otc') {
        const p = products.find((x) => String(x.id) === form.elements.product_id.value);
        const qty = num(form.elements.qty) || 1;
        preview.textContent = p && !form.elements.billed.value ? `외상액 ${won(p.price * qty)}원 (단가 ${won(p.price)} × ${qty})` : '';
      } else {
        preview.textContent = '';
      }
    }

    const form = h('form', { onsubmit: submit(err, async (fd, f) => {
      const body = Object.fromEntries(fd);
      delete body.kind_ui;
      body.kind = kind;
      const r = await api('POST', `/api/hospitals/${hid}/entries`, body);
      f.reset();
      kind = 'rx';
      kindSelect.value = 'rx';
      draw();
      toast(r.billed ? `외상 ${won(r.billed)}원을 기록했어요` : '장부에 추가했어요');
      await refresh();
    }), oninput: (e) => update(e.currentTarget), onchange: (e) => update(e.currentTarget) });

    function draw() {
      const common = [h('label', { class: 'f narrow' }, '구분', kindSelect), dateField('날짜')];
      const submitBtn = h('button', { class: 'btn', type: 'submit' }, '추가');
      let rest;
      if (kind === 'rx') {
        rest = [field('환자명', 'item', { required: true, cls: 'wide' }), moneyField('원래 금액(원)', 'original', { required: true }),
          moneyField('할인액(원)', 'discount', { placeholder: `기본 ${won(settings.rx_discount)}` })];
      } else if (kind === 'otc') {
        rest = [h('label', { class: 'f wide' }, '제품 (단가표)', h('select', { name: 'product_id' },
          h('option', { value: '' }, '단가표에 없음 (직접 입력)'), products.map((p) => h('option', { value: String(p.id) }, `${p.name} · ${won(p.price)}원`)))),
        field('품목 (직접 입력할 때)', 'item', { cls: 'wide' }), moneyField('수량', 'qty', { value: '1' }),
        moneyField('외상액(원)', 'billed', { placeholder: '단가표면 자동' })];
      } else if (kind === 'payment') {
        rest = [field('내용', 'item', { cls: 'wide', placeholder: '결제' }), moneyField('결제액(원)', 'paid', { required: true })];
      } else {
        rest = [field('내용', 'item', { cls: 'wide', placeholder: '조정' }), moneyField('조정 금액(원, 빼려면 -)', 'billed', { required: true, cls: 'wide' })];
      }
      fields.replaceChildren(...common, ...rest, submitBtn);
      preview.textContent = '';
    }
    draw();
    form.append(fields, preview);
    return collapsible('외상·결제 추가', ({ close: closeFold }) => {
      form.addEventListener('submit', () => closeFold());
      return form;
    });
  }

  function productsPanel(products) {
    return collapsible('병원 단가표', () => h('div', {},
      h('p', { class: 'muted small' }, '자주 사는 제품의 병원 최종 단가입니다. 바꿔도 이미 입력한 과거 외상은 그대로입니다.'),
      products.length > 0 && h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '제품명'), h('th', { class: 'num' }, '병원 단가(원)'), h('th'))),
        h('tbody', {}, products.map((p) => h('tr', {},
          h('td', { 'data-label': '제품명' }, p.name),
          h('td', { 'data-label': '병원 단가' }, h('input', { class: 'amt', type: 'text', inputmode: 'numeric', 'aria-label': `${p.name} 단가`, value: String(p.price),
            onchange: act((e) => api('PATCH', `/api/hospital-products/${p.id}`, { price: e.target.value }), '단가를 바꿨어요') })),
          h('td', {}, h('button', { type: 'button', class: 'btn danger small', onclick: act(async () => {
            if (confirm(`${p.name}을(를) 단가표에서 뺄까요?`)) await api('DELETE', `/api/hospital-products/${p.id}`);
          }) }, '삭제')))))),
      h('form', { class: 'row', onsubmit: submit(err, async (fd, form) => {
        await api('POST', '/api/hospital-products', Object.fromEntries(fd));
        form.reset();
        await refresh();
      }) }, field('제품명', 'name', { required: true, cls: 'wide' }), moneyField('병원 단가(원)', 'price', { required: true }),
      h('button', { class: 'btn ghost', type: 'submit' }, '단가표에 추가'))), { ghost: true });
  }

  function ledgerTable(d) {
    const rows = d.entries.map((e) => h('tr', {},
      h('td', { 'data-label': '날짜' }, formatDate(e.date)),
      h('td', { 'data-label': '환자명·품목' }, e.item),
      h('td', { class: 'num', 'data-label': '수량' }, e.qty ?? ''),
      h('td', { class: 'num', 'data-label': '원래 금액' }, e.original != null ? won(e.original) : ''),
      h('td', { class: 'num', 'data-label': '할인액' }, e.discount != null ? won(e.discount) : ''),
      h('td', { class: 'num', 'data-label': '외상액' }, e.billed ? (e.kind === 'adjust' ? signed(e.billed) : won(e.billed)) : ''),
      h('td', { class: 'num', 'data-label': '결제액' }, e.paid ? won(e.paid) : ''),
      h('td', { class: `num ${e.balance < 0 ? 'neg' : ''}`, 'data-label': '잔고' }, won(e.balance)),
      h('td', {}, h('button', { type: 'button', class: 'btn danger small', onclick: act(async () => {
        if (confirmDelete(`${formatDate(e.date)} ${e.item}`)) await api('DELETE', `/api/hospital-entries/${e.id}`);
      }) }, '삭제'))));
    if (d.hasEarlier) {
      rows.push(h('tr', { class: 'opening' },
        h('td', { 'data-label': '기준' }, '이전 잔액'), h('td', {}, '(이전 내역 합계)'), h('td'), h('td'), h('td'), h('td'), h('td'),
        h('td', { class: 'num', 'data-label': '잔고' }, won(d.opening)), h('td')));
    }
    return h('div', {},
      rows.length ? h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, ['날짜', '환자명·품목'].map((t) => h('th', {}, t)),
          ['수량', '원래 금액', '할인액', '외상액', '결제액', '잔고'].map((t) => h('th', { class: 'num' }, t)), h('th'))),
        h('tbody', {}, rows)) : h('p', { class: 'muted' }, '최근 한 달 내역이 없습니다.'),
      h('div', { class: 'row' },
        d.hasEarlier && h('button', { type: 'button', class: 'btn ghost', onclick: () => { back += 1; refresh(); } }, '이전 내역 더 보기 (한 달)'),
        back > 1 && h('button', { type: 'button', class: 'btn ghost', onclick: () => { back = 1; refresh(); } }, '최근 한 달만 보기')));
  }

  refresh();
  return h('div', { class: 'split' }, listBox, h('div', {}, err, detail));
}
