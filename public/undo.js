import { api, toast, state, icon } from './lib.js';

// 실행 취소 / 다시 실행. 화면에서 한 작업(추가·삭제·고치기·체크)을 이 브라우저 안에서 기억해 두었다가 되돌린다.
// 삭제는 휴지통을 거치므로 되돌릴 수 있다. 페이지를 새로 열면 기록은 사라진다.
const MAX = 50;
const undoStack = [];
const redoStack = [];
const bars = new Set();

const DEL = {
  vendor_entries: (id) => `/api/entries/${id}`,
  hospital_entries: (id) => `/api/hospital-entries/${id}`,
  credits: (id) => `/api/credits/${id}`,
  vendor_returns: (id) => `/api/returns/${id}`,
  vendor_loans: (id) => `/api/loans/${id}`,
  vendor_notes: (id) => `/api/notes/${id}`,
};
const restore = (table, id) => api('POST', '/api/trash/restore', { table, id });

function notify() { for (const b of bars) b(); }

function record(entry) {
  undoStack.push(entry);
  if (undoStack.length > MAX) undoStack.shift();
  redoStack.length = 0;
  notify();
}

// 새로 추가한 것 (promise는 { id }를 돌려주는 POST)
export async function created(table, label, promise) {
  const r = await promise;
  record({ label: `${label} 추가`, undo: () => api('DELETE', DEL[table](r.id)), redo: () => restore(table, r.id) });
  return r;
}

export async function deleted(table, id, label) {
  await api('DELETE', DEL[table](id));
  record({ label: `${label} 삭제`, undo: () => restore(table, id), redo: () => api('DELETE', DEL[table](id)) });
}

// 값을 고친 것: before/after는 PATCH로 보내는 값
export async function patched(url, before, after, label) {
  await api('PATCH', url, after);
  record({ label, undo: () => api('PATCH', url, before), redo: () => api('PATCH', url, after) });
}

async function run(from, to, verb, key) {
  const entry = from.pop();
  if (!entry) return;
  try {
    await entry[key]();
    to.push(entry);
    toast(`${verb}: ${entry.label}`);
  } catch (e) {
    toast(`${verb}하지 못했어요: ${e.message}`, 'bad');
  }
  notify();
  state.reload?.();
}
export const undo = () => run(undoStack, redoStack, '되돌렸어요', 'undo');
export const redo = () => run(redoStack, undoStack, '다시 했어요', 'redo');

export function clearUndo() { undoStack.length = 0; redoStack.length = 0; notify(); }

// 실행 취소 · 다시 실행 버튼 한 쌍
export function undoControls(className = '') {
  const mk = (name, label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'undobtn';
    b.append(icon(name), Object.assign(document.createElement('span'), { className: 'label', textContent: label }));
    b.addEventListener('click', fn);
    return b;
  };
  const u = mk('undo', '실행 취소', undo);
  const r = mk('redo', '다시 실행', redo);
  const wrap = document.createElement('div');
  wrap.className = `undobar ${className}`;
  wrap.append(u, r);
  let seen = false; // 화면에 붙은 적이 있는데 지금은 떨어져 있으면(화면을 다시 그린 것) 목록에서 뺀다
  const update = () => {
    if (wrap.isConnected) seen = true;
    else if (seen) { bars.delete(update); return; }
    u.disabled = undoStack.length === 0;
    r.disabled = redoStack.length === 0;
    u.title = undoStack.length ? `실행 취소: ${undoStack.at(-1).label} (Ctrl+Z)` : '실행 취소할 작업이 없어요';
    r.title = redoStack.length ? `다시 실행: ${redoStack.at(-1).label} (Ctrl+Y)` : '다시 실행할 작업이 없어요';
  };
  bars.add(update);
  update();
  return wrap;
}

// Ctrl+Z / Ctrl+Y (글자를 쓰는 중에는 브라우저의 글자 되돌리기를 그대로 둔다)
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const t = document.activeElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
});
