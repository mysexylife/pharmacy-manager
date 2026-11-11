import { h, api, state, errorBox, submit, field, icon, logo } from './lib.js';
import { dueView } from './due.js';
import { vendorsView } from './vendors.js';
import { hospitalsView } from './hospitals.js';
import { creditsView } from './credits.js';
import { settingsView } from './settings.js';
import { undoControls, clearUndo } from './undo.js';

const root = document.getElementById('app');

const TABS = [
  ['due', '결제 대상', dueView, 'due'],
  ['vendors', '제약회사 장부', vendorsView, 'vendors'],
  ['hospitals', '병원 외상', hospitalsView, 'hospitals'],
  ['credits', '환자 외상', creditsView, 'credits'],
  ['settings', '설정', settingsView, 'settings'],
];

function loginView() {
  const err = errorBox();
  const setup = state.setup;
  return h('div', { class: 'login' }, h('div', { class: 'brand center' }, logo(), h('span', { class: 'brandname' }, '푸른약국')), h('form', { class: 'card', onsubmit: submit(err, async (fd) => {
    const body = Object.fromEntries(fd);
    body.remember = fd.has('remember');
    const { user } = await api('POST', setup ? '/api/setup' : '/api/login', body);
    state.me = user;
    state.setup = false;
    render();
  }) },
  h('h2', {}, setup ? '처음 설정: 약사 계정 만들기' : '로그인'),
  field('아이디', 'username', { required: true, autocomplete: 'username', autocapitalize: 'none' }),
  h('label', { class: 'f' }, setup ? '비밀번호 (10자 이상, 길게)' : '비밀번호',
    h('input', { name: 'password', type: 'password', required: true, minLength: setup ? 10 : 1, autocomplete: setup ? 'new-password' : 'current-password' })),
  !setup && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'remember' }), '이 기기에서 로그인 유지 (자주 쓰는 기기만)'),
  err,
  h('button', { class: 'btn', type: 'submit' }, setup ? '계정 만들기' : '로그인')));
}

async function logout() {
  await api('POST', '/api/logout', {}).catch(() => {});
  clearUndo();
  state.me = null;
  render();
}

// 큰 화면에서는 왼쪽 사이드바, 폰에서는 아래쪽 메뉴 막대가 된다.
function shell() {
  const current = TABS.find(([id]) => id === state.tab) ?? TABS[0];
  const nav = h('nav', { class: 'tabs', 'aria-label': '메뉴' }, TABS.map(([id, label, , ic]) => h('button', {
    type: 'button', title: label, 'aria-current': id === current[0] ? 'page' : null,
    onclick: () => { state.tab = id; render(); },
  }, icon(ic), h('span', { class: 'label' }, label))));
  return [
    h('div', { class: 'shell' },
      h('aside', { class: 'side' },
        h('div', { class: 'brand' }, logo(), h('span', { class: 'brandname' }, '푸른약국')),
        nav,
        undoControls('insidebar'),
        h('button', { type: 'button', class: 'navlogout', title: '로그아웃', onclick: logout }, icon('logout'), h('span', { class: 'label' }, '로그아웃'))),
      h('div', { class: 'content' },
        h('header', { class: 'topbar' }, h('div', { class: 'brand' }, logo(), h('span', { class: 'brandname' }, '푸른약국')),
          h('div', { class: 'topright' }, undoControls('top'),
            h('button', { type: 'button', class: 'iconbtn', 'aria-label': '로그아웃', onclick: logout }, icon('logout')))),
        h('main', {}, current[2]()))),
  ];
}

function render({ keepScroll = false } = {}) {
  const y = window.scrollY;
  root.replaceChildren(...(state.me ? shell() : [loginView()]));
  window.scrollTo(0, keepScroll ? y : 0);
}

// 실행 취소 뒤에 지금 보던 화면을 그 자리에서 다시 그린다
state.reload = () => render({ keepScroll: true });

state.onLogout = () => { state.me = null; render(); };

api('GET', '/api/me')
  .then((r) => { state.me = r.user; state.setup = r.setup; render(); })
  .catch(() => root.replaceChildren(h('p', { class: 'error' }, '서버에 연결할 수 없습니다.')));
