// Remember only a display hint. The server still checks the private session cookie.
(() => {
  const key = 'bellhop-session-hint';
  const maxAge = 12 * 60 * 60 * 1000;
  let hint = false;

  function read(){
    try{
      const saved = JSON.parse(localStorage.getItem(key));
      hint = saved?.signedIn === true && Date.now() - saved.checkedAt < maxAge;
    }catch { /* Use the current hint when browser storage is unavailable. */ }
    return hint;
  }

  function apply(){
    const signedIn = read();
    document.documentElement.dataset.signedIn = String(signedIn);
    document.querySelectorAll('[data-timetable-link]').forEach(link => {
      link.href = signedIn ? 'timetable.html' : 'login.html';
    });
  }

  function set(signedIn){
    hint = signedIn;
    try{
      localStorage.setItem(key, JSON.stringify({signedIn, checkedAt:Date.now()}));
    }catch { /* The page still works without browser storage. */ }
    apply();
  }

  window.BellhopSession = {set, apply};
  window.addEventListener('storage', event => { if(event.key === key) apply(); });
  apply();
})();
