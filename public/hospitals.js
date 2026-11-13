import {
  h, api, won, signed, errorBox, guard, submit, confirmDelete, formatDate, parseDate, todayKST, toast, pageHead, rowMenu, dateInput,
} from './lib.js';
import { addMonths } from './dates.js';
import { sheet, cell } from './sheet.js';
import { created, deleted } from './undo.js';

const HOSPITAL_NAME = '한사랑의원'; // 병원은 한 곳뿐이라 목록 없이 바로 보여 준다

const moneyOf = (text) => {
  const s = String(text ?? '').replace(/[,\s원]/g, '');
  if (s === '') return 0;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error('금액은 숫자로 입력하세요');
  return n;
};

// 병원 외상: 엑셀처럼 오래된 내역이 위, 최근 내역이 아래. 맨 아래 입력 행에 쓰고, 오른쪽에는 품목 단가표.
export function hospitalsView() {
  const err = errorBox();
  const detail = h('div', { class: 'hospgrid' });
  let back = 1; // 몇 달 전부터 보이는지 (기본 최근 한 달)
  let lastDate = todayKST();
  let refocus = false;
  let refs = {};

  const refresh = guard(err, async () => { await load(); });
  const act = (fn, message) => guard(err, async (...a) => {
    await fn(...a);
    if (message) toast(message);
    await load();
  });

  async function load() {
    let hospitals = await api('GET', '/api/hospitals');
    if (!hospitals.length) {
      await api('POST', '/api/hospitals', { name: HOSPITAL_NAME });
      hospitals = await api('GET', '/api/hospitals');
    }
    const hospital = hospitals[0];
    const [d, products] = await Promise.all([
      api('GET', `/api/hospitals/${hospital.id}/ledger?from=${addMonths(todayKST(), -back)}`),
      api('GET', '/api/hospital-products'),
    ]);
    detail.replaceChildren(
      h('div', { class: 'stickybar hospbar' },
        h('strong', {}, d.hospital.name),
        h('span', {}, '현재 잔고 ', h('b', { class: d.balance < 0 ? 'neg' : '' }, `${won(d.balance)}원`))),
      ledgerCard(d, products),
      pricePanel(products));
    if (refocus) { refs.item?.focus(); refocus = false; }
  }

  // ---- 내역표 ---------------------------------------------------------
  function ledgerCard(d, products) {
    const rows = [];
    if (d.hasEarlier) {
      rows.push(h('tr', { class: 'opening' },
        h('td', { 'data-label': '기준' }, '이전 잔액'), h('td', {}, '(이전 내역 합계)'), h('td'), h('td'), h('td'), h('td'), h('td'),
        h('td', { class: 'num', 'data-label': '잔고' }, won(d.opening)), h('td')));
    }
    for (const e of d.entries.slice().reverse()) { // 서버는 최근 것부터 주므로 뒤집어 오래된 순서로
      rows.push(h('tr', {},
        h('td', { 'data-label': '날짜' }, formatDate(e.date)),
        h('td', { 'data-label': '환자명·품목' }, e.item),
        h('td', { class: 'num', 'data-label': '수량' }, e.qty ?? ''),
        h('td', { class: 'num', 'data-label': '원래 금액' }, e.original != null ? won(e.original) : ''),
        h('td', { class: 'num', 'data-label': '할인액' }, e.discount != null ? won(e.discount) : ''),
        h('td', { class: 'num', 'data-label': '외상액' }, e.billed ? (e.kind === 'adjust' ? signed(e.billed) : won(e.billed)) : ''),
        h('td', { class: 'num', 'data-label': '결제액' }, e.paid ? won(e.paid) : ''),
        h('td', { class: `num ${e.balance < 0 ? 'neg' : ''}`, 'data-label': '잔고' }, won(e.balance)),
        h('td', {}, rowMenu(act(async () => {
          if (confirmDelete(`${formatDate(e.date)} ${e.item}`)) await deleted('hospital_entries', e.id, `${formatDate(e.date)} ${e.item}`);
        })))));
    }
    const cells = buildAddRow(d, products);
    const card = sheet({
      cols: ['136px', 'minmax(150px, 1fr)', '58px', '88px', '80px', '88px', '88px', '96px', '44px'],
      heads: [['날짜'], ['환자명·품목'], ['수량', true], ['원래 금액', true], ['할인액', true], ['외상액', true], ['결제액', true], ['잔고', true], ['']], filterKey: 'hospital',
      rows, addCells: cells, focusEl: refs.item,
    });
    // 이전 내역은 위쪽에서 한 달씩 더 불러온다
    if (d.hasEarlier || back > 1) {
      card.prepend(h('div', { class: 'earlier' },
        d.hasEarlier && h('button', { type: 'button', class: 'btn ghost small', onclick: () => { back += 1; refresh(); } }, '이전 내역 더 보기 (한 달)'),
        back > 1 && h('button', { type: 'button', class: 'btn ghost small', onclick: () => { back = 1; refresh(); } }, '최근 한 달만 보기')));
    }
    return card;
  }

  // 입력 줄: 채운 칸으로 종류를 알아낸다.
  //   결제액           → 결제
  //   원래 금액        → 처방조제약 (외상액 = 원래 금액 − 직접 입력한 할인액, 비우면 할인 없음)
  //   외상액           → 일반의약품 직접 입력 (음수면 조정)
  //   품목 이름 + 수량 → 단가표에 있는 일반의약품 (외상액은 단가 × 수량)
  function buildAddRow(d, products) {
    const date = dateInput('date', lastDate);
    const list = h('datalist', { id: 'hospital-products' }, products.map((p) => h('option', { value: p.name })));
    const item = h('input', { name: 'item', type: 'text', autocomplete: 'off', placeholder: '환자명 · 품목', list: 'hospital-products', 'aria-label': '환자명·품목' });
    const field = (name, label, placeholder = label) => h('input', { name, type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder, 'aria-label': label });
    const qty = field('qty', '수량');
    const original = field('original', '원래 금액');
    const discount = field('discount', '할인액');
    const billed = field('billed', '외상액');
    const paid = field('paid', '결제액');
    const preview = h('span', { class: 'dim' }, '');
    refs = { item };

    const productOf = () => products.find((p) => p.name === item.value.trim());
    // 입력한 내용으로 종류와 외상액을 계산한다. 화면의 미리보기와 저장이 같은 계산을 쓴다.
    const plan = () => {
      const o = moneyOf(original.value);
      const b = moneyOf(billed.value);
      const p = moneyOf(paid.value);
      const q = moneyOf(qty.value) || 1;
      const filled = [o, b, p].filter(Boolean).length;
      if (filled > 1) throw new Error('원래 금액, 외상액, 결제액 중 하나만 입력하세요');
      if (p) return { kind: 'payment', delta: -p, body: { paid: p } };
      if (o) {
        const disc = moneyOf(discount.value); // 자동 할인은 없다. 비우면 할인 없이 원래 금액 그대로
        return { kind: 'rx', delta: Math.max(0, o - disc), body: { original: o, discount: disc } };
      }
      if (b) return { kind: b < 0 ? 'adjust' : 'otc', delta: b, body: { billed: b, qty: b < 0 ? undefined : q } };
      const prod = productOf();
      if (prod) return { kind: 'otc', delta: prod.price * q, body: { product_id: prod.id, qty: q } };
      throw new Error('원래 금액, 외상액, 결제액 중 하나를 입력하세요 (단가표에 있는 품목은 이름과 수량만)');
    };
    const update = () => {
      try {
        const x = plan();
        billed.placeholder = x.kind === 'rx' || (x.kind === 'otc' && x.body.product_id) ? won(x.delta) : '외상액';
        preview.textContent = `→ ${won(d.balance + x.delta)}`;
      } catch { billed.placeholder = '외상액'; preview.textContent = ''; }
    };
    const send = guard(err, async () => {
      try {
        const iso = parseDate(date.input.value);
        if (!iso) throw new Error('날짜를 다시 확인하세요 (예: 26.10.31)');
        const x = plan();
        await created('hospital_entries', item.value || '결제', api('POST', `/api/hospitals/${d.hospital.id}/entries`, { kind: x.kind, date: iso, item: item.value, ...x.body }));
        lastDate = iso;
        refocus = true;
        await load();
      } catch (ex) {
        toast(ex.message, 'error');
        throw ex;
      }
    });
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } };
    for (const el of [date.input, item, qty, original, discount, billed, paid]) {
      el.addEventListener('keydown', onKey);
      el.addEventListener('input', update);
    }
    return [
      cell('날짜', date.node),
      cell('환자명·품목', item, list),
      cell('수량', qty),
      cell('원래 금액', original),
      cell('할인액', discount),
      cell('외상액', billed),
      cell('결제액', paid),
      cell('예상 잔고', preview),
      h('div', { class: 'cell' }, h('button', { type: 'button', class: 'btn small', onclick: send }, '추가')),
    ];
  }

  // ---- 오른쪽: 품목 단가표 ----------------------------------------------------
  function pricePanel(products) {
    const name = h('input', { name: 'name', type: 'text', autocomplete: 'off', placeholder: '제품명', 'aria-label': '제품명' });
    const price = h('input', { name: 'price', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '병원 단가', 'aria-label': '병원 단가' });
    const send = guard(err, async () => {
      try {
        await api('POST', '/api/hospital-products', { name: name.value, price: price.value });
        refocus = false;
        await load();
        document.querySelector('.pricecard input[name=name]')?.focus();
      } catch (ex) {
        toast(ex.message, 'error');
        throw ex;
      }
    });
    for (const el of [name, price]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    const rows = products.map((p) => h('tr', {},
      h('td', { 'data-label': '제품명' }, p.name),
      h('td', { class: 'num', 'data-label': '병원 단가' }, h('input', { class: 'amt', type: 'text', inputmode: 'numeric', 'aria-label': `${p.name} 단가`, value: String(p.price),
        onchange: act((e) => api('PATCH', `/api/hospital-products/${p.id}`, { price: e.target.value }), '단가를 바꿨어요') })),
      h('td', {}, rowMenu(act(async () => {
        if (confirm(`${p.name}을(를) 단가표에서 뺄까요?`)) await api('DELETE', `/api/hospital-products/${p.id}`);
      })))));
    const card = sheet({
      cols: ['minmax(120px, 1fr)', '100px', '44px'],
      heads: [['제품명'], ['병원 단가(원)', true], ['']], filterKey: 'prices',
      rows, addCells: [cell('제품명', name), cell('병원 단가', price), h('div', { class: 'cell' }, h('button', { type: 'button', class: 'btn small', onclick: send }, '추가'))],
      focusEl: name, className: 'pricecard',
    });
    card.prepend(h('div', { class: 'cardtitle' }, h('strong', {}, '품목 단가표'),
      h('small', { class: 'hint' }, '바꿔도 이미 입력한 과거 외상은 그대로')));
    return card;
  }

  refresh();
  return h('div', {}, pageHead('병원 외상'), err, detail);
}
