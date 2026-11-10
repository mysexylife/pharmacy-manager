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
    const modes = new Map(); // 제약회사 시트 → 'excel' | 'calc'
    const rows = s.vendors.map((v) => {
      const sel = h('select', { disabled: !v.mismatch, onchange: () => modes.set(v.sheet, sel.value) },
        h('option', { value: 'excel' }, '엑셀 잔고에 맞춤'), h('option', { value: 'calc' }, '계산값 유지'));
      return h('tr', {},
        h('td', {}, v.name), h('td', { class: 'num' }, `${v.entries + v.returns}`),
        h('td', { class: 'num' }, won(v.computed)), h('td', { class: 'num' }, won(v.excel)),
        h('td', { class: 'num' }, v.mismatch ? badge(signed(v.diff), 'warn') : '일치'),
        h('td', {}, v.mismatch ? sel : ''),
        h('td', { class: 'muted' }, v.yearFixes ? `연도 보정 ${v.yearFixes}건` : ''));
    });
    const lines = [];
    if (s.skipped.length) lines.push(`제외: ${s.skipped.map((x) => x.sheet).join(', ')}`);
    if (s.hospital) lines.push(`병원 외상(한사랑의원): ${s.hospital.entries}줄, 단가표 ${s.hospital.products}개, 잔고 ${won(s.hospital.computed)}원${s.hospital.mismatch ? ` (엑셀 ${won(s.hospital.excel)}원과 다름 → 엑셀 기준으로 맞춤)` : ' (엑셀과 일치)'}`);
    if (s.credits) lines.push(`환자 외상: ${s.credits.rows}건 (미완불 ${s.credits.open}건, ${won(s.credits.openTotal)}원)`);
    out.replaceChildren(
      h('table', {},
        h('thead', {}, h('tr', {}, ['제약회사', '줄 수', '계산 잔고', '엑셀 잔고', '차이', '다를 때', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows)),
      h('ul', {}, lines.map((l) => h('li', {}, l))),
      h('p', { class: 'muted' }, '차이가 있는 제약회사는 마지막 줄에 "조정" 한 줄을 넣어 엑셀의 마지막 잔고와 맞춥니다. 이미 장부가 들어 있는 제약회사는 건너뜁니다.'),
      h('button', { class: 'btn', type: 'button', onclick: guard(err, async () => {
        const useComputed = [...modes].filter(([, m]) => m === 'calc').map(([k]) => k);
        const r = await api('POST', '/api/import/commit', { files: await readFiles(), useComputed });
        out.replaceChildren(h('p', {}, `가져왔어요: 제약회사 ${r.vendors}곳, 환자 외상 ${r.credits}건${r.hospital ? ', 병원 외상' : ''}.`
          + (r.skippedExisting.length ? ` 이미 있어 건너뜀: ${r.skippedExisting.join(', ')}` : '')));
        toast('가져왔어요');
      }) }, '이대로 가져오기'));
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
