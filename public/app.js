const state = {
  me: null,
  setup: false,
  tab: null,
  // 폰에서는 기본으로 최근 1년만, PC에서는 전체를 보여준다.
  range: matchMedia('(max-width: 720px)').matches ? 'year' : 'all',
  partyId: {},
};

const root = document.getElementById('app');

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && state.me) {
      state.me = null;
      render();
    }
    throw new Error(data?.error ?? `오류 (${res.status})`);
  }
  return data;
}

const won = (n) => (n == null ? '' : Number(n).toLocaleString('ko-KR'));
const today = () => new Date().toLocaleDateString('sv-SE');
const yearAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toLocaleDateString('sv-SE');
};

function errorBox() {
  const box = h('div', { class: 'error', role: 'alert', hidden: true });
  box.show = (msg) => { box.textContent = msg; box.hidden = false; };
  box.clear = () => { box.hidden = true; };
  return box;
}

// 폼 제출을 감싸 오류 표시와 중복 제출 방지를 한 번에 처리한다.
function submit(err, fn) {
  return async (e) => {
    e.preventDefault();
    err.clear();
    const btn = e.submitter;
    if (btn) btn.disabled = true;
    try { await fn(new FormData(e.currentTarget), e.currentTarget); }
    catch (ex) { err.show(ex.message); }
    finally { if (btn) btn.disabled = false; }
  };
}

function field(label, name, opts = {}) {
  const { cls = '', ...input } = opts;
  return h('label', { class: `f ${cls}` }, label, h('input', { name, type: 'text', ...input }));
}

// ---------- 로그인 / 최초 설정 ----------
function loginView() {
  const err = errorBox();
  const setup = state.setup;
  const form = h('form', { class: 'card', onsubmit: submit(err, async (fd) => {
    const body = Object.fromEntries(fd);
    const { user } = await api('POST', setup ? '/api/setup' : '/api/login', body);
    state.me = user;
    state.setup = false;
    render();
  }) },
    h('h2', {}, setup ? '처음 설정: 약사 계정 만들기' : '푸른약국 장부 로그인'),
    field('아이디', 'username', { required: true, autocomplete: 'username', autocapitalize: 'none' }),
    setup && field('이름', 'name', { required: true }),
    h('label', { class: 'f' }, setup ? '비밀번호 (8자 이상)' : '비밀번호',
      h('input', { name: 'password', type: 'password', required: true, minLength: setup ? 8 : 1,
        autocomplete: setup ? 'new-password' : 'current-password' })),
    err,
    h('button', { class: 'btn', type: 'submit' }, setup ? '계정 만들기' : '로그인'),
  );
  return h('div', { class: 'login' }, form);
}

// ---------- 공통 틀 ----------
function tabsFor(me) {
  const tabs = [
    { id: 'credits', label: '환자 외상', view: creditsView },
    { id: 'hospital', label: '병원 외상', view: () => ledgerView('hospital') },
  ];
  if (me.role === 'pharmacist') {
    tabs.push({ id: 'vendor', label: '제약회사 장부', view: () => ledgerView('vendor') });
    tabs.push({ id: 'users', label: '직원 관리', view: usersView });
  }
  return tabs;
}

function shell() {
  const tabs = tabsFor(state.me);
  if (!tabs.some((t) => t.id === state.tab)) state.tab = tabs[0].id;
  const main = h('main');
  const current = tabs.find((t) => t.id === state.tab);
  main.append(current.view());
  return [
    h('header', { class: 'top' },
      h('h1', {}, '푸른약국 장부'),
      h('div', { class: 'who' }, `${state.me.name} (${state.me.role === 'pharmacist' ? '약사' : '직원'})`,
        h('button', { class: 'btn ghost small', onclick: async () => {
          await api('POST', '/api/logout').catch(() => {});
          state.me = null;
          render();
        } }, '로그아웃')),
    ),
    h('nav', { class: 'tabs' }, tabs.map((t) =>
      h('button', { 'aria-current': t.id === state.tab ? 'page' : null, onclick: () => { state.tab = t.id; render(); } }, t.label))),
    main,
  ];
}

// ---------- 환자 외상 장부 ----------
function creditsView() {
  const wrap = h('div');
  const err = errorBox();
  let showAll = false;
  let query = '';
  const list = h('div');
  const summary = h('div', { class: 'summary' });

  async function load() {
    const rows = await api('GET', `/api/credits?status=${showAll ? 'all' : 'open'}`);
    const q = query.trim();
    const shown = q ? rows.filter((r) => r.name.includes(q) || r.rrn_front.includes(q)) : rows;
    const unpaid = shown.filter((r) => !r.paid);
    summary.replaceChildren(
      h('div', {}, h('span', { class: 'muted' }, '미수금 합계'), h('b', {}, `${won(unpaid.reduce((s, r) => s + r.amount, 0))}원`)),
      h('div', {}, h('span', { class: 'muted' }, '미완불 건수'), h('b', {}, `${unpaid.length}건`)),
    );
    list.replaceChildren(shown.length ? creditsTable(shown, load, err) : h('p', { class: 'muted' }, '표시할 내역이 없습니다.'));
  }

  const addForm = h('form', { onsubmit: submit(err, async (fd, form) => {
    const body = Object.fromEntries(fd);
    body.memo_done = fd.has('memo_done');
    await api('POST', '/api/credits', body);
    form.reset();
    form.elements.date.value = today();
    await load();
  }) },
    h('div', { class: 'row' },
      field('날짜', 'date', { type: 'date', value: today(), required: true, cls: 'narrow' }),
      field('환자명', 'name', { required: true }),
      field('주민번호 앞자리', 'rrn_front', { inputmode: 'numeric', maxLength: 6, pattern: '\\d{6}|', cls: 'narrow' }),
      field('외상 내용', 'content', { cls: 'wide' }),
      field('외상액(원)', 'amount', { type: 'number', inputmode: 'numeric', required: true, cls: 'narrow' }),
      h('label', { class: 'f narrow' }, '메모장 작성', h('input', { type: 'checkbox', name: 'memo_done' })),
      h('button', { class: 'btn', type: 'submit' }, '추가'),
    ),
  );

  const filters = h('div', { class: 'row' },
    h('label', { class: 'f wide' }, '검색 (이름·주민번호 앞자리)',
      h('input', { type: 'search', oninput: (e) => { query = e.target.value; load(); } })),
    h('div', { class: 'seg', role: 'group', 'aria-label': '보기' },
      h('button', { type: 'button', 'aria-pressed': 'true', onclick: (e) => setSeg(e, false) }, '미완불만'),
      h('button', { type: 'button', 'aria-pressed': 'false', onclick: (e) => setSeg(e, true) }, '전체')),
  );
  function setSeg(e, all) {
    showAll = all;
    for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
    load();
  }

  wrap.append(
    h('div', { class: 'card' }, h('h2', {}, '외상 추가'), addForm, err),
    h('div', { class: 'card' }, h('h2', {}, '환자 외상 장부'), summary, filters, list),
  );
  load().catch((e) => err.show(e.message));
  return wrap;
}

function creditsTable(rows, reload, err) {
  const isPharm = state.me.role === 'pharmacist';
  const patch = (id, body) => api('PATCH', `/api/credits/${id}`, body).then(reload).catch((e) => err.show(e.message));
  return h('table', {},
    h('thead', {}, h('tr', {},
      ['날짜', '환자명', '주민번호 앞', '외상 내용'].map((t) => h('th', {}, t)),
      h('th', { class: 'num' }, '외상액'),
      ['메모장', '완불', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', { class: r.paid ? 'paid' : '' },
      h('td', { 'data-label': '날짜' }, r.date),
      h('td', { 'data-label': '환자명' }, r.name),
      h('td', { 'data-label': '주민번호 앞' }, r.rrn_front),
      h('td', { 'data-label': '내용' }, r.content),
      h('td', { class: 'num', 'data-label': '외상액' }, won(r.amount)),
      h('td', { 'data-label': '메모장 작성' }, h('input', { type: 'checkbox', checked: !!r.memo_done, onchange: (e) => patch(r.id, { memo_done: e.target.checked }) })),
      h('td', { 'data-label': r.paid ? `완불 (${r.paid_date ?? ''})` : '완불' },
        h('input', { type: 'checkbox', checked: !!r.paid, 'aria-label': `${r.name} 완불`, onchange: (e) => patch(r.id, { paid: e.target.checked }) })),
      h('td', {}, isPharm && h('button', { class: 'btn danger small', onclick: async () => {
        if (!confirm(`${r.name} ${won(r.amount)}원 내역을 삭제할까요?`)) return;
        await api('DELETE', `/api/credits/${r.id}`).then(reload).catch((e) => err.show(e.message));
      } }, '삭제')),
    ))),
  );
}

// ---------- 병원 / 제약회사 원장 ----------
function ledgerView(type) {
  const isVendor = type === 'vendor';
  const labels = isVendor
    ? { billed: '입고액', party: '제약회사', nameHint: '예: 고려제약' }
    : { billed: '외상액', party: '병원', nameHint: '예: 한사랑병원' };
  const err = errorBox();
  const listBox = h('div', { class: 'card' });
  const detail = h('div');

  async function loadParties() {
    const parties = await api('GET', `/api/parties?type=${type}`);
    if (!parties.some((p) => p.id === state.partyId[type])) state.partyId[type] = parties[0]?.id ?? null;
    const total = parties.reduce((s, p) => s + p.balance, 0);
    listBox.replaceChildren(
      h('h2', {}, `${labels.party} 목록`),
      h('p', { class: 'muted' }, `전체 잔고 ${won(total)}원`),
      h('ul', { class: 'partylist' }, parties.map((p) => h('li', {},
        h('button', { 'aria-current': String(p.id === state.partyId[type]), onclick: () => { state.partyId[type] = p.id; loadParties(); } },
          h('span', {}, p.name), h('span', { class: `num ${p.balance < 0 ? 'neg' : ''}` }, won(p.balance)))))),
      state.me.role === 'pharmacist' && h('form', { class: 'row', onsubmit: submit(err, async (fd, form) => {
        const created = await api('POST', '/api/parties', { type, name: fd.get('name') });
        state.partyId[type] = created.id;
        form.reset();
        await loadParties();
      }) }, field(`${labels.party} 추가`, 'name', { required: true, placeholder: labels.nameHint }),
        h('button', { class: 'btn ghost', type: 'submit' }, '추가')),
    );
    await loadDetail();
  }

  async function loadDetail() {
    const id = state.partyId[type];
    if (!id) { detail.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'muted' }, `${labels.party}를 먼저 추가하세요.`))); return; }
    const from = state.range === 'year' ? `?from=${yearAgo()}` : '';
    const data = await api('GET', `/api/parties/${id}/entries${from}`);
    detail.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('h2', {}, data.party.name),
        h('div', { class: 'seg', role: 'group', 'aria-label': '기간' },
          h('button', { type: 'button', 'aria-pressed': String(state.range === 'year'), onclick: () => setRange('year') }, '최근 1년'),
          h('button', { type: 'button', 'aria-pressed': String(state.range === 'all'), onclick: () => setRange('all') }, '전체'))),
      h('div', { class: 'summary' }, h('div', {}, h('span', { class: 'muted' }, '현재 잔고'), h('b', { class: data.balance < 0 ? 'neg' : '' }, `${won(data.balance)}원`))),
      entryForm(id),
      ledgerTable(data, labels),
    ));
  }

  function setRange(r) { state.range = r; loadDetail().catch((e) => err.show(e.message)); }

  function entryForm(id) {
    return h('form', { onsubmit: submit(err, async (fd, form) => {
      await api('POST', `/api/parties/${id}/entries`, Object.fromEntries(fd));
      form.reset();
      form.elements.date.value = today();
      await loadParties();
    }) },
      h('div', { class: 'row' },
        field('날짜', 'date', { type: 'date', value: today(), required: true, cls: 'narrow' }),
        field('내용', 'description', { required: true, cls: 'wide', placeholder: '품목명 / 결제 / 반품 / 이월' }),
        field('수량', 'qty', { type: 'number', inputmode: 'numeric', cls: 'narrow' }),
        field(`${labels.billed}(원)`, 'billed', { type: 'number', inputmode: 'numeric', cls: 'narrow', placeholder: '반품은 -' }),
        field('결제액(원)', 'paid', { type: 'number', inputmode: 'numeric', cls: 'narrow' }),
        h('button', { class: 'btn', type: 'submit' }, '추가')),
    );
  }

  function ledgerTable(data) {
    const isPharm = state.me.role === 'pharmacist';
    const del = async (e) => {
      if (!confirm(`${e.date} ${e.description} 내역을 삭제할까요?`)) return;
      await api('DELETE', `/api/entries/${e.id}`).then(loadParties).catch((x) => err.show(x.message));
    };
    return h('table', {},
      h('thead', {}, h('tr', {},
        ['날짜', '내용'].map((t) => h('th', {}, t)),
        ['수량', labels.billed, '결제액', '잔고'].map((t) => h('th', { class: 'num' }, t)), h('th'))),
      h('tbody', {},
        data.opening != null && h('tr', { class: 'opening' },
          h('td', { 'data-label': '기준' }, '이전 잔액'), h('td', {}, '(기간 이전 내역 합계)'), h('td'), h('td'), h('td'),
          h('td', { class: 'num', 'data-label': '잔고' }, won(data.opening)), h('td')),
        data.entries.map((e) => h('tr', {},
          h('td', { 'data-label': '날짜' }, e.date),
          h('td', { 'data-label': '내용' }, e.description),
          h('td', { class: 'num', 'data-label': '수량' }, e.qty ?? ''),
          h('td', { class: 'num', 'data-label': labels.billed }, e.billed ? won(e.billed) : ''),
          h('td', { class: 'num', 'data-label': '결제액' }, e.paid ? won(e.paid) : ''),
          h('td', { class: `num ${e.balance < 0 ? 'neg' : ''}`, 'data-label': '잔고' }, won(e.balance)),
          h('td', {}, isPharm && h('button', { class: 'btn danger small', onclick: () => del(e) }, '삭제'))))),
    );
  }

  const wrap = h('div', { class: 'split' }, listBox, h('div', {}, err, detail));
  loadParties().catch((e) => err.show(e.message));
  return wrap;
}

// ---------- 직원 관리 ----------
function usersView() {
  const err = errorBox();
  const list = h('div');
  async function load() {
    const users = await api('GET', '/api/users');
    list.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, ['아이디', '이름', '권한', '상태', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', { 'data-label': '아이디' }, u.username),
        h('td', { 'data-label': '이름' }, u.name),
        h('td', { 'data-label': '권한' }, u.role === 'pharmacist' ? '약사' : '직원'),
        h('td', { 'data-label': '상태' }, u.active ? '사용 중' : '비활성'),
        h('td', {},
          h('button', { class: 'btn ghost small', onclick: async () => {
            const pw = prompt(`${u.name}의 새 비밀번호 (8자 이상)`);
            if (pw) await api('PATCH', `/api/users/${u.id}`, { password: pw }).then(() => alert('변경했습니다. 해당 계정은 다시 로그인해야 합니다.')).catch((e) => err.show(e.message));
          } }, '비밀번호 재설정'),
          u.id !== state.me.id && h('button', { class: 'btn danger small', onclick: async () => {
            await api('PATCH', `/api/users/${u.id}`, { active: !u.active }).then(load).catch((e) => err.show(e.message));
          } }, u.active ? '비활성화' : '다시 활성화'))))),
    ));
  }
  const form = h('form', { onsubmit: submit(err, async (fd, f) => {
    await api('POST', '/api/users', Object.fromEntries(fd));
    f.reset();
    await load();
  }) }, h('div', { class: 'row' },
    field('아이디', 'username', { required: true, autocapitalize: 'none' }),
    field('이름', 'name', { required: true }),
    h('label', { class: 'f' }, '비밀번호 (8자 이상)', h('input', { name: 'password', type: 'password', required: true, minLength: 8, autocomplete: 'new-password' })),
    h('label', { class: 'f narrow' }, '권한', h('select', { name: 'role' }, h('option', { value: 'staff' }, '직원'), h('option', { value: 'pharmacist' }, '약사'))),
    h('button', { class: 'btn', type: 'submit' }, '계정 추가')));
  load().catch((e) => err.show(e.message));
  return h('div', {},
    h('div', { class: 'card' }, h('h2', {}, '계정 추가'), h('p', { class: 'muted' }, '직원 권한은 환자·병원 외상 장부만 볼 수 있고, 제약회사 장부와 삭제 기능은 사용할 수 없습니다.'), form, err),
    h('div', { class: 'card' }, h('h2', {}, '계정 목록'), list));
}

// ---------- 시작 ----------
function render() {
  if (!state.me) root.replaceChildren(loginView());
  else root.replaceChildren(...shell());
}

api('GET', '/api/me').then((r) => { state.me = r.user; state.setup = r.setup; render(); })
  .catch(() => root.replaceChildren(h('p', { class: 'error' }, '서버에 연결할 수 없습니다.')));
