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
  let signedIn = false;
  try{
    const response = await fetch('/api/session', {credentials:'same-origin'});
    signedIn = response.ok;
  }catch { /* The login page will show a connection message if needed. */ }
  document.querySelectorAll('[data-timetable-link]').forEach(link => {
    link.href = signedIn ? 'timetable.html' : 'login.html';
    link.textContent = signedIn ? 'Your Timetable' : 'Make Your Timetable';
  });
}

document.querySelectorAll('[data-current-year]').forEach(item => {
  item.textContent = new Date().getFullYear();
});
window.addEventListener('pageshow', updateTimetableLinks);
