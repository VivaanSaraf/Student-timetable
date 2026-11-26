// Run with: node test_school_calendar_frontend.mjs
// Exercise the real calendar code with a small DOM implementation.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag = 'div'){
    this.tagName = tag.toUpperCase();
    this.value = '';
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.properties = {};
    this.style = {setProperty:(name, value) => { this.properties[name] = value; }};
    this.classList = {toggle(){}, add(){}, remove(){}, contains(){ return false; }};
    this.scrollTop = 0;
    this.clientHeight = 600;
    this.clientWidth = 1200;
  }
  get textContent(){ return (this.text || '') + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(value){ this.text = String(value); this.children = []; this.markup = undefined; }
  get innerHTML(){ return this.markup ?? this.textContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
  set innerHTML(value){ this.markup = value; this.text = ''; this.children = []; }
  get options(){ return this.children; }
  add(child){ this.children.push(child); }
  append(...children){ this.children.push(...children); }
  appendChild(child){ this.children.push(child); return child; }
  replaceChildren(...children){ this.children = children; this.text = ''; this.markup = undefined; }
  setAttribute(name, value){ this.attributes[name] = value; }
  removeAttribute(name){ delete this.attributes[name]; delete this[name]; }
  getAttribute(name){ return this.attributes[name] ?? null; }
  querySelectorAll(){ return []; }
  querySelector(){ return new Element(); }
  addEventListener(name, callback){ (this.listeners[name] ||= []).push(callback); }
  fire(name, properties = {}){ return Promise.all((this.listeners[name] || []).map(callback => callback({target:this, preventDefault(){}, ...properties}))); }
  focus(){}
  scrollIntoView(){}
  showModal(){ this.open = true; }
  close(){ this.open = false; }
}
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args){ super(...(args.length ? args : [2026, 10, 3, 8])); }
  static now(){ return new RealDate(2026, 10, 3, 8).getTime(); }
}
const elements = new Map();
const element = id => {
  if(!elements.has(id)) elements.set(id, new Element());
  return elements.get(id);
};
const narrowScreen = {matches:false, listeners:[], addEventListener(name, callback){
  if(name === 'change') this.listeners.push(callback);
}};
const context = vm.createContext({
  Date:FrozenDate,
  Intl,
  URL,
  document:{getElementById:element, createElement:tag => new Element(tag), createTextNode:text => text,
    querySelector:selector => element(selector), querySelectorAll:() => [], addEventListener(){}},
  window:{location:{}, addEventListener(){}, innerWidth:1200, matchMedia:() => narrowScreen},
  Option:function(text, value){ const option = new Element('option'); option.textContent = text; option.value = value; return option; },
  setInterval(){}, clearInterval(){}, setTimeout:callback => callback(), requestAnimationFrame:callback => callback(),
  console,
});
const source = readFileSync(new URL('./script.js', import.meta.url), 'utf8');
vm.runInContext(source.replace(/start\(\);\s*$/, ''), context);
const run = code => vm.runInContext(code, context);
const plain = code => JSON.parse(run(`JSON.stringify(${code})`));
const dates = () => plain('calendarDates().map(dateKey)');
const headerField = className => element('calendarHeaders').children.slice(1)
  .map(header => header.children.find(child => child.className === className)?.textContent);


run(`
  classes = CYCLE_DAYS.map((day, i) => ({
    id:String(i + 1), day, subject:'Subject ' + (i + 1),
    start:'09:00', end:'10:00', room:'Room 100', color:'green'
  }));
  cycleStart = '2026-10-26';
  mode = 'weekly';
  viewDate = localDate('2026-11-03');
  setSchoolCalendarState({connected:true,lastSynced:1793664000,error:null,timezone:'Asia/Kolkata',source:'School calendar',events:[
    {id:'assignment', title:'Science assignment', start:'2026-11-02', end:'2026-11-03', noSchool:false, reason:''},
    {id:'holiday', title:'Diwali Holiday', start:'2026-11-03', end:'2026-11-04', noSchool:true, reason:'Holiday'},
    {id:'ptm', title:'SPTM (MYP)', start:'2026-11-04', end:'2026-11-05', noSchool:true, reason:'Parent teacher meeting'},
    {id:'pd', title:'PD Day', start:'2026-11-05', end:'2026-11-06', noSchool:true, reason:'Professional development'},
    {id:'break', title:'School break', start:'2026-11-09', end:'2026-11-12', noSchool:true, reason:'Holiday'}
  ]});
  buildDayUi();
  render();
`);

// Holidays hide classes for their actual dates without shifting the cycle.
assert.equal(run("cycleDayFor(localDate('2026-11-02'))"), 'Day 6');
assert.equal(run("cycleDayFor(localDate('2026-11-03'))"), 'Day 7');
assert.equal(run("cycleDayFor(localDate('2026-11-04'))"), 'Day 8');
assert.equal(run("cycleDayFor(localDate('2026-11-05'))"), 'Day 9');
assert.equal(run("cycleDayFor(localDate('2026-11-06'))"), 'Day 10');
for(const key of ['2026-11-03','2026-11-04','2026-11-05']){
  assert.equal(run(`classesForDate(localDate('${key}')).length`), 0);
  assert.equal(run(`noSchoolEventsForDate(localDate('${key}')).length`), 1);
  assert.match(run(`dayCols['${key}'].list.textContent`), /no school|day off|holiday/i);
}
assert.deepEqual(plain("classesForDate(localDate('2026-11-06')).map(c => [c.id,c.day])"), [['10','Day 10']]);
assert.equal(run('classes.length'), 10);
assert.deepEqual(plain('classes.map(c => c.day)'), Array.from({length:10}, (_, i) => `Day ${i + 1}`));

// An ordinary assignment remains a school event and does not suppress classes.
assert.equal(run("schoolEventsForDate(localDate('2026-11-02')).length"), 1);
assert.equal(run("noSchoolEventsForDate(localDate('2026-11-02')).length"), 0);
assert.deepEqual(plain("classesForDate(localDate('2026-11-02')).map(c => c.id)"), ['6']);
assert.match(element('schoolEventBar').textContent, /Diwali Holiday/);
assert.match(element('schoolEventBar').textContent, /SPTM/);
assert.match(element('schoolEventBar').textContent, /PD Day/);

// School calendar entries open read-only details; class details retain delete.
const holidayBadge = element('schoolEventBar').children
  .flatMap(cell => cell.children).find(badge => badge.dataset?.schoolId === 'holiday');
assert.ok(holidayBadge);
await element('schoolEventBar').fire('click', {target:{closest:() => holidayBadge}});
assert.equal(element('deleteEventBtn').hidden, true);
assert.equal(run('selectedEvent'), null);
assert.equal(element('eventTitle').textContent, 'Diwali Holiday');
assert.match(element('eventTime').textContent, /No school for students/);
assert.match(element('eventDialogHint').textContent, /skips complete Monday–Friday holiday weeks; holidays in partial weeks still count/);
run("eventDialog.close(); openEvent('6', '2026-11-02');");
assert.equal(element('deleteEventBtn').hidden, false);
assert.equal(run('selectedEvent.id'), '6');
run('eventDialog.close();');

// DTEND is exclusive, including a break spanning several school days.
for(const key of ['2026-11-09','2026-11-10','2026-11-11']){
  assert.equal(run(`classesForDate(localDate('${key}')).length`), 0);
  assert.equal(run(`noSchoolEventsForDate(localDate('${key}')).length`), 1);
}
assert.equal(run("noSchoolEventsForDate(localDate('2026-11-12')).length"), 0);
assert.equal(run("classesForDate(localDate('2026-11-12')).length"), 1);

// Upcoming classes skip each holiday and still use the real cycle weekday.
assert.match(element('nextUp').textContent, /Subject 10/);
assert.match(element('nextUp').textContent, /6 Nov/);
run("viewDate = localDate('2026-12-30'); buildCalendar(); render();");
assert.match(element('nextUp').textContent, /Subject 10/);

// A long school break still finds the next real class beyond the old 22-day lookahead.
run("setSchoolCalendarState({connected:true,events:[{id:'long-break',title:'Winter vacation',start:'2026-11-03',end:'2026-12-15',noSchool:true}],lastSynced:1793664000,error:null}); renderNextUp();");
assert.match(element('nextUp').textContent, /15 Dec/);
assert.match(element('nextUp').textContent, /Subject 2/);
assert.equal(run("cycleDayFor(localDate('2026-12-15'))"), 'Day 2');

function setBreaks(events){
  run(`setSchoolCalendarState({connected:true,events:${JSON.stringify(events)},lastSynced:1793664000,error:null});`);
}
const breakEvent = (start, end, extra = {}) => ({
  id:start, title:'School holiday', start, end, noSchool:true, ...extra
});

// Exactly five weekdays qualify, even when DTEND is Saturday rather than Monday.
setBreaks([breakEvent('2026-11-09', '2026-11-14')]);
assert.equal(run("cycleDayFor(localDate('2026-11-06'))"), 'Day 10');
assert.equal(run("cycleDayFor(localDate('2026-11-16'))"), 'Day 1');
assert.deepEqual(plain("classesForDate(localDate('2026-11-16')).map(c => c.id)"), ['1']);
assert.equal(run("classesForDate(localDate('2026-11-13')).length"), 0);
assert.equal(run("cycleDayFor(localDate('2026-11-20'))"), 'Day 5');

// The cycle grid and both arrows use the adjusted dates across a paused week.
run("mode = 'cycle'; viewDate = localDate('2026-11-19'); buildCalendar(); render();");
assert.deepEqual(dates(), ['2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20',
  '2026-11-23','2026-11-24','2026-11-25','2026-11-26','2026-11-27']);
assert.deepEqual(headerField('header-weekday'), Array.from({length:10}, (_, i) => `Day ${i + 1}`));
run('navigateCalendar(-1);');
assert.equal(dates()[0], '2026-10-26');
assert.equal(dates()[9], '2026-11-06');
run('navigateCalendar(1);');
assert.equal(dates()[0], '2026-11-16');
run("viewDate = localDate('2026-11-11'); buildCalendar();");
assert.equal(dates()[0], '2026-11-16');
run("mode = 'weekly'; viewDate = localDate('2026-11-11'); buildCalendar(); render();");
assert.ok(dates().includes('2026-11-11'));
assert.match(run("dayCols['2026-11-11'].list.textContent"), /No school/);

// Four weekdays still count, including a weekend between days off.
for(const [start, end, resumed, expected] of [
  ['2026-11-09', '2026-11-13', '2026-11-13', 'Day 5'],
  ['2026-11-05', '2026-11-11', '2026-11-11', 'Day 3']
]){
  setBreaks([breakEvent(start, end)]);
  assert.equal(run(`cycleDayFor(localDate('${resumed}'))`), expected);
  assert.equal(run('cycleBreaks.length'), 0);
}

// Daily events, duplicates and overlaps count each day only once.
setBreaks([
  ...[9,10,11,12,13].map(day => breakEvent(`2026-11-${day}`, `2026-11-${day + 1}`)),
  breakEvent('2026-11-10', '2026-11-13'),
  breakEvent('2026-11-09', '2026-11-14'),
  breakEvent('2026-11-16', '2026-11-21', {noSchool:false, title:'Assignments'})
]);
assert.equal(run('cycleBreaks.length'), 1);
assert.equal(run("cycleDayFor(localDate('2026-11-16'))"), 'Day 1');
assert.equal(run("cycleDayFor(localDate('2026-11-23'))"), 'Day 6');

// Five consecutive days off across partial weeks do not pause a calendar week.
setBreaks([breakEvent('2026-11-06', '2026-11-07'), breakEvent('2026-11-09', '2026-11-13')]);
assert.equal(run('cycleBreaks.length'), 0);
assert.equal(run("cycleDayFor(localDate('2026-11-13'))"), 'Day 5');
setBreaks([breakEvent('2026-11-04', '2026-11-11')]);
assert.equal(run('cycleBreaks.length'), 0);
assert.equal(run("cycleDayFor(localDate('2026-11-11'))"), 'Day 3');
run("mode = 'cycle'; viewDate = localDate('2026-11-12'); buildCalendar();");
assert.deepEqual(headerField('header-weekday'), Array.from({length:10}, (_, i) => `Day ${i + 1}`));
assert.ok(dates().includes('2026-11-11'));
assert.equal(dates()[0], '2026-11-09');

// A school day between two short holidays prevents them becoming a long break.
setBreaks([breakEvent('2026-11-09', '2026-11-11'), breakEvent('2026-11-12', '2026-11-17')]);
assert.equal(run('cycleBreaks.length'), 0);
assert.equal(run("cycleDayFor(localDate('2026-11-17'))"), 'Day 7');

// Longer breaks skip their full weeks, with the trailing partial weeks counted.
setBreaks([breakEvent('2026-11-09', '2026-11-24'), breakEvent('2026-11-30', '2026-12-05')]);
assert.equal(run("cycleDayFor(localDate('2026-11-24'))"), 'Day 2');
assert.equal(run("cycleDayFor(localDate('2026-12-07'))"), 'Day 6');

// Observed in Toddle: March 19 Day 10, spring break March 22–26, March 29 Day 1.
run("cycleStart = '2027-03-08';");
setBreaks([breakEvent('2027-03-22', '2027-03-27'), breakEvent('2027-04-07', '2027-04-08')]);
for(const [date, expected] of [
  ['2027-03-15','Day 6'], ['2027-03-19','Day 10'],
  ['2027-03-29','Day 1'], ['2027-04-02','Day 5'],
  ['2027-04-05','Day 6'], ['2027-04-08','Day 9'], ['2027-04-09','Day 10']
]) assert.equal(run(`cycleDayFor(localDate('${date}'))`), expected);
assert.equal(run("classesForDate(localDate('2027-03-22')).length"), 0);

// Starting on Wednesday Day 8 must not turn the returning Monday into Day 8/9.
setBreaks([breakEvent('2027-03-17', '2027-03-29')]);
assert.equal(run("cycleDayFor(localDate('2027-03-16'))"), 'Day 7');
assert.equal(run("cycleDayFor(localDate('2027-03-29'))"), 'Day 1');
assert.deepEqual(plain("classesForDate(localDate('2027-03-29')).map(c => c.id)"), ['1']);
assert.equal(run("cycleDayFor(localDate('2027-04-05'))"), 'Day 6');
run("mode = 'cycle'; viewDate = localDate('2027-03-29'); buildCalendar();");
assert.deepEqual(headerField('header-weekday'), Array.from({length:10}, (_, i) => `Day ${i + 1}`));
assert.deepEqual(headerField('header-cycle'), ['Monday','Tuesday','Wednesday','Thursday','Friday',
  'Monday','Tuesday','Wednesday','Thursday','Friday']);

// A break ending midweek must also preserve the weekday and cycle-day pairing.
setBreaks([breakEvent('2027-03-17', '2027-03-31')]);
assert.equal(run("cycleDayFor(localDate('2027-03-31'))"), 'Day 3');

// An anchor after a holiday still resolves earlier dates correctly.
setBreaks([breakEvent('2026-11-09', '2026-11-14')]);
run("cycleStart = '2026-11-16';");
assert.equal(run("cycleDayFor(localDate('2026-11-06'))"), 'Day 10');
assert.equal(run("cycleDayFor(localDate('2026-11-16'))"), 'Day 1');
run("cycleStart = '2026-10-26'; mode = 'weekly';");

// Refreshes recalculate the pause and Next up; short holidays keep counting.
setBreaks([breakEvent('2026-11-02', '2026-11-07')]);
run('renderNextUp();');
assert.match(element('nextUp').textContent, /Subject 6.*9 Nov/);
setBreaks([breakEvent('2026-11-02', '2026-11-06')]);
run('renderNextUp();');
assert.match(element('nextUp').textContent, /Subject 10.*6 Nov/);

// Disconnecting restores the same saved classes immediately.
run("setSchoolCalendarState({connected:false,events:[],lastSynced:null,error:null,timezone:'Asia/Kolkata',source:'School calendar'}); buildCalendar(); render();");
assert.equal(run("schoolEventsForDate(localDate('2026-11-03')).length"), 0);
assert.deepEqual(plain("classesForDate(localDate('2026-11-03')).map(c => [c.id,c.day])"), [['7','Day 7']]);
assert.match(element('nextUp').textContent, /Subject 7/);
assert.equal(run('classes.length'), 10);

// Status rendering never reflects a token-bearing URL, even in unknown fields.
run("setSchoolCalendarState({connected:true,events:[],lastSynced:1793664000,error:null,timezone:'Asia/Kolkata',source:'School calendar',url:'https://school.example/private.ics?accessToken=private-synthetic-token'});");
assert.doesNotMatch([...elements.values()].map(item => item.textContent + item.innerHTML).join(' '), /private-synthetic-token/);

// Rich details are driven by every task's own metadata, never a hardcoded task.
run(`
  taskOne = {
    id:'task-one', title:'SA-Crit CD', start:'2026-11-24', end:'2026-11-25',
    allDay:false, startTime:'15:00', endTime:'15:30',
    startDateTime:'2026-11-24T15:00:00+05:30', endDateTime:'2026-11-24T15:30:00+05:30',
    noSchool:false, reason:'', taskType:'Summative Assessment',
    className:'MYP3 Design 1', createdBy:'Example Design Teacher',
    description:'Task Type: Summative Assessment\\nClasses: MYP3 Design 1\\nDescription: Criterion C: Creating a solution\\nCriterion D: Evaluating\\nCreated By: Example Design Teacher',
    taskDescription:'Criterion C: Creating a solution\\nCriterion D: Evaluating',
    location:'Design studio', url:'https://share.toddleapp.com/tiny/design-task'
  };
  taskTwo = {
    id:'task-two', title:'Science Investigation', start:'2026-11-25', end:'2026-11-26',
    allDay:false, startTime:'09:15', endTime:'10:00',
    startDateTime:'2026-11-25T09:15:00+05:30', endDateTime:'2026-11-25T10:00:00+05:30',
    noSchool:false, reason:'', taskType:'Formative Assessment',
    className:'MYP3 Science 2', createdBy:'Example Science Teacher',
    description:'Explain the experiment and record your results.',
    taskDescription:'Explain the experiment and record your results.',
    location:'Science laboratory', url:'https://share.toddleapp.com/tiny/science-task'
  };
  openSchoolEvent(taskOne);
`);
assert.equal(element('eventTitle').textContent, 'SA-Crit CD');
assert.match(element('eventDate').textContent, /24 November 2026/);
assert.match(element('eventTime').textContent, /3:00 PM.*3:30 PM/);
assert.equal(element('schoolEventDetails').hidden, false);
assert.equal(element('eventTaskType').textContent, 'Summative Assessment');
assert.equal(element('eventClassName').textContent, 'MYP3 Design 1');
assert.equal(element('eventCreatedBy').textContent, 'Example Design Teacher');
assert.match(element('eventDescription').textContent, /Criterion C: Creating a solution/);
assert.match(element('eventDescription').textContent, /Criterion D: Evaluating/);
assert.equal(element('eventTaskLink').hidden, false);
const linkHref = () => element('eventTaskLink').href || element('eventTaskLink').getAttribute('href');
assert.equal(linkHref(), 'https://share.toddleapp.com/tiny/design-task');
assert.equal(element('deleteEventBtn').hidden, true);
run('eventDialog.close(); openSchoolEvent(taskTwo);');
assert.equal(element('eventTitle').textContent, 'Science Investigation');
assert.match(element('eventDate').textContent, /25 November 2026/);
assert.match(element('eventTime').textContent, /9:15 AM.*10:00 AM/);
assert.equal(element('eventTaskType').textContent, 'Formative Assessment');
assert.equal(element('eventClassName').textContent, 'MYP3 Science 2');
assert.equal(element('eventCreatedBy').textContent, 'Example Science Teacher');
assert.equal(element('eventDescription').textContent, 'Explain the experiment and record your results.');
assert.equal(linkHref(), 'https://share.toddleapp.com/tiny/science-task');
assert.doesNotMatch(element('eventDescription').textContent, /Criterion C/);

// Missing optional metadata hides stale rows and links from the preceding task.
run(`
  openSchoolEvent({id:'all-day-event',title:'School assembly',start:'2026-11-26',end:'2026-11-27',
    allDay:true,description:'',taskDescription:'',taskType:'',className:'',createdBy:'',location:'',url:'',noSchool:false});
`);
assert.match(element('eventTime').textContent, /All day/i);
for(const id of ['eventTaskTypeRow','eventClassRow','eventTeacherRow','eventDescriptionSection','eventTaskLink']){
  assert.equal(element(id).hidden, true, `${id} should be hidden when absent from the current event`);
}
assert.equal(element('eventRoom').hidden, true);

// Calendar descriptions remain text; task URLs cannot execute scripts or carry credentials.
run("openSchoolEvent({...taskOne, taskDescription:'<script>alert(1)</script>\\nKeep <b>all</b> results.', url:'javascript:alert(1)'});");
assert.equal(element('eventDescription').textContent, '<script>alert(1)</script>\nKeep <b>all</b> results.');
assert.doesNotMatch(element('eventDescription').innerHTML, /<script>|<b>/);
assert.equal(element('eventTaskLink').hidden, true);
for(const value of [
  'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
  'https://name:password@example.test/task', 'https://example.test/ta\nsk',
  'file:///tmp/task', '//example.test/task'
]){
  context.unsafeTaskUrl = value;
  assert.equal(Boolean(run('safeEventUrl(unsafeTaskUrl)')), false, `Unsafe task URL should be rejected: ${JSON.stringify(value)}`);
}
assert.equal(run("safeEventUrl('https://share.toddleapp.com/tiny/task')"), 'https://share.toddleapp.com/tiny/task');

// Midnight-crossing task dates come from the exact start/end timestamps.
run(`
  openSchoolEvent({...taskTwo,title:'Overnight deadline',start:'2026-11-24',end:'2026-11-26',
    startTime:'23:30',endTime:'00:30',startDateTime:'2026-11-24T23:30:00+05:30',endDateTime:'2026-11-25T00:30:00+05:30'});
`);
assert.match(element('eventDate').textContent, /24 November 2026/);
assert.match(element('eventDate').textContent, /25 November 2026/);
assert.match(element('eventTime').textContent, /11:30 PM.*12:30 AM/);

// A stale cache must not invent a time, and class popups must not inherit task details.
run("openSchoolEvent({id:'legacy',title:'Older cached event',start:'2026-11-24',end:'2026-11-25',noSchool:false});");
assert.match(element('eventTime').textContent, /not (?:provided|available|supplied)|refresh/i);
run("eventDialog.close(); openEvent('6','2026-11-02');");
assert.equal(element('schoolEventDetails').hidden, true);
assert.equal(element('eventRoom').hidden, false);
assert.equal(element('deleteEventBtn').hidden, false);
