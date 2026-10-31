import {
  h, api, errorBox, guard, submit, field, moneyField, formatDate, toast,
} from './lib.js';

// 설정: 비밀번호, 기준값, 백업·엑셀 내보내기, 휴지통.
export function settingsView() {
  const err = errorBox();
  const trashBox = h('div');
  const settingsForm = h('form', { class: 'row' });

  const loadTrash = guard(err, async () => {
    const items = await api('GET', '/api/trash');
    trashBox.replaceChildren(items.length === 0
      ? h('p', { class: 'muted' }, '휴지통이 비어 있습니다.')
      : h('table', {},
        h('thead', {}, h('tr', {}, ['내용', '날짜', '삭제한 날', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, items.map((t) => h('tr', {},
          h('td', { 'data-label': '내용' }, t.label),
          h('td', { 'data-label': '날짜' }, formatDate(t.date.slice(0, 10))),
          h('td', { 'data-label': '삭제한 날' }, formatDate(t.deleted_at.slice(0, 10))),
          h('td', {}, h('button', { type: 'button', class: 'btn ghost small', onclick: guard(err, async () => {
            await api('POST', '/api/trash/restore', { table: t.table, id: t.id });
            toast('되살렸어요');
            await loadTrash();
          }) }, '되살리기')))))));
  });

  const loadSettings = guard(err, async () => {
    const s = await api('GET', '/api/settings');
    settingsForm.replaceChildren(
      moneyField('연체 기준(일)', 'overdue_days', { value: String(s.overdue_days), required: true }),
      moneyField('처방조제약 할인액(원)', 'rx_discount', { value: String(s.rx_discount), required: true }),
      h('button', { class: 'btn', type: 'submit' }, '저장'));
  });
  settingsForm.addEventListener('submit', submit(err, async (fd) => {
    await api('PUT', '/api/settings', Object.fromEntries(fd));
    toast('저장했어요');
  }));

  loadTrash();
  loadSettings();
  return h('div', {}, err,
    h('div', { class: 'card' }, h('h2', {}, '기준값'), settingsForm),
    h('div', { class: 'card' }, h('h2', {}, '백업과 엑셀 내보내기'),
      h('p', { class: 'muted' }, '백업 파일에는 모든 장부와 환자 정보가 들어 있습니다. 안전한 곳에 보관하세요.'),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: '/api/backup' }, '백업 파일 받기'),
        h('a', { class: 'btn ghost', href: '/api/export/vendors.csv' }, '제약회사 장부(엑셀)'),
        h('a', { class: 'btn ghost', href: '/api/export/hospitals.csv' }, '병원 외상(엑셀)'),
        h('a', { class: 'btn ghost', href: '/api/export/credits.csv' }, '환자 외상(엑셀)'))),
    h('div', { class: 'card' }, h('h2', {}, '비밀번호 바꾸기'),
      h('form', { class: 'row', onsubmit: submit(err, async (fd, form) => {
        await api('POST', '/api/password', Object.fromEntries(fd));
        form.reset();
        toast('바꿨어요. 다른 기기는 다시 로그인해야 해요');
      }) },
      h('label', { class: 'f' }, '현재 비밀번호', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
      h('label', { class: 'f' }, '새 비밀번호 (10자 이상)', h('input', { name: 'next', type: 'password', required: true, minLength: 10, autocomplete: 'new-password' })),
      h('button', { class: 'btn', type: 'submit' }, '바꾸기'))),
    h('div', { class: 'card' }, h('h2', {}, '휴지통'),
      h('p', { class: 'muted' }, '삭제한 내역은 30일 동안 여기서 되살릴 수 있습니다.'), trashBox));
}
