const WEEK_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const CYCLE_DAYS = Array.from({length:10}, (_, i) => `Day ${i + 1}`);
const form = document.getElementById('classForm');
const subjectInput = document.getElementById('subject');
const dayInput = document.getElementById('day');
const startInput = document.getElementById('start');
const endInput = document.getElementById('end');
const roomInput = document.getElementById('room');
const colorPicker = document.getElementById('colorPicker');
const calendarHeaders = document.getElementById('calendarHeaders');
const calendarScroll = document.getElementById('calendarScroll');
const classDialog = document.getElementById('classDialog');
const importDialog = document.getElementById('importDialog');
const settingsDialog = document.getElementById('settingsDialog');
const eventDialog = document.getElementById('eventDialog');
const calendarSearch = document.getElementById('calendarSearch');
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
const replaceClashesBtn = document.getElementById('replaceClashesBtn');
const changeTimeBtn = document.getElementById('changeTimeBtn');
const clashError = document.getElementById('clashError');
let clashFocus = null;
let replaceClashes = null;
let replacingClashes = false;

let classes = [];
let mode = 'weekly';
let cycleStart = '';
let viewDate = new Date();
let selectedEvent = null;
let gridStart = 7 * 60;
let gridEnd = 18 * 60;
const HOUR_HEIGHT = 104;
let selectedColor = 'green';
let dayCols = {};

async function api(path, body){
  const response = await fetch(path, {
    method:'POST', headers:{'Content-Type':'application/json'},
    credentials:'same-origin', body:JSON.stringify(body)
  });
  if(!(response.headers.get('Content-Type') || '').includes('application/json')){
    throw new Error('The timetable service is unavailable. Please try again shortly.');
  }
  const data = await response.json();
  if(!response.ok){
    const error = new Error(data.error || 'Could not save your timetable.');
    error.conflicts = data.conflicts;
    error.canReplace = data.canReplace;
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
  modeSelect.disabled = false;
}

function currentDays(){ return mode === 'cycle' ? CYCLE_DAYS : WEEK_DAYS; }
function localDate(value){ return new Date(`${value}T12:00:00`); }
function dateKey(date){
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function addDays(date, offset){
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  result.setDate(result.getDate() + offset);
  return result;
}
function weekStart(date){ return addDays(date, -((date.getDay() + 6) % 7)); }
function schoolDay(date){ return date.getDay() >= 1 && date.getDay() <= 5; }
function weekdayName(date){ return WEEK_DAYS[(date.getDay() + 6) % 7]; }
function shiftSchoolDays(date, offset){
  let result = addDays(date, 0);
  const sign = Math.sign(offset);
  for(let remaining = Math.abs(offset); remaining;){
    result = addDays(result, sign);
    if(schoolDay(result)) remaining--;
  }
  return result;
}
function cycleDayFor(date){
  if(!cycleStart || !schoolDay(date)) return null;
  const anchor = localDate(cycleStart);
  if(!Number.isFinite(anchor.getTime()) || !schoolDay(anchor)) return null;
  const utcDay = value => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86400000;
  const difference = utcDay(date) - utcDay(anchor);
  const sign = Math.sign(difference);
  const wholeWeeks = Math.floor(Math.abs(difference) / 7);
  let offset = wholeWeeks * 5 * sign;
  let cursor = addDays(anchor, wholeWeeks * 7 * sign);
  for(let i = 0; i < Math.abs(difference) % 7; i++){
    cursor = addDays(cursor, sign);
    if(schoolDay(cursor)) offset += sign;
  }
  return CYCLE_DAYS[((offset % 10) + 10) % 10];
}
function singleDayView(){
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches;
}
function calendarDates(){
  if(singleDayView()){
    let date = addDays(viewDate, 0);
    if(mode === 'cycle') while(!schoolDay(date)) date = addDays(date, 1);
    return [date];
  }
  if(mode === 'weekly') return Array.from({length:7}, (_, i) => addDays(weekStart(viewDate), i));
  let start = addDays(viewDate, 0);
  while(!schoolDay(start)) start = addDays(start, 1);
  const index = CYCLE_DAYS.indexOf(cycleDayFor(start));
  start = shiftSchoolDays(start, -Math.max(index, 0));
  return Array.from({length:10}, (_, i) => shiftSchoolDays(start, i));
}
function classesForDate(date){
  const cycleDay = cycleDayFor(date);
  return classes.filter(c => c.day === weekdayName(date) || c.day === cycleDay);
}
function visibleClasses(){
  const ids = new Set(calendarDates().flatMap(date => classesForDate(date).map(c => c.id)));
  return classes.filter(c => ids.has(c.id));
}
function updateCalendarHeading(dates){
  const first = dates[0], last = dates[dates.length - 1];
  const month = date => date.toLocaleDateString('en-GB', {month:'long'});
  let title = `${month(first)} ${first.getFullYear()}`;
  if(first.getFullYear() !== last.getFullYear()) title += ` – ${month(last)} ${last.getFullYear()}`;
  else if(first.getMonth() !== last.getMonth()) title = `${month(first)} – ${month(last)} ${last.getFullYear()}`;
  document.getElementById('calendarTitle').textContent = title;
  const short = date => date.toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'});
  document.getElementById('calendarRange').textContent = singleDayView()
    ? `${weekdayName(first)}, ${short(first)}`
    : `${short(first)} – ${short(last)} · ${mode === 'cycle' ? '10 school days' : 'Week view'}`;
  document.getElementById('jumpDate').value = dateKey(viewDate);
  const period = singleDayView() ? 'day' : mode === 'cycle' ? 'cycle' : 'week';
  document.getElementById('prevWeekBtn').setAttribute('aria-label', `Previous ${period}`);
  document.getElementById('prevWeekBtn').title = `Previous ${period}`;
  document.getElementById('nextWeekBtn').setAttribute('aria-label', `Next ${period}`);
  document.getElementById('nextWeekBtn').title = `Next ${period}`;
  document.querySelector('.calendar-footnote').textContent = singleDayView()
    ? 'Swipe for another day · Tap a class for details · Tap an empty time to create'
    : 'Click a class for details · Click an empty time to create a class · Repeating classes stay on your timetable';
  const hasCycle = classes.some(c => CYCLE_DAYS.includes(c.day));
  document.getElementById('calendarContext').textContent = hasCycle
    ? '10-day school cycle · weekends skipped · cycle days shown below each date'
    : 'Your weekly classes repeat automatically. Make room for a good week.';
}
function buildDayUi(){
  dayInput.replaceChildren(new Option('Pick a day', '', true, false));
  dayInput.options[0].disabled = true;
  repeatDays.replaceChildren();
  recurrenceHelp.textContent = mode === 'cycle'
    ? 'Repeats every 10 school days on the selected cycle day.'
    : 'Repeats every week on the selected weekday.';
  currentDays().forEach(day => {
    dayInput.add(new Option(day, day));
    const label = document.createElement('label');
    label.className = 'repeat-day';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = day;
    label.append(checkbox, document.createTextNode(day));
    repeatDays.appendChild(label);
  });
  buildCalendar();
}
function buildCalendar(){
  const dates = calendarDates();
  const today = dateKey(new Date());
  const canvas = document.getElementById('calendarCanvas');
  canvas.style.setProperty('--day-count', dates.length);
  canvas.classList.toggle('cycle-canvas', mode === 'cycle');
  calendarHeaders.replaceChildren();
  weekGrid.replaceChildren();
  dayCols = {};
  const timezone = document.createElement('div');
  timezone.className = 'timezone-label';
  timezone.textContent = new Intl.DateTimeFormat('en', {timeZoneName:'shortOffset'})
    .formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value || 'Local time';
  calendarHeaders.appendChild(timezone);
  dates.forEach(date => {
    const key = dateKey(date);
    const header = document.createElement('div');
    header.className = 'calendar-day-header';
    header.classList.toggle('is-today', key === today);
    header.setAttribute('aria-label', date.toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'}));
    const fields = [
      ['header-weekday', mode === 'cycle' ? cycleDayFor(date) || 'School day' : weekdayName(date)],
      ['header-date', String(date.getDate())],
      ['header-month', date.toLocaleDateString('en-GB', {month:'short', year:'numeric'})],
      ['header-cycle', mode === 'cycle' ? weekdayName(date) : cycleDayFor(date) || (schoolDay(date) ? 'School day' : 'Weekend')]
    ];
    fields.forEach(([className, text]) => {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      header.appendChild(span);
    });
    calendarHeaders.appendChild(header);
    const col = document.createElement('div');
    col.className = 'day-col';
    col.dataset.date = key;
    col.classList.toggle('is-today', key === today);
    const list = document.createElement('div');
    list.className = 'day-col-list';
    col.appendChild(list);
    weekGrid.appendChild(col);
    dayCols[key] = {el:col, list, date};
  });
  updateCalendarHeading(dates);
}
function navigateCalendar(direction){
  viewDate = singleDayView()
    ? mode === 'cycle' ? shiftSchoolDays(calendarDates()[0], direction) : addDays(viewDate, direction)
    : addDays(viewDate, direction * (mode === 'cycle' ? 14 : 7));
  buildCalendar();
  render();
}
document.getElementById('prevWeekBtn').addEventListener('click', () => navigateCalendar(-1));
document.getElementById('nextWeekBtn').addEventListener('click', () => navigateCalendar(1));
document.getElementById('todayBtn').addEventListener('click', () => {
  viewDate = new Date();
  buildCalendar();
  render();
  scrollToSchoolStart();
});
document.getElementById('jumpDate').addEventListener('change', e => {
  const date = localDate(e.target.value);
  if(!Number.isFinite(date.getTime())) return;
  viewDate = date;
  buildCalendar();
  render();
  settingsDialog.close();
});
calendarSearch.addEventListener('input', render);
if(typeof window !== 'undefined'){
  window.matchMedia('(max-width: 760px)').addEventListener('change', () => {
    buildCalendar();
    render();
  });
}
let touchStart = null;
calendarScroll.addEventListener('touchstart', event => {
  touchStart = event.touches.length === 1 ? {x:event.touches[0].clientX, y:event.touches[0].clientY} : null;
}, {passive:true});
calendarScroll.addEventListener('touchend', event => {
  if(!singleDayView() || !touchStart || !event.changedTouches.length) return;
  const dx = event.changedTouches[0].clientX - touchStart.x;
  const dy = event.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if(Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.5) navigateCalendar(dx < 0 ? 1 : -1);
}, {passive:true});
document.querySelectorAll('[data-close]').forEach(button => {
  button.addEventListener('click', () => document.getElementById(button.dataset.close).close());
});
document.getElementById('openClassBtn').addEventListener('click', () => openClass());
document.getElementById('openImportBtn').addEventListener('click', () => importDialog.showModal());
document.getElementById('openSettingsBtn').addEventListener('click', () => settingsDialog.showModal());
function openClass(date = null, minutes = 9 * 60){
  classMessage.textContent = '';
  if(date){
    dayInput.value = mode === 'cycle' ? cycleDayFor(date) || '' : weekdayName(date);
    startInput.value = timeValue(minutes);
    endInput.value = timeValue(Math.min(minutes + 40, 1439));
    dayInput.dispatchEvent(new Event('change'));
  }
  classDialog.showModal();
  subjectInput.focus();
}

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
    BellhopSession.set(false);
    window.location.replace('login.html');
  }catch(error){ classMessage.textContent = error.message; }
});

function showClashes(error, focusTarget, onReplace){
  clashFocus = focusTarget;
  replaceClashes = error.canReplace === true ? () => onReplace(error.conflicts.map(item => item.id)) : null;
  replaceClashesBtn.hidden = !replaceClashes;
  clashError.textContent = '';
  document.getElementById('clashDescription').textContent = replaceClashes
    ? 'Replace the overlapping saved classes below, or change your new class’s time or day.'
    : 'These new classes overlap each other. Change their days or times before saving.';
  const list = document.getElementById('clashList');
  list.replaceChildren(...error.conflicts.map(item => {
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

clashDialog.addEventListener('close', () => {
  replaceClashes = null;
  clashFocus?.focus();
});
clashDialog.addEventListener('cancel', event => {
  if(replacingClashes) event.preventDefault();
});
replaceClashesBtn.addEventListener('click', async () => {
  if(!replaceClashes || replacingClashes) return;
  const replace = replaceClashes;
  replacingClashes = true;
  replaceClashesBtn.disabled = changeTimeBtn.disabled = true;
  replaceClashesBtn.textContent = 'Replacing…';
  clashError.textContent = '';
  try{ await replace(); }
  finally{
    replacingClashes = false;
    replaceClashesBtn.disabled = changeTimeBtn.disabled = false;
    replaceClashesBtn.textContent = 'Replace overlapping classes';
  }
});

async function saveWithClashChoice(path, payload, focusTarget, onSaved, errorTarget, replaceIds){
  let saved = false;
  try{
    const result = await api(path, {...payload, ...(replaceIds ? {replaceIds} : {})});
    saved = true;
    if(clashDialog.open) clashDialog.close();
    await onSaved(result);
  }catch(error){
    errorTarget.textContent = saved ? 'Your classes were saved. Refresh the page to load your updated timetable.' : error.message;
    if(!saved && error.conflicts?.length){
      showClashes(error, focusTarget, ids => saveWithClashChoice(path, payload, focusTarget, onSaved, errorTarget, ids));
    }else if(clashDialog.open){
      clashError.textContent = error.message;
    }
  }
}

modeSelect.addEventListener('change', async () => {
  const requested = modeSelect.value;
  if(requested === 'cycle' && !cycleStart){
    settingsMessage.textContent = 'Set the date of Day 1 to use the 10-day view.';
    modeSelect.value = mode;
    settingsDialog.showModal();
    cycleStartInput.focus();
    return;
  }
  modeSelect.disabled = true;
  try{
    await api('/api/settings', {mode:requested, cycleStart});
    mode = requested;
    settingsMessage.textContent = '';
    buildDayUi();
    render();
  }catch(error){
    modeSelect.value = mode;
    settingsMessage.textContent = error.message;
  }finally{ modeSelect.disabled = false; }
});

document.getElementById('cycleSettingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.getElementById('cycleSettingsMessage');
  const chosen = localDate(cycleStartInput.value);
  if(!Number.isFinite(chosen.getTime()) || !schoolDay(chosen)){
    message.textContent = 'Day 1 must be a Monday–Friday.';
    return;
  }
  const button = document.getElementById('saveCycleBtn');
  button.disabled = true;
  try{
    await api('/api/settings', {mode, cycleStart:cycleStartInput.value});
    cycleStart = cycleStartInput.value;
    message.textContent = 'Day 1 date saved.';
    settingsMessage.textContent = 'Cycle dates updated.';
    buildCalendar();
    render();
    settingsDialog.close();
  }catch(error){ message.textContent = error.message; }
  finally{ button.disabled = false; }
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
    await saveWithClashChoice('/api/classes/add', {classes:items}, startInput, async result => {
      await loadSchedule();
      form.reset();
      repeatDays.querySelectorAll('input').forEach(input => {input.disabled = false;});
      document.getElementById('repeatOptions').open = false;
      colorPicker.querySelectorAll('.swatch').forEach(button => button.classList.toggle('selected', button.dataset.color === 'green'));
      selectedColor = 'green';

      classMessage.textContent = (items.length === 1 ? 'Class added. It will repeat automatically.' : `Class added on ${items.length} days. It will repeat automatically.`)
        + (result.replaced ? ` Replaced ${result.replaced} overlapping ${result.replaced === 1 ? 'class' : 'classes'}.` : '');
      settingsMessage.textContent = classMessage.textContent;
      classDialog.close();
    }, classMessage);
  }finally{
    addClassBtn.disabled = false;
    addClassBtn.textContent = 'Add to timetable';
  }
});

document.getElementById('clearAllBtn').addEventListener('click', async () => {
  if(!classes.length) return;
  if(!confirm('Delete ALL weekly and cycle classes? This removes every repeating class and cannot be undone.')) return;
  try{
    await api('/api/classes/clear', {days:[...WEEK_DAYS, ...CYCLE_DAYS]});
    classes = [];
    buildDayUi();
    render();
    settingsDialog.close();
    settingsMessage.textContent = 'All classes cleared.';
  }catch(error){ document.getElementById('cycleSettingsMessage').textContent = error.message; }
});

weekGrid.addEventListener('click', event => {
  const card = event.target.closest('.calendar-event');
  if(card){ openEvent(card.dataset.id, card.dataset.date); return; }
  const column = event.target.closest('.day-col');
  if(!column) return;
  const col = dayCols[column.dataset.date];
  const offset = event.clientY - col.list.getBoundingClientRect().top;
  const minutes = Math.max(gridStart, Math.min(23 * 60, gridStart + Math.floor(offset / HOUR_HEIGHT * 4) * 15));
  if(mode === 'cycle' && !cycleDayFor(col.date)) return;
  openClass(col.date, minutes);
});
weekGrid.addEventListener('keydown', event => {
  if(event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('.calendar-event');
  if(card){ event.preventDefault(); openEvent(card.dataset.id, card.dataset.date); }
});
function openEvent(id, key){
  const item = classes.find(c => c.id === id);
  if(!item) return;
  selectedEvent = item;
  document.getElementById('eventTitle').textContent = item.subject;
  document.getElementById('eventRecurrence').textContent = CYCLE_DAYS.includes(item.day)
    ? `${item.day} · repeats every 10 school days` : `${item.day} · repeats weekly`;
  document.getElementById('eventDate').textContent = localDate(key).toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
  document.getElementById('eventTime').textContent = `${formatTime(item.start)} – ${formatTime(item.end)}`;
  document.getElementById('eventRoom').textContent = item.room ? `Room / location: ${item.room}` : 'No room or location added';
  document.getElementById('eventMessage').textContent = '';
  eventDialog.showModal();
}
document.getElementById('deleteEventBtn').addEventListener('click', async event => {
  if(!selectedEvent) return;
  const id = selectedEvent.id;
  event.target.disabled = true;
  try{
    await api('/api/classes/delete', {id});
    classes = classes.filter(c => c.id !== id);
    selectedEvent = null;
    eventDialog.close();
    render();
    settingsMessage.textContent = 'Repeating class deleted.';
  }catch(error){ document.getElementById('eventMessage').textContent = error.message; }
  finally{ event.target.disabled = false; }
});
function minutesFor(value){ const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; }
function timeValue(minutes){ return `${String(Math.floor(minutes / 60)).padStart(2,'0')}:${String(minutes % 60).padStart(2,'0')}`; }
function formatTime(value){
  const [hour, minute] = value.split(':').map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2,'0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}
function escapeHtml(value){
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
function renderClassItem(c, date){
  const item = document.createElement('div');
  item.className = `class-item calendar-event color-${c.color}`;
  item.dataset.id = c.id;
  item.dataset.date = dateKey(date);
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  const label = `${c.subject}, ${formatTime(c.start)} to ${formatTime(c.end)}${c.room ? ', ' + c.room : ''}`;
  item.setAttribute('aria-label', label);
  item.title = label;
  item.innerHTML = `<div class="class-info"><div class="class-subject">${escapeHtml(c.subject)}</div><div class="class-meta"><span class="class-time">${formatTime(c.start)} – ${formatTime(c.end)}</span>${c.room ? `<span class="class-room">${escapeHtml(c.room)}</span>` : ''}</div></div>`;
  return item;
}
// Assign lanes within each connected group of overlapping events.
function layoutEvents(items){
  const sorted = [...items].sort((a,b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
  const result = [];
  let group = [], groupEnd = -1, ends = [];
  const finish = () => { group.forEach(entry => {entry.lanes = ends.length; result.push(entry);}); };
  sorted.forEach(item => {
    const start = minutesFor(item.start), end = minutesFor(item.end);
    if(start >= groupEnd){ finish(); group = []; ends = []; groupEnd = -1; }
    let lane = ends.findIndex(value => value <= start);
    if(lane < 0) lane = ends.length;
    ends[lane] = end;
    group.push({item, lane, lanes:0});
    groupEnd = Math.max(groupEnd, end);
  });
  finish();
  return result;
}
function render(){
  const visible = visibleClasses();
  gridStart = Math.min(7 * 60, ...visible.map(c => Math.floor(minutesFor(c.start) / 60) * 60));
  gridEnd = Math.max(18 * 60, ...visible.map(c => Math.ceil(minutesFor(c.end) / 60) * 60));
  const height = (gridEnd - gridStart) / 60 * HOUR_HEIGHT;
  const canvas = document.getElementById('calendarCanvas');
  canvas.style.setProperty('--grid-height', `${height}px`);
  canvas.style.setProperty('--hour-height', `${HOUR_HEIGHT}px`);
  const gutter = document.getElementById('timeGutter');
  gutter.replaceChildren();
  for(let minutes = gridStart; minutes < gridEnd; minutes += 60){
    const label = document.createElement('span');
    label.className = 'time-label';
    label.style.top = `${(minutes-gridStart) / 60 * HOUR_HEIGHT}px`;
    label.textContent = formatTime(timeValue(minutes)).replace(':00', '');
    gutter.appendChild(label);
  }
  const query = calendarSearch.value.trim().toLowerCase();
  const now = new Date();
  Object.entries(dayCols).forEach(([key, col]) => {
    col.list.replaceChildren();
    const items = classesForDate(col.date).filter(c => !query || `${c.subject} ${c.room}`.toLowerCase().includes(query));
    layoutEvents(items).forEach(({item, lane, lanes}) => {
      const card = renderClassItem(item, col.date);
      card.style.top = `${(minutesFor(item.start)-gridStart) / 60 * HOUR_HEIGHT}px`;
      card.style.height = `${Math.max(22, (minutesFor(item.end)-minutesFor(item.start)) / 60 * HOUR_HEIGHT - 2)}px`;
      card.style.left = `calc(${lane / lanes * 100}% + 3px)`;
      card.style.width = `calc(${100 / lanes}% - 6px)`;
      col.list.appendChild(card);
    });
    if(!items.length){
      const empty = document.createElement('p');
      empty.className = 'day-col-empty';
      empty.textContent = query ? 'No matches' : 'No classes';
      col.list.appendChild(empty);
    }
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    if(key === dateKey(now) && minutesNow >= gridStart && minutesNow < gridEnd){
      const line = document.createElement('div');
      line.className = 'now-line';
      line.style.top = `${(minutesNow-gridStart) / 60 * HOUR_HEIGHT}px`;
      line.setAttribute('aria-label', `Current time ${formatTime(timeValue(minutesNow))}`);
      col.list.appendChild(line);
    }
  });
  renderNextUp();
}
function renderNextUp(){
  if(!classes.length){ nextUp.textContent = 'A clear calendar. Create a class or import your timetable to get started.'; return; }
  const now = new Date();
  const clock = now.toTimeString().slice(0,5);
  let next = null, nextDate = null;
  for(let offset=0; offset<22 && !next; offset++){
    const date = addDays(now, offset);
    next = classesForDate(date).filter(c => offset > 0 || c.end > clock)
      .sort((a,b) => a.start.localeCompare(b.start))[0] || null;
    if(next) nextDate = date;
  }
  if(!next){ nextUp.textContent = 'No upcoming classes found. Check your Day 1 date in settings.'; return; }
  const when = dateKey(nextDate) === dateKey(now)
    ? (next.start <= clock ? 'Now' : 'Today')
    : nextDate.toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'});
  nextUp.textContent = `${next.subject} · ${when}, ${formatTime(next.start)} – ${formatTime(next.end)}${next.room ? ' · ' + next.room : ''}`;
}
function scrollToSchoolStart(){
  const firstStart = Math.min(8 * 60, ...visibleClasses().map(c => minutesFor(c.start)));
  calendarScroll.scrollTop = Math.max(0, (firstStart - gridStart - 30) / 60 * HOUR_HEIGHT);
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
  if(!file){ pdfMessage.textContent = 'Choose a PDF, PNG or JPG first.'; return; }
  if(file.size > 5 * 1024 * 1024){ pdfMessage.textContent = 'File must be smaller than 5 MB.'; return; }
  const extension = file.name.split('.').pop().toLowerCase();
  const contentType = {pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg'}[extension];
  if(!contentType){ pdfMessage.textContent = 'Choose a PDF, PNG or JPG file.'; return; }
  const button = e.currentTarget;
  button.disabled = true;
  button.textContent = contentType === 'application/pdf' ? 'Reading PDF…' : 'Reading screenshot…';
  pdfMessage.textContent = '';
  try{
    const response = await fetch('/api/timetable/preview', {
      method:'POST', headers:{'Content-Type':contentType},
      credentials:'same-origin', body:file
    });
    if(!(response.headers.get('Content-Type') || '').includes('application/json')){
      throw new Error('The file reader is taking longer than expected. Try a smaller screenshot or try again shortly.');
    }
    const result = await response.json();
    if(!response.ok) throw new Error(result.error || 'Could not read that file.');
    previewRows.replaceChildren(...result.classes.map(makePreviewRow));
    previewSummary.textContent = `${result.classes.length} classes found across ${result.foundDays.length} of 10 days. Review each one before importing.`
      + (result.fromImage ? ' Screenshot text can be misread—double-check subjects, days and times.' : '')
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
    await saveWithClashChoice('/api/classes/import-cycle', {
      cycleStart:importDayOne.value, classes:importedClasses
    }, previewRows.querySelector('.preview-start'), async result => {
      await loadSchedule();
      previewPanel.hidden = true;
      pdfMessage.textContent = `Imported ${result.imported} classes.${result.skipped ? ` Skipped ${result.skipped} duplicates.` : ''}`
        + (result.replaced ? ` Replaced ${result.replaced} overlapping ${result.replaced === 1 ? 'class' : 'classes'}.` : '');
      pdfFile.value = '';
      settingsMessage.textContent = pdfMessage.textContent;
      importDialog.close();
      scrollToSchoolStart();
    }, previewError);
  }
  finally{ confirmImport.disabled = false; confirmImport.textContent = 'Import classes'; }
});

async function start(){
  try{
    const response = await fetch('/api/session', {credentials:'same-origin'});
    if(response.status === 401){ BellhopSession.set(false); window.location.replace('login.html'); return; }
    if(!response.ok) throw new Error('Could not load your account.');
    const session = await response.json();
    BellhopSession.set(true);
    document.getElementById('userGreet').textContent = session.name;
    await loadSchedule();
    scrollToSchoolStart();
    setInterval(() => {
      if(document.hidden) return;
      buildCalendar();
      render();
    }, 60000);
  }catch(error){ nextUp.textContent = error.message; }
}

start();
