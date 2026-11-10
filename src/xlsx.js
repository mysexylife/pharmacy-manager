// 의존성 없는 최소 xlsx 읽기 (zip + XML). 값만 읽는다: 수식은 저장된 계산 결과를 쓴다.
import { inflateRawSync } from 'node:zlib';

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx 파일이 아닙니다');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx 파일이 손상되었습니다');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    files.set(name, () => (method === 0 ? raw : inflateRawSync(raw)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENT[e.toLowerCase()];
});

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

// 반환: [{ name, rows: Map(rowNumber -> Map(colIndex -> value)) }]  (값은 문자열 또는 숫자)
export function readXlsx(buf) {
  const files = unzip(buf);
  const text = (name) => (files.has(name) ? files.get(name)().toString('utf8') : null);

  const shared = [];
  const sst = text('xl/sharedStrings.xml');
  if (sst) {
    for (const si of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push(decode([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
    }
  }

  const rels = new Map();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]*)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]*)"/)?.[1];
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const sheets = [];
  for (const m of (text('xl/workbook.xml') ?? '').matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(m[0].match(/\bname="([^"]*)"/)?.[1] ?? '');
    const rid = m[0].match(/\br:id="([^"]*)"/)?.[1];
    const path = rels.get(rid);
    const xml = path && text(path);
    if (!xml) continue;
    const rows = new Map();
    for (const rm of xml.matchAll(/<row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells = new Map();
      for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = cm[1].match(/\br="([A-Z]+\d+)"/)?.[1];
        if (!ref || cm[2] == null) continue;
        const t = cm[1].match(/\bt="(\w+)"/)?.[1];
        const v = cm[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let val;
        if (t === 'inlineStr') val = decode([...cm[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
        else if (v === undefined) continue;
        else if (t === 's') val = shared[Number(v)];
        else if (t === 'str' || t === 'e') val = decode(v);
        else if (t === 'b') val = v === '1' ? 1 : 0;
        else val = Number(v);
        if (val !== undefined && val !== '') cells.set(colIndex(ref), val);
      }
      if (cells.size) rows.set(Number(rm[1]), cells);
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

// 엑셀 날짜 일련번호 → 'YYYY-MM-DD'
export function serialToIso(n) {
  if (typeof n !== 'number' || !(n > 20000 && n < 80000)) return null;
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
}
