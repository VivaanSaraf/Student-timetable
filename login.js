/* Bellhop — browser-only accounts.
 *
 * Passwords are never stored. Each account keeps a random salt and a PBKDF2
 * hash, and logging in re-derives the hash to compare. There is no server, so
 * this protects against someone casually reading localStorage — not against
 * someone using developer tools on this device.
 */

const ACCOUNTS_KEY = 'timetable-accounts';
const SESSION_KEY  = 'timetable-session';
const LOCKOUT_KEY  = 'timetable-lockout';

const ITERATIONS   = 150000;
const MIN_PASSWORD = 8;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS   = 60 * 1000;        // 1 minute after too many wrong tries
const SESSION_MS   = 12 * 60 * 60 * 1000; // stay logged in for 12 hours

const form = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const confirmInput = document.getElementById('confirm');
const confirmField = document.getElementById('confirmField');
const formError = document.getElementById('formError');
const formOk = document.getElementById('formOk');
const submitBtn = document.getElementById('submitBtn');
const modeTabs = document.getElementById('modeTabs');
const heading = document.getElementById('loginHeading');
const sub = document.getElementById('loginSub');
const homeBtn = document.getElementById('homeBtn');

let mode = 'login';

homeBtn.addEventListener('click', () => {
  window.location.href = 'index.html';
});

/* ---------- storage helpers ---------- */

function readJSON(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch(e){
    return fallback;
  }
}

function writeJSON(key, value){
  try{
    localStorage.setItem(key, JSON.stringify(value));
  }catch(e){}
}

const readAccounts = () => readJSON(ACCOUNTS_KEY, {});
const readLockouts = () => readJSON(LOCKOUT_KEY, {});

/* ---------- password hashing ---------- */

function toBase64(bytes){
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(str){
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function derive(password, salt, iterations){
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name:'PBKDF2', salt, iterations, hash:'SHA-256' }, key, 256
  );
  return toBase64(new Uint8Array(bits));
}

/* ---------- ui helpers ---------- */

function showError(message){
  formError.textContent = message;
  formError.hidden = false;
  formOk.hidden = true;
}

function clearMessages(){
  formError.hidden = true;
  formOk.hidden = true;
}

function setMode(next){
  mode = next;
  clearMessages();

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
  passwordInput.setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
}

modeTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.mode-tab');
  if(tab) setMode(tab.dataset.mode);
});

/* ---------- lockout ---------- */

function lockRemaining(id){
  const entry = readLockouts()[id];
  if(!entry || !entry.until) return 0;
  return Math.max(0, entry.until - Date.now());
}

function recordFailure(id){
  const locks = readLockouts();
  const entry = locks[id] || { fails: 0, until: 0 };
  entry.fails += 1;
  if(entry.fails >= MAX_ATTEMPTS){
    entry.until = Date.now() + LOCKOUT_MS;
    entry.fails = 0;
  }
  locks[id] = entry;
  writeJSON(LOCKOUT_KEY, locks);
  return entry;
}

function clearFailures(id){
  const locks = readLockouts();
  delete locks[id];
  writeJSON(LOCKOUT_KEY, locks);
}

/* ---------- submit ---------- */

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearMessages();

  if(!window.crypto || !crypto.subtle){
    showError("This browser won't let the page hash passwords here. Open the site over http://localhost instead of the file itself.");
    return;
  }

  const name = usernameInput.value.trim();
  const password = passwordInput.value;
  const id = name.toLowerCase();

  if(!name || !password){
    showError('Fill in both your name and a password.');
    return;
  }

  const waitMs = lockRemaining(id);
  if(waitMs > 0){
    showError(`Too many wrong tries. Give it ${Math.ceil(waitMs / 1000)} seconds.`);
    return;
  }

  const accounts = readAccounts();
  const account = accounts[id];

  submitBtn.disabled = true;
  submitBtn.textContent = mode === 'signup' ? 'Creating…' : 'Checking…';

  try{
    if(mode === 'signup'){
      if(account){
        showError('That name is taken on this device. Log in instead, or pick another.');
        return;
      }
      if(password.length < MIN_PASSWORD){
        showError(`Passwords need at least ${MIN_PASSWORD} characters.`);
        return;
      }
      if(password.toLowerCase() === id){
        showError("Your password can't just be your name.");
        return;
      }
      if(password !== confirmInput.value){
        showError("Those two passwords don't match.");
        return;
      }

      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = await derive(password, salt, ITERATIONS);

      accounts[id] = {
        name,
        salt: toBase64(salt),
        hash,
        iterations: ITERATIONS,
        createdAt: Date.now()
      };
      writeJSON(ACCOUNTS_KEY, accounts);
      startSession(id, name);
      return;
    }

    // login
    if(!account){
      showError('No account with that name on this device. Try Sign up.');
      return;
    }

    const hash = await derive(password, fromBase64(account.salt), account.iterations || ITERATIONS);

    if(hash !== account.hash){
      const entry = recordFailure(id);
      const left = entry.until > Date.now()
        ? `Locked for ${Math.ceil(LOCKOUT_MS / 1000)} seconds.`
        : `${MAX_ATTEMPTS - entry.fails} ${MAX_ATTEMPTS - entry.fails === 1 ? 'try' : 'tries'} left.`;
      showError(`Wrong password. ${left}`);
      passwordInput.value = '';
      return;
    }

    clearFailures(id);
    startSession(id, account.name);
  }catch(err){
    showError('Something went wrong signing you in. Try again.');
  }finally{
    submitBtn.disabled = false;
    submitBtn.textContent = mode === 'signup' ? 'Sign Up' : 'Log In';
  }
});

function startSession(id, name){
  writeJSON(SESSION_KEY, { user: id, name, expiresAt: Date.now() + SESSION_MS });
  window.location.href = 'timetable.html';
}

/* ---------- boot ---------- */

// Prefill the last name used on this device.
const lastSession = readJSON(SESSION_KEY, null);
if(lastSession && lastSession.name) usernameInput.value = lastSession.name;

// First run on this device? Start on Sign up, since there's nothing to log into.
if(Object.keys(readAccounts()).length === 0){
  setMode('signup');
}else{
  setMode('login');
}
