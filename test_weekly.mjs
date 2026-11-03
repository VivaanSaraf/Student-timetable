// Run with: node test_weekly.mjs
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
  classes.push({id:'weekly', day:'Saturday', subject:'Weekly class', start:'11:00', end:'12:00', room:'', color:'red'});
  cycleStart = '2026-10-26';
  mode = 'weekly';
  viewDate = localDate('2026-11-03');
`);
assert.deepEqual(dates(), ['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06']);
assert.deepEqual(plain('currentDays()'), ['Monday','Tuesday','Wednesday','Thursday','Friday']);
assert.deepEqual(plain('visibleClasses().map(c => c.id)'), ['6','7','8','9','10']);
assert.equal(run("classes.some(c => c.id === 'weekly' && c.day === 'Saturday')"), true);
assert.deepEqual(plain("classesForDate(localDate('2026-11-02')).map(c => c.id)"), ['6']);
assert.deepEqual(plain("classesForDate(localDate('2026-11-07')).map(c => c.id)"), ['weekly']);
assert.deepEqual(plain("classesForDate(localDate('2026-11-08')).map(c => c.id)"), []);
assert.equal(run("cycleDayFor(localDate('2026-10-23'))"), 'Day 10');
assert.equal(run("cycleDayFor(localDate('2026-10-24'))"), null);
assert.equal(run("dateKey(addDays(localDate('2026-12-31'), 1))"), '2027-01-01');
assert.equal(run("dateKey(weekStart(localDate('2027-01-03')))"), '2026-12-28');

// Midweek anchors must retain their actual weekday alignment.
run("cycleStart = '2026-10-28';");
assert.equal(run("cycleDayFor(localDate('2026-10-27'))"), 'Day 10');
assert.equal(run("cycleDayFor(localDate('2026-10-30'))"), 'Day 3');
assert.equal(run("cycleDayFor(localDate('2026-11-02'))"), 'Day 4');
assert.equal(run("cycleDayFor(localDate('2026-11-06'))"), 'Day 8');
assert.deepEqual(plain("classesForDate(localDate('2026-11-02')).map(c => [c.id, c.day])"), [['4', 'Day 4']]);

// Cycle mode shows ten school dates for the cycle containing the selected date.
run("mode = 'cycle'; viewDate = localDate('2026-11-03');");
assert.deepEqual(dates(), ['2026-10-28','2026-10-29','2026-10-30','2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-09','2026-11-10']);
assert.equal(run('visibleClasses().length'), 10);
assert.equal(run('classes[0].day'), 'Day 1');
assert.equal(run('classes.length'), 11);

// Weekly events and cycle events may coincide without changing source days.
run("classes.push({id:'monday', day:'Monday', subject:'Weekly Monday', start:'09:30', end:'10:30', room:'', color:'red'});");
assert.deepEqual(plain("classesForDate(localDate('2026-11-02')).map(c => [c.id, c.day])"), [['4','Day 4'], ['monday','Monday']]);
run("classes = classes.filter(c => c.id !== 'monday');");

// Invalid cycle settings must fail safely rather than loop forever.
run("cycleStart = ''; ");
assert.equal(run("cycleDayFor(localDate('2026-11-03'))"), null);
run("cycleStart = 'invalid';");
assert.equal(run("cycleDayFor(localDate('2026-11-03'))"), null);
run("cycleStart = '2026-10-24';");
assert.equal(run("cycleDayFor(localDate('2026-11-03'))"), null);

// Cycle day names are primary; weekday/date/month stay aligned for midweek Day 1.
run("cycleStart = '2026-10-28'; mode = 'cycle'; viewDate = localDate('2026-11-03'); buildDayUi(); render();");
assert.deepEqual(headerField('header-weekday'), Array.from({length:10}, (_, i) => `Day ${i + 1}`));
assert.deepEqual(headerField('header-cycle'), ['Wednesday','Thursday','Friday','Monday','Tuesday','Wednesday','Thursday','Friday','Monday','Tuesday']);
assert.deepEqual(headerField('header-date'), ['28','29','30','2','3','4','5','6','9','10']);
assert.deepEqual(headerField('header-month'), ['Oct 2026','Oct 2026','Oct 2026', ...Array(7).fill('Nov 2026')]);

// Calendar headers and navigation use actual dates, including year boundaries.
run("cycleStart = '2026-10-26'; mode = 'weekly'; viewDate = localDate('2026-11-03'); buildDayUi(); render();");
assert.deepEqual(plain('Object.keys(dayCols)'), dates());
assert.deepEqual(headerField('header-weekday'), ['Monday','Tuesday','Wednesday','Thursday','Friday']);
assert.deepEqual(headerField('header-cycle'), ['Day 6','Day 7','Day 8','Day 9','Day 10']);
assert.deepEqual(headerField('header-date'), ['2','3','4','5','6']);
assert.deepEqual(headerField('header-month'), Array(5).fill('Nov 2026'));
assert.match(element('calendarTitle').textContent, /November/);
assert.match(element('calendarHeaders').textContent, /Nov/i);
assert.match(element('calendarHeaders').textContent, /3/);
run('navigateCalendar(-1);');
assert.equal(dates()[0], '2026-10-26');
run('navigateCalendar(1);');
assert.equal(dates()[0], '2026-11-02');
run("viewDate = localDate('2026-12-30'); buildDayUi(); render();");
assert.equal(dates()[0], '2026-12-28');
assert.equal(dates()[4], '2027-01-01');
assert.match(element('calendarRange').textContent, /2026/);
assert.match(element('calendarRange').textContent, /2027/);
await element('todayBtn').fire('click');
assert.equal(dates()[0], '2026-11-02');

// Upcoming classes follow real dates even while browsing another week.
run("viewDate = localDate('2026-12-30'); buildDayUi(); render();");
assert.match(element('nextUp').textContent, /Subject 7/);
run("savedClasses = classes; classes = classes.filter(c => c.id === 'weekly'); renderNextUp();");
assert.match(element('nextUp').textContent, /No upcoming classes/);
run('classes = savedClasses;');
run("mode = 'cycle'; viewDate = localDate('2026-11-03'); buildDayUi(); render(); navigateCalendar(1);");
assert.equal(dates()[0], '2026-11-09');
run('navigateCalendar(-1);');
assert.equal(dates()[0], '2026-10-26');

// Events that touch at an endpoint share a lane; real overlaps remain distinct.
run(`
  testItems = [
    {id:'a', start:'09:00', end:'10:00'},
    {id:'b', start:'09:30', end:'10:30'},
    {id:'c', start:'10:00', end:'11:00'},
    {id:'d', start:'12:00', end:'13:00'}
  ];
`);
const placed = plain('layoutEvents(testItems).map(({item,lane,lanes}) => ({id:item.id,lane,lanes}))');
const byId = Object.fromEntries(placed.map(item => [item.id, item]));
assert.notEqual(byId.a.lane, byId.b.lane);
assert.notEqual(byId.b.lane, byId.c.lane);
assert.equal(byId.a.lane, byId.c.lane);
assert.equal(byId.a.lanes, 2);
assert.equal(byId.b.lanes, 2);
assert.equal(byId.c.lanes, 2);
assert.equal(byId.d.lanes, 1);
assert.deepEqual(plain('testItems.map(c => c.id)'), ['a','b','c','d']);

// Narrow screens show exactly one dated day; navigation moves by days.
run("mode = 'weekly'; viewDate = localDate('2026-11-03');");
narrowScreen.matches = true;
narrowScreen.listeners.forEach(callback => callback({matches:true}));
assert.deepEqual(dates(), ['2026-11-03']);
assert.deepEqual(plain('Object.keys(dayCols)'), ['2026-11-03']);
assert.deepEqual(headerField('header-weekday'), ['Tuesday']);
assert.deepEqual(headerField('header-date'), ['3']);
assert.deepEqual(headerField('header-month'), ['Nov 2026']);
assert.equal(element('prevWeekBtn').attributes['aria-label'], 'Previous day');
assert.equal(element('nextWeekBtn').attributes['aria-label'], 'Next day');
await element('nextWeekBtn').fire('click');
assert.deepEqual(dates(), ['2026-11-04']);
await element('prevWeekBtn').fire('click');
assert.deepEqual(dates(), ['2026-11-03']);
run("viewDate = localDate('2026-12-30'); buildCalendar(); render();");
await element('todayBtn').fire('click');
assert.deepEqual(dates(), ['2026-11-03']);

// Weekly mode also skips Saturday/Sunday during daily navigation.
run("viewDate = localDate('2026-11-06'); buildCalendar(); render();");
await element('nextWeekBtn').fire('click');
assert.deepEqual(dates(), ['2026-11-09']);
assert.deepEqual(headerField('header-weekday'), ['Monday']);
await element('prevWeekBtn').fire('click');
assert.deepEqual(dates(), ['2026-11-06']);
run("viewDate = localDate('2026-11-07'); buildCalendar(); render();");
assert.deepEqual(dates(), ['2026-11-09']);
assert.deepEqual(plain('Object.keys(dayCols)'), ['2026-11-09']);
run("viewDate = localDate('2026-11-08'); buildCalendar(); render();");
assert.deepEqual(dates(), ['2026-11-09']);
await element('todayBtn').fire('click');
assert.deepEqual(dates(), ['2026-11-03']);

// The cycle's single-day view skips weekends and wraps Day 10 to Day 1.
run("mode = 'cycle'; viewDate = localDate('2026-11-06'); buildCalendar(); render();");
assert.deepEqual(dates(), ['2026-11-06']);
assert.deepEqual(headerField('header-weekday'), ['Day 10']);
await element('nextWeekBtn').fire('click');
assert.deepEqual(dates(), ['2026-11-09']);
assert.deepEqual(headerField('header-weekday'), ['Day 1']);
assert.deepEqual(headerField('header-cycle'), ['Monday']);
await element('prevWeekBtn').fire('click');
assert.deepEqual(dates(), ['2026-11-06']);
run("viewDate = localDate('2026-11-07'); buildCalendar(); render();");
assert.deepEqual(dates(), ['2026-11-09']);
await element('todayBtn').fire('click');
assert.deepEqual(dates(), ['2026-11-03']);
assert.deepEqual(headerField('header-weekday'), ['Day 7']);

// Horizontal swipes navigate one day; vertical scrolling does not.
await element('calendarScroll').fire('touchstart', {touches:[{clientX:200, clientY:100}]});
await element('calendarScroll').fire('touchend', {changedTouches:[{clientX:100, clientY:105}]});
assert.deepEqual(dates(), ['2026-11-04']);
await element('calendarScroll').fire('touchstart', {touches:[{clientX:100, clientY:100}]});
await element('calendarScroll').fire('touchend', {changedTouches:[{clientX:200, clientY:105}]});
assert.deepEqual(dates(), ['2026-11-03']);
await element('calendarScroll').fire('touchstart', {touches:[{clientX:100, clientY:100}]});
await element('calendarScroll').fire('touchend', {changedTouches:[{clientX:105, clientY:200}]});
assert.deepEqual(dates(), ['2026-11-03']);

// Returning to desktop restores the full weekly/cycle views.
narrowScreen.matches = false;
narrowScreen.listeners.forEach(callback => callback({matches:false}));
assert.equal(dates().length, 10);
assert.equal(plain('Object.keys(dayCols)').length, 10);
run("mode = 'weekly'; buildCalendar(); render();");
assert.equal(dates().length, 5);
assert.equal(plain('Object.keys(dayCols)').length, 5);
