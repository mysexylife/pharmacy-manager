// 화면 모드: 기본은 밝게. 설정에서 어둡게로 바꿀 수 있고, 이 기기(브라우저)에 기억한다.
const KEY = 'pharmacy-theme';
export function getTheme() {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}
export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* 저장이 막혀 있어도 이번 화면에서는 바뀐다 */ }
  apply(theme);
}
export function apply(theme = getTheme()) {
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}
apply();
