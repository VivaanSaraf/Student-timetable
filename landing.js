const topbar = document.querySelector('.topbar');
const navToggle = document.getElementById('navToggle');
const topbarNav = document.getElementById('topbarNav');

navToggle.addEventListener('click', () => {
  const isOpen = topbar.classList.toggle('nav-open');
  navToggle.setAttribute('aria-expanded', isOpen);
});

topbarNav.addEventListener('click', (e) => {
  if(e.target.closest('a')){
    topbar.classList.remove('nav-open');
    navToggle.setAttribute('aria-expanded', 'false');
  }
});
