import { h, api, state, errorBox, submit, field } from './lib.js';
import { dueView } from './due.js';
import { vendorsView } from './vendors.js';
import { hospitalsView } from './hospitals.js';
import { creditsView } from './credits.js';
import { settingsView } from './settings.js';

const root = document.getElementById('app');

const TABS = [
  ['due', '결제 대상', dueView],
  ['vendors', '제약회사 장부', vendorsView],
  ['hospitals', '병원 외상', hospitalsView],
  ['credits', '환자 외상', creditsView],
  ['settings', '설정', settingsView],
];

function loginView() {
  const err = errorBox();
  const setup = state.setup;
  return h('div', { class: 'login' }, h('form', { class: 'card', onsubmit: submit(err, async (fd) => {
    const body = Object.fromEntries(fd);
    body.remember = fd.has('remember');
    const { user } = await api('POST', setup ? '/api/setup' : '/api/login', body);
    state.me = user;
    state.setup = false;
    render();
  }) },
  h('h2', {}, setup ? '처음 설정: 약사 계정 만들기' : '푸른약국 장부'),
  field('아이디', 'username', { required: true, autocomplete: 'username', autocapitalize: 'none' }),
  h('label', { class: 'f' }, setup ? '비밀번호 (10자 이상, 길게)' : '비밀번호',
    h('input', { name: 'password', type: 'password', required: true, minLength: setup ? 10 : 1, autocomplete: setup ? 'new-password' : 'current-password' })),
  !setup && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'remember' }), '이 기기에서 로그인 유지 (자주 쓰는 기기만)'),
  err,
  h('button', { class: 'btn', type: 'submit' }, setup ? '계정 만들기' : '로그인')));
}

function shell() {
  const current = TABS.find(([id]) => id === state.tab) ?? TABS[0];
  return [
    h('header', { class: 'top' },
      h('h1', {}, '푸른약국 장부'),
      h('button', { type: 'button', class: 'btn ghost small', onclick: async () => {
        await api('POST', '/api/logout', {}).catch(() => {});
        state.me = null;
        render();
      } }, '로그아웃')),
    h('nav', { class: 'tabs' }, TABS.map(([id, label]) => h('button', {
      type: 'button', 'aria-current': id === current[0] ? 'page' : null,
      onclick: () => { state.tab = id; render(); },
    }, label))),
    h('main', {}, current[2]()),
  ];
}

function render() {
  root.replaceChildren(...(state.me ? shell() : [loginView()]));
  window.scrollTo(0, 0);
}

state.onLogout = () => { state.me = null; render(); };

api('GET', '/api/me')
  .then((r) => { state.me = r.user; state.setup = r.setup; render(); })
  .catch(() => root.replaceChildren(h('p', { class: 'error' }, '서버에 연결할 수 없습니다.')));
