const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const SESSION_KEY = 'timetable-session';

function readSession(){
  try{
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){
    return null;
  }
}

const session = readSession() || { user: 'guest', name: 'there' };

// Each account gets its own timetable so signing in as someone else doesn't
// show their classes.
const STORAGE_KEY = `timetable-classes:${session.user}`;

// Move any timetable saved before accounts existed onto the first account
// that signs in, so nothing is lost.
try{
  const legacy = localStorage.getItem('timetable-classes');
  if(legacy && !localStorage.getItem(STORAGE_KEY)){
    localStorage.setItem(STORAGE_KEY, legacy);
    localStorage.removeItem('timetable-classes');
  }
}catch(e){}

const form = document.getElementById('classForm');
const subjectInput = document.getElementById('subject');
const dayInput = document.getElementById('day');
const startInput = document.getElementById('start');
const endInput = document.getElementById('end');
const roomInput = document.getElementById('room');
const colorPicker = document.getElementById('colorPicker');
const dayTabs = document.getElementById('dayTabs');
const weekGrid = document.getElementById('weekGrid');
const clearAllBtn = document.getElementById('clearAllBtn');
const nextUp = document.getElementById('nextUp');
const homeBtn = document.getElementById('homeBtn');
const userGreet = document.getElementById('userGreet');
const logoutBtn = document.getElementById('logoutBtn');

homeBtn.addEventListener('click', () => {
  window.location.href = 'index.html';
});

userGreet.textContent = `Hey, ${session.name}`;

logoutBtn.addEventListener('click', () => {
  try{
    localStorage.removeItem(SESSION_KEY);
  }catch(e){}
  window.location.href = 'index.html';
});

const dayCols = {};
weekGrid.querySelectorAll('.day-col').forEach(col => {
  dayCols[col.dataset.day] = {
    el: col,
    list: col.querySelector('.day-col-list')
  };
});

let selectedColor = 'green';
let activeDay = 'Monday';

function loadClasses(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  }catch(e){
    return [];
  }
}

function saveClasses(classes){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(classes));
}

let classes = loadClasses();

colorPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('.swatch');
  if(!btn) return;
  colorPicker.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
  btn.classList.add('selected');
  selectedColor = btn.dataset.color;
});

function setActiveDay(day){
  activeDay = day;
  dayTabs.querySelectorAll('.day-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.day === day);
  });
  Object.entries(dayCols).forEach(([d, col]) => {
    col.el.classList.toggle('active', d === day);
  });
}

dayTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.day-tab');
  if(!btn) return;
  setActiveDay(btn.dataset.day);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();

  const subject = subjectInput.value.trim();
  const day = dayInput.value;
  const start = startInput.value;
  const end = endInput.value;
  const room = roomInput.value.trim();

  if(!subject || !day || !start || !end) return;

  if(end <= start){
    alert('End time must be after start time.');
    return;
  }

  classes.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    subject, day, start, end, room, color: selectedColor
  });

  saveClasses(classes);
  form.reset();
  colorPicker.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
  colorPicker.querySelector(`[data-color="${selectedColor}"]`).classList.add('selected');

  setActiveDay(day);
  render();
});

clearAllBtn.addEventListener('click', () => {
  if(classes.length === 0) return;
  if(confirm('Clear your entire timetable? This cannot be undone.')){
    classes = [];
    saveClasses(classes);
    render();
  }
});

weekGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.class-delete');
  if(!btn) return;
  const id = btn.dataset.id;
  classes = classes.filter(c => c.id !== id);
  saveClasses(classes);
  render();
});

function formatTime(t){
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2,'0')} ${period}`;
}

function renderClassItem(c, { deletable = true } = {}){
  const item = document.createElement('div');
  item.className = `class-item color-${c.color}`;
  item.innerHTML = `
    <div class="class-info">
      <div class="class-subject">${escapeHtml(c.subject)}</div>
      <div class="class-meta">
        <span class="class-time">${formatTime(c.start)} – ${formatTime(c.end)}</span>
        ${c.room ? `<span>📍 ${escapeHtml(c.room)}</span>` : ''}
        ${deletable ? '' : `<span>${c.day}</span>`}
      </div>
    </div>
    ${deletable ? `<button class="class-delete" data-id="${c.id}" aria-label="Delete class">✕</button>` : ''}
  `;
  return item;
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function todayName(){
  const now = new Date();
  return DAYS[(now.getDay() + 6) % 7];
}

function render(){
  const today = todayName();

  DAYS.forEach(day => {
    const col = dayCols[day];
    col.el.classList.toggle('is-today', day === today);

    const dayClasses = classes
      .filter(c => c.day === day)
      .sort((a,b) => a.start.localeCompare(b.start));

    col.list.innerHTML = '';
    if(dayClasses.length === 0){
      const empty = document.createElement('p');
      empty.className = 'day-col-empty';
      empty.textContent = 'No classes';
      col.list.appendChild(empty);
    }else{
      dayClasses.forEach(c => col.list.appendChild(renderClassItem(c)));
    }
  });

  renderNextUp();
}

function renderNextUp(){
  if(classes.length === 0){
    nextUp.innerHTML = '<p class="empty-state">Add some classes to see what\'s next.</p>';
    return;
  }

  const now = new Date();
  const nowDay = todayName();
  const nowTime = now.toTimeString().slice(0,5);

  const dayIndex = (day) => DAYS.indexOf(day);
  const currentDayIndex = dayIndex(nowDay);

  const upcoming = classes
    .map(c => {
      let diff = dayIndex(c.day) - currentDayIndex;
      if(diff < 0) diff += 7;
      if(diff === 0 && c.start <= nowTime) diff += 7;
      return { c, diff };
    })
    .sort((a,b) => {
      if(a.diff !== b.diff) return a.diff - b.diff;
      return a.c.start.localeCompare(b.c.start);
    });

  const next = upcoming[0];
  nextUp.innerHTML = '';
  if(next){
    const item = renderClassItem(next.c, { deletable:false });
    nextUp.appendChild(item);
  }
}

setActiveDay(todayName());
render();
