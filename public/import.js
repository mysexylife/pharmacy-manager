import { h, api, errorBox, guard, toast, won, signed, badge } from './lib.js';

// 엑셀 가져오기: 파일을 올리면 먼저 결과를 보여 주고, 확인한 뒤에 넣는다.
async function toBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function importCard() {
  const err = errorBox();
  const out = h('div');
  const input = h('input', { type: 'file', accept: '.xlsx', multiple: true });
  let files = [];

  const readFiles = async () => {
    files = await Promise.all([...input.files].map(toBase64));
    return files;
  };

  const show = (s) => {
    const resetBox = h('input', { type: 'checkbox', 'aria-label': '기존 장부를 모두 지우고 다시 가져오기' });
    const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: '내 비밀번호', 'aria-label': '비밀번호' });
    const confirmText = h('input', { type: 'text', autocomplete: 'off', placeholder: '초기화', 'aria-label': '확인 글자' });
    const resetFields = h('div', { class: 'resetfields', hidden: true },
      h('p', { class: 'muted' }, '제약회사 입고·결제·반품·차용·메모, 병원 외상, 환자 외상 내역이 모두 지워지고 엑셀 내용으로 바뀝니다. 제약회사 이름과 회전 개월 수, 병원 단가표, 설정은 그대로입니다. 지우기 전에 서버에 백업이 자동으로 만들어지고, 가져오다 오류가 나면 아무것도 바뀌지 않습니다.'),
      h('div', { class: 'row' }, pw, confirmText), h('p', { class: 'muted small' }, '비밀번호와, 확인 칸에 초기화 라고 입력하세요.'));
    const commitBtn = h('button', { class: 'btn', type: 'button' }, '이대로 가져오기');
    // 가져오지 않고 미리보기를 닫는다 (고른 파일도 비운다)
    const cancelBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => { out.replaceChildren(); input.value = ''; files = []; } }, '취소');
    const modes = new Map(); // 제약회사 시트 → 'excel' | 'calc'
    const rows = s.vendors.map((v) => {
      const sel = h('select', { disabled: !v.mismatch, onchange: () => modes.set(v.sheet, sel.value) },
        h('option', { value: 'excel' }, '엑셀 잔고에 맞춤'), h('option', { value: 'calc' }, '계산값 유지'));
      const appCell = v.app == null ? h('td', { class: 'num muted' }, '앱에 없음')
        : h('td', { class: 'num' }, `${won(v.app)} `, v.app === v.excel ? badge('일치') : badge(`차이 ${signed(v.excel - v.app)}`, 'warn'));
      return h('tr', {},
        h('td', {}, v.name), h('td', { class: 'num' }, `${v.sourceRows} → ${v.entries + v.returns}`), h('td', { class: 'num muted' }, v.noAmount ? `${v.noAmount}` : ''),
        h('td', { class: 'num' }, won(v.computed)), h('td', { class: 'num' }, won(v.excel)), appCell,
        h('td', { class: 'num' }, v.mismatch ? badge(signed(v.diff), 'warn') : '일치'),
        h('td', {}, v.mismatch ? sel : ''),
        h('td', { class: 'muted' }, v.yearFixes ? `연도 보정 ${v.yearFixes}건` : ''));
    });
    const lines = [];
    if (s.skipped.length) lines.push(`제외: ${s.skipped.map((x) => x.sheet).join(', ')}`);
    if (s.hospital) lines.push(`병원 외상(한사랑의원): 엑셀 ${s.hospital.sourceRows}줄 → 앱 ${s.hospital.entries}줄 (같은 줄 5,000원 결제를 할인으로 합친 ${s.hospital.merged}건, 금액 없는 품목 줄 ${s.hospital.zero}줄은 제외), 단가표 ${s.hospital.products}개, 잔고 ${won(s.hospital.computed)}원 (앱 현재 ${won(s.hospital.app)}원${s.hospital.app === s.hospital.excel ? ', 일치' : ', 차이 있음'})${s.hospital.mismatch ? ` (엑셀 ${won(s.hospital.excel)}원과 다름 → 엑셀 기준으로 맞춤)` : ' (엑셀과 일치)'}`);
    if (s.credits) lines.push(`환자 외상: ${s.credits.rows}건 (미완불 ${s.credits.open}건, ${won(s.credits.openTotal)}원) · 앱 현재 미완불 ${s.credits.appOpen}건, ${won(s.credits.appOpenTotal)}원${s.credits.appOpen === s.credits.open && s.credits.appOpenTotal === s.credits.openTotal ? ' (일치)' : ' (차이 있음)'}`);
    out.replaceChildren(
      h('table', {},
        h('thead', {}, h('tr', {}, ['제약회사', '엑셀 줄 → 앱 줄', '그중 금액 없는 줄', '계산 잔고', '엑셀 잔고', '앱 현재 잔고', '차이', '다를 때', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows)),
      h('ul', {}, lines.map((l) => h('li', {}, l))),
      h('label', { class: 'check resetcheck' }, resetBox, '기존 장부를 모두 지우고 처음부터 다시 가져오기 (전환할 때)'),
      resetFields,
      h('p', { class: 'muted' }, '차이가 있는 제약회사는 마지막 줄에 "조정" 한 줄을 넣어 엑셀의 마지막 잔고와 맞춥니다. 이미 장부가 들어 있는 제약회사는 건너뜁니다.'),
      h('div', { class: 'row' }, commitBtn, cancelBtn));
    resetBox.addEventListener('change', () => {
      resetFields.hidden = !resetBox.checked;
      commitBtn.textContent = resetBox.checked ? '모두 지우고 가져오기' : '이대로 가져오기';
      commitBtn.classList.toggle('dangerfill', resetBox.checked);
    });
    commitBtn.onclick = guard(err, async () => {
        const useComputed = [...modes].filter(([, m]) => m === 'calc').map(([k]) => k);
        const body = { files: await readFiles(), useComputed };
        if (resetBox.checked) {
          if (!window.confirm('제약회사 장부, 병원 외상, 환자 외상의 기존 내역을 모두 지우고 엑셀 내용으로 바꿉니다. 계속할까요?')) return;
          Object.assign(body, { reset: true, password: pw.value, confirm: confirmText.value.trim() });
        }
        const r = await api('POST', '/api/import/commit', body);
        out.replaceChildren(h('p', {}, `가져왔어요: 제약회사 ${r.vendors}곳, 환자 외상 ${r.credits}건${r.hospital ? ', 병원 외상' : ''}.`
          + (r.reset ? ` 기존 내역은 지우고 새로 넣었습니다. 지우기 전 백업: 서버의 backups 폴더(${r.backup ?? '없음'})` : '')
          + (r.skippedExisting.length ? ` 이미 있어 건너뜀: ${r.skippedExisting.join(', ')}` : '')));
        toast('가져왔어요');
    });
  };

  return h('div', { class: 'card' }, h('h2', {}, '엑셀에서 가져오기'),
    h('p', { class: 'muted' }, '제약회사 장부와 외상 장부(.xlsx)를 함께 선택하세요. 파일은 이 앱 서버로만 전송되고, 먼저 결과를 보여 드린 뒤 확인하면 넣습니다.'),
    h('div', { class: 'row' }, input, h('button', { class: 'btn ghost', type: 'button', onclick: guard(err, async () => {
      if (!input.files.length) throw new Error('엑셀 파일을 선택하세요');
      out.replaceChildren(h('p', { class: 'muted' }, '읽는 중…'));
      show(await api('POST', '/api/import/preview', { files: await readFiles() }));
    }) }, '미리보기')),
    err, out);
}
