/* --- 導覽收合腳本：hamburger ⇄ drawer，含 Esc / 點遮罩收合 ----------- */
const btn = document.querySelector('.site-menu-btn');
const nav = document.getElementById('site-nav');
if (btn && nav) {
  const close = () => {
    document.body.classList.remove('nav-open');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Open menu');
  };
  btn.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) {
      close();
      btn.focus();
    }
  });
  /* 點側邊欄外的遮罩收合 */
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('nav-open')) return;
    if (nav.contains(e.target) || btn.contains(e.target)) return;
    close();
  });
  /* 導覽內連結被點擊後收合（SPA 式體感） */
  nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', close));
  /* 寬度回到桌機時自動清態 */
  matchMedia('(min-width: 820.5px)').addEventListener('change', close);
}
