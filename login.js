const form = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const confirmInput = document.getElementById('confirm');
const confirmField = document.getElementById('confirmField');
const formError = document.getElementById('formError');
const submitBtn = document.getElementById('submitBtn');
const modeTabs = document.getElementById('modeTabs');
const heading = document.getElementById('loginHeading');
const sub = document.getElementById('loginSub');

let mode = 'login';

document.getElementById('homeBtn').addEventListener('click', () => {
  window.location.href = 'index.html';
});

function readJSON(key, fallback){
  try { return JSON.parse(localStorage.getItem(key)) || fallback; }
  catch { return fallback; }
}

function oldTimetable(id, includeUnassigned = false){
  const own = readJSON(`timetable-classes:${id}`, []);
  if(Array.isArray(own) && own.length) return own;
  if(!includeUnassigned) return [];
  const older = readJSON('timetable-classes', []);
  return Array.isArray(older) ? older : [];
}

async function api(path, body){
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body)
  });
  if(!(response.headers.get('Content-Type') || '').includes('application/json')){
    throw new Error('The login service is unavailable. Please try again shortly.');
  }
  const data = await response.json();
  if(!response.ok){
    const error = new Error(data.error || 'Something went wrong.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function setMode(next){
  mode = next;
  formError.hidden = true;
  modeTabs.querySelectorAll('.mode-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === next);
  });
  const signup = next === 'signup';
  confirmField.hidden = !signup;
  confirmInput.required = signup;
  heading.textContent = signup ? 'Make an account 🚀' : 'Welcome back 👋';
  sub.textContent = signup
    ? 'Pick a name and a password to save your timetable.'
    : 'Log in to build and check your timetable.';
  submitBtn.textContent = signup ? 'Sign Up' : 'Log In';
  passwordInput.autocomplete = signup ? 'new-password' : 'current-password';
}

modeTabs.addEventListener('click', e => {
  const tab = e.target.closest('.mode-tab');
  if(tab) setMode(tab.dataset.mode);
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  formError.hidden = true;
  const name = usernameInput.value.trim();
  const password = passwordInput.value;
  const id = name.toLowerCase();
  if(!name || !password) return;
  if(mode === 'signup' && password !== confirmInput.value){
    showError("Those two passwords don't match.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = mode === 'signup' ? 'Creating…' : 'Checking…';
  try{
    let account;
    if(mode === 'signup'){
      account = await api('/api/signup', { name, password });
    }else{
      try{
        account = await api('/api/login', { name, password });
      }catch(error){
        // Accounts made before the server existed live in the original browser.
        // The server verifies the password and transfers the account and classes.
        const old = readJSON('timetable-accounts', {})[id];
        if(error.status !== 404 || !old) throw error;
        const classes = oldTimetable(id, true);
        account = await api('/api/migrate', {
          name: old.name || name, password,
          legacy: { salt: old.salt, hash: old.hash, iterations: old.iterations || 150000 },
          classes: Array.isArray(classes) ? classes : []
        });
      }
    }

    // A migrated account may have an older timetable on this browser.
    const oldClasses = oldTimetable(account.user);
    if(Array.isArray(oldClasses) && oldClasses.length){
      await api('/api/classes/import-if-empty', { classes: oldClasses });
    }
    window.location.href = 'timetable.html';
  }catch(error){
    showError(error.message === 'Failed to fetch'
      ? 'Cannot reach the Bellhop server. Ask the host to start it.'
      : error.message);
    passwordInput.value = '';
  }finally{
    submitBtn.disabled = false;
    submitBtn.textContent = mode === 'signup' ? 'Sign Up' : 'Log In';
  }
});

function showError(message){
  formError.textContent = message;
  formError.hidden = false;
}

setMode('login');

window.addEventListener('pageshow', async () => {
  try{
    const response = await fetch('/api/session', {credentials:'same-origin'});
    if(response.ok) window.location.replace('timetable.html');
  }catch { /* Keep the form available if the server cannot be reached. */ }
});
