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

async function updateTimetableLinks(){
  BellhopSession.apply();
  try{
    const response = await fetch('/api/session', {credentials:'same-origin'});
    if(response.ok) BellhopSession.set(true);
    else if(response.status === 401) BellhopSession.set(false);
  }catch { /* Keep the last confirmed display while the server is unreachable. */ }
}

BellhopSession.apply();
document.querySelectorAll('[data-current-year]').forEach(item => {
  item.textContent = new Date().getFullYear();
});
window.addEventListener('pageshow', updateTimetableLinks);
