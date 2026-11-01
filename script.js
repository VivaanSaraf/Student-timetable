const WEEK_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const CYCLE_DAYS = Array.from({length:10}, (_, i) => `Day ${i + 1}`);
const form = document.getElementById('classForm');
const subjectInput = document.getElementById('subject');
const dayInput = document.getElementById('day');
const startInput = document.getElementById('start');
const endInput = document.getElementById('end');
const roomInput = document.getElementById('room');
const colorPicker = document.getElementById('colorPicker');
const dayTabs = document.getElementById('dayTabs');
const weekGrid = document.getElementById('weekGrid');
const nextUp = document.getElementById('nextUp');
const modeSelect = document.getElementById('scheduleMode');
const cycleStartInput = document.getElementById('cycleStart');
const settingsMessage = document.getElementById('settingsMessage');
const pdfFile = document.getElementById('pdfFile');
const pdfMessage = document.getElementById('pdfMessage');
const previewPanel = document.getElementById('importPreview');
const previewRows = document.getElementById('previewRows');
const previewSummary = document.getElementById('previewSummary');
const previewError = document.getElementById('previewError');
const importDayOne = document.getElementById('importDayOne');
const confirmImport = document.getElementById('confirmImport');
const repeatDays = document.getElementById('repeatDays');
const recurrenceHelp = document.getElementById('recurrenceHelp');
const classMessage = document.getElementById('classMessage');
const addClassBtn = document.getElementById('addClassBtn');
const clashDialog = document.getElementById('clashDialog');
let clashFocus = null;

let classes = [];
let mode = 'weekly';
let cycleStart = '';
let activeDay = 'Monday';
let selectedColor = 'green';
let dayCols = {};

async function api(path, body){
  const response = await fetch(path, {
    method:'POST', headers:{'Content-Type':'application/json'},
    credentials:'same-origin', body:JSON.stringify(body)
  });
  const data = await response.json();
  if(!response.ok){
    const error = new Error(data.error || 'Could not save your timetable.');
    error.conflicts = data.conflicts;
    throw error;
  }
  return data;
}

async function loadSchedule(){
  const response = await fetch('/api/classes', {credentials:'same-origin'});
  if(!response.ok) throw new Error('Could not load your timetable.');
  const data = await response.json();
  classes = data.classes;
  mode = data.mode || 'weekly';
  cycleStart = data.cycleStart || '';
  modeSelect.value = mode;
  cycleStartInput.value = cycleStart;
  buildDayUi();
  render();
}

function currentDays(){ return mode === 'cycle' ? CYCLE_DAYS : WEEK_DAYS; }
function visibleClasses(){ return classes.filter(c => currentDays().includes(c.day)); }
function localDate(value){ return new Date(`${value}T12:00:00`); }
function schoolDay(date){ return date.getDay() >= 1 && date.getDay() <= 5; }

function cycleDayFor(date){
  if(!cycleStart || !schoolDay(date)) return null;
  const anchor = localDate(cycleStart);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  const sign = target >= anchor ? 1 : -1;
  let offset = 0;
  const cursor = new Date(anchor);
  while(cursor.getTime() !== target.getTime()){
    cursor.setDate(cursor.getDate() + sign);
    if(schoolDay(cursor)) offset += sign;
  }
  return CYCLE_DAYS[((offset % 10) + 10) % 10];
}

function todayName(){
  const now = new Date();
  return WEEK_DAYS[(now.getDay() + 6) % 7];
}

function currentDay(){
  if(mode === 'weekly') return todayName();
  const date = new Date();
  for(let i=0; i<7 && !schoolDay(date); i++) date.setDate(date.getDate()+1);
  return cycleDayFor(date) || CYCLE_DAYS[0];
}

function buildDayUi(){
  const days = currentDays();
  dayTabs.replaceChildren();
  weekGrid.replaceChildren();
  dayCols = {};
  weekGrid.classList.toggle('cycle-grid', mode === 'cycle');
  dayInput.replaceChildren(new Option('Pick a day', '', true, false));
  dayInput.options[0].disabled = true;
  repeatDays.replaceChildren();
  recurrenceHelp.textContent = mode === 'cycle'
    ? 'Every class repeats after 10 school days. Add it once and it stays on your timetable.'
    : 'Every class repeats each week. Add it once and it stays on your timetable.';
  days.forEach(day => {
    dayInput.add(new Option(day, day));
    const repeatLabel = document.createElement('label');
    repeatLabel.className = 'repeat-day';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = day;
    repeatLabel.append(checkbox, document.createTextNode(day));
    repeatDays.appendChild(repeatLabel);
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'day-tab';
    tab.dataset.day = day;
    tab.textContent = mode === 'weekly' ? day.slice(0,3) : day;
    dayTabs.appendChild(tab);

    const col = document.createElement('div');
    col.className = 'day-col';
    col.dataset.day = day;
    const title = document.createElement('h3');
    title.className = 'day-col-head';
    title.textContent = day;
    const list = document.createElement('div');
    list.className = 'day-col-list';
    col.append(title, list);
    weekGrid.appendChild(col);
    dayCols[day] = {el:col, list};
  });
  setActiveDay(days.includes(activeDay) ? activeDay : currentDay());
}

function setActiveDay(day){
  activeDay = day;
  dayTabs.querySelectorAll('.day-tab').forEach(t => t.classList.toggle('active', t.dataset.day === day));
  Object.entries(dayCols).forEach(([name, col]) => col.el.classList.toggle('active', name === day));
}

dayTabs.addEventListener('click', e => {
  const tab = e.target.closest('.day-tab');
  if(tab) setActiveDay(tab.dataset.day);
});

dayInput.addEventListener('change', () => {
  repeatDays.querySelectorAll('input').forEach(input => {
    input.disabled = input.value === dayInput.value;
    if(input.disabled) input.checked = false;
  });
});

document.getElementById('homeBtn').addEventListener('click', () => {
  window.location.href = 'index.html';
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try{
    await api('/api/logout', {});
    window.location.replace('login.html');
  }catch(error){ classMessage.textContent = error.message; }
});

function showClashes(conflicts, focusTarget){
  clashFocus = focusTarget;
  const list = document.getElementById('clashList');
  list.replaceChildren(...conflicts.map(item => {
    const li = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = item.subject;
    const detail = document.createElement('div');
    detail.textContent = `${item.day} · ${formatTime(item.start)} – ${formatTime(item.end)}`;
    li.append(name, detail);
    return li;
  }));
  if(!clashDialog.open) clashDialog.showModal();
}

clashDialog.addEventListener('close', () => clashFocus?.focus());

modeSelect.addEventListener('change', async () => {
  const requested = modeSelect.value;
  if(requested === 'cycle' && !cycleStartInput.value){
    settingsMessage.textContent = 'Set the date of Day 1 first.';
    modeSelect.value = mode;
    cycleStartInput.focus();
    return;
  }
  try{
    await api('/api/settings', {mode:requested, cycleStart:cycleStartInput.value});
    mode = requested;
    cycleStart = cycleStartInput.value;
    settingsMessage.textContent = '';
    activeDay = currentDay();
    buildDayUi();
    render();
  }catch(error){
    modeSelect.value = mode;
    settingsMessage.textContent = error.message;
  }
});

cycleStartInput.addEventListener('change', async () => {
  if(!cycleStartInput.value) return;
  try{
    await api('/api/settings', {mode:'cycle', cycleStart:cycleStartInput.value});
    mode = 'cycle';
    cycleStart = cycleStartInput.value;
    modeSelect.value = mode;
    settingsMessage.textContent = '';
    activeDay = currentDay();
    buildDayUi();
    render();
  }catch(error){
    cycleStartInput.value = cycleStart;
    settingsMessage.textContent = error.message;
  }
});

colorPicker.addEventListener('click', e => {
  const btn = e.target.closest('.swatch');
  if(!btn) return;
  colorPicker.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
  btn.classList.add('selected');
  selectedColor = btn.dataset.color;
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const item = {
    id: crypto.randomUUID(), subject:subjectInput.value.trim(), day:dayInput.value,
    start:startInput.value, end:endInput.value, room:roomInput.value.trim(), color:selectedColor
  };
  classMessage.textContent = '';
  if(!item.subject || item.end <= item.start){ classMessage.textContent = 'Enter a subject and an end time after the start.'; return; }
  const days = [...new Set([item.day, ...[...repeatDays.querySelectorAll('input:checked')].map(input => input.value)])];
  const items = days.map(day => ({...item, id:crypto.randomUUID(), day}));
  addClassBtn.disabled = true;
  addClassBtn.textContent = 'Saving…';
  try{
    await api('/api/classes/add', {classes:items});
    await loadSchedule();
    form.reset();
    repeatDays.querySelectorAll('input').forEach(input => {input.disabled = false;});
    document.getElementById('repeatOptions').open = false;
    colorPicker.querySelectorAll('.swatch').forEach(button => button.classList.toggle('selected', button.dataset.color === 'green'));
    selectedColor = 'green';
    setActiveDay(item.day);
    classMessage.textContent = items.length === 1 ? 'Class added. It will repeat automatically.' : `Class added on ${items.length} days. It will repeat automatically.`;
  }catch(error){
    if(error.conflicts?.length) showClashes(error.conflicts, startInput);
    else classMessage.textContent = error.message;
  }finally{
    addClassBtn.disabled = false;
    addClassBtn.textContent = 'Add to timetable';
  }
});

document.getElementById('clearAllBtn').addEventListener('click', async () => {
  if(!visibleClasses().length) return;
  if(!confirm('Clear all classes in this timetable? This cannot be undone.')) return;
  try{
    await api('/api/classes/clear', {});
    classes = classes.filter(c => !currentDays().includes(c.day));
    render();
  }catch(error){ alert(error.message); }
});

weekGrid.addEventListener('click', async e => {
  const btn = e.target.closest('.class-delete');
  if(!btn) return;
  try{
    await api('/api/classes/delete', {id:btn.dataset.id});
    classes = classes.filter(c => c.id !== btn.dataset.id);
    render();
  }catch(error){ alert(error.message); }
});

function formatTime(value){
  const [hour, minute] = value.split(':').map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2,'0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}
function escapeHtml(value){
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
function renderClassItem(c, deletable=true){
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
    ${deletable ? `<button type="button" class="class-delete" data-id="${c.id}" aria-label="Delete class">✕</button>` : ''}`;
  return item;
}

function render(){
  const today = mode === 'weekly' ? todayName() : cycleDayFor(new Date());
  currentDays().forEach(day => {
    const col = dayCols[day];
    col.el.classList.toggle('is-today', day === today);
    const items = classes.filter(c => c.day === day).sort((a,b) => a.start.localeCompare(b.start));
    col.list.replaceChildren();
    if(items.length) items.forEach(item => col.list.appendChild(renderClassItem(item)));
    else {
      const empty = document.createElement('p');
      empty.className = 'day-col-empty';
      empty.textContent = 'No classes';
      col.list.appendChild(empty);
    }
  });
  renderNextUp();
}

function renderNextUp(){
  const items = visibleClasses();
  if(!items.length){ nextUp.textContent = 'Add some classes to see what\'s next.'; return; }
  const now = new Date();
  const clock = now.toTimeString().slice(0,5);
  let next = null;
  if(mode === 'cycle'){
    for(let offset=0; offset<22 && !next; offset++){
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
      date.setDate(date.getDate()+offset);
      const day = cycleDayFor(date);
      if(!day) continue;
      next = items.filter(c => c.day === day && (offset > 0 || c.start > clock))
        .sort((a,b) => a.start.localeCompare(b.start))[0] || null;
    }
  }else{
    const todayIndex = WEEK_DAYS.indexOf(todayName());
    next = items.map(c => {
      let distance = (WEEK_DAYS.indexOf(c.day) - todayIndex + 7) % 7;
      if(distance === 0 && c.start <= clock) distance = 7;
      return {c, distance};
    }).sort((a,b) => a.distance - b.distance || a.c.start.localeCompare(b.c.start))[0]?.c;
  }
  nextUp.replaceChildren();
  if(next) nextUp.appendChild(renderClassItem(next, false));
  else nextUp.textContent = 'No upcoming classes found.';
}

function makePreviewRow(item){
  const row = document.createElement('div');
  row.className = 'preview-row';
  row.dataset.id = item.id || crypto.randomUUID();
  const fields = [
    ['Day', 'select', 'day', item.day || 'Day 1'],
    ['Subject', 'text', 'subject', item.subject || ''],
    ['Start', 'time', 'start', item.start || '09:00'],
    ['End', 'time', 'end', item.end || '10:00'],
    ['Room', 'text', 'room', item.room || '']
  ];
  fields.forEach(([labelText, type, key, value]) => {
    const label = document.createElement('label');
    label.className = 'field';
    label.textContent = labelText;
    let control;
    if(type === 'select'){
      control = document.createElement('select');
      CYCLE_DAYS.forEach(day => control.add(new Option(day, day)));
    }else{
      control = document.createElement('input');
      control.type = type;
      if(key === 'subject') control.maxLength = 80;
      if(key === 'room') control.maxLength = 40;
    }
    control.className = `preview-${key}`;
    control.value = value;
    if(key !== 'room') control.required = true;
    label.appendChild(control);
    row.appendChild(label);
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-ghost preview-remove';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', 'Remove this class from the import');
  row.appendChild(remove);
  return row;
}

previewRows.addEventListener('click', e => {
  if(e.target.closest('.preview-remove')) e.target.closest('.preview-row').remove();
});

document.getElementById('addPreviewRow').addEventListener('click', () => {
  const row = makePreviewRow({day:'Day 1'});
  previewRows.appendChild(row);
  row.querySelector('.preview-subject').focus();
});

document.getElementById('cancelImport').addEventListener('click', () => {
  previewPanel.hidden = true;
  previewRows.replaceChildren();
  pdfMessage.textContent = '';
});

document.getElementById('previewPdfBtn').addEventListener('click', async e => {
  const file = pdfFile.files[0];
  if(!file){ pdfMessage.textContent = 'Choose a PDF first.'; return; }
  if(file.size > 5 * 1024 * 1024){ pdfMessage.textContent = 'PDF must be smaller than 5 MB.'; return; }
  const button = e.currentTarget;
  button.disabled = true;
  button.textContent = 'Reading PDF…';
  pdfMessage.textContent = '';
  try{
    const response = await fetch('/api/pdf/preview', {
      method:'POST', headers:{'Content-Type':'application/pdf'},
      credentials:'same-origin', body:file
    });
    const result = await response.json();
    if(!response.ok) throw new Error(result.error || 'Could not read that PDF.');
    previewRows.replaceChildren(...result.classes.map(makePreviewRow));
    previewSummary.textContent = `${result.classes.length} classes found across ${result.foundDays.length} of 10 days. Review each one before importing.`
      + (result.truncated ? ' Only the first 200 are shown.' : '');
    previewError.textContent = '';
    importDayOne.value = cycleStart || result.suggestedDayOne || '';
    previewPanel.hidden = false;
    previewPanel.scrollIntoView({behavior:'smooth', block:'start'});
  }catch(error){ pdfMessage.textContent = error.message; }
  finally{ button.disabled = false; button.textContent = 'Preview classes'; }
});

document.getElementById('importForm').addEventListener('submit', async e => {
  e.preventDefault();
  const rows = [...previewRows.querySelectorAll('.preview-row')];
  if(!rows.length){ previewError.textContent = 'Add at least one class.'; return; }
  const chosen = localDate(importDayOne.value);
  if(!schoolDay(chosen)){
    previewError.textContent = 'Day 1 must be a Monday–Friday.';
    return;
  }
  const importedClasses = rows.map(row => ({
    id:row.dataset.id,
    day:row.querySelector('.preview-day').value,
    subject:row.querySelector('.preview-subject').value.trim(),
    start:row.querySelector('.preview-start').value,
    end:row.querySelector('.preview-end').value,
    room:row.querySelector('.preview-room').value.trim(),
    color:'green'
  }));
  if(importedClasses.some(c => !c.subject || !c.start || !c.end || c.end <= c.start)){
    previewError.textContent = 'Check that every class has a subject and valid start/end time.';
    return;
  }
  confirmImport.disabled = true;
  confirmImport.textContent = 'Importing…';
  try{
    const result = await api('/api/classes/import-cycle', {
      cycleStart:importDayOne.value, classes:importedClasses
    });
    await loadSchedule();
    activeDay = currentDay();
    setActiveDay(activeDay);
    previewPanel.hidden = true;
    pdfMessage.textContent = `Imported ${result.imported} classes.${result.skipped ? ` Skipped ${result.skipped} duplicates.` : ''}`;
    pdfFile.value = '';
  }catch(error){
    previewError.textContent = error.message;
    if(error.conflicts?.length) showClashes(error.conflicts, previewRows.querySelector('.preview-start'));
  }
  finally{ confirmImport.disabled = false; confirmImport.textContent = 'Import classes'; }
});

async function start(){
  try{
    const response = await fetch('/api/session', {credentials:'same-origin'});
    if(response.status === 401){ window.location.replace('login.html'); return; }
    if(!response.ok) throw new Error('Could not load your account.');
    const session = await response.json();
    document.getElementById('userGreet').textContent = `Hey, ${session.name}`;
    await loadSchedule();
  }catch(error){ nextUp.textContent = error.message; }
}

start();
