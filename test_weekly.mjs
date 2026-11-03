// Run with: node test_weekly.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Minimal DOM surface so the real timetable script and render functions run.
class Element {
  constructor(){
    this.value = '';
    this.children = [];
    this.dataset = {};
    this.classList = {toggle(){}};
  }
  get innerHTML(){ return this.markup ?? String(this.textContent ?? ''); }
  set innerHTML(value){ this.markup = value; }
  get options(){ return this.children; }
  add(child){ this.children.push(child); }
  append(...children){ this.children.push(...children); }
  appendChild(child){ this.children.push(child); }
  replaceChildren(...children){ this.children = children; }
  querySelectorAll(){ return []; }
  addEventListener(){}
}
const elements = new Map();
const context = vm.createContext({
  document: {
    getElementById(id){
      if(!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement(){ return new Element(); },
    createTextNode(text){ return text; }
  },
  Option: function(text, value){ return {text, value}; }
});
const source = readFileSync(new URL('./script.js', import.meta.url), 'utf8');
vm.runInContext(source.replace(/start\(\);\s*$/, ''), context);
const run = code => vm.runInContext(code, context);
run(`
  classes = CYCLE_DAYS.map((day, i) => ({
    id:String(i + 1), day, subject:'Subject ' + (i + 1),
    start:'09:00', end:'10:00', room:'', color:'green'
  }));
  classes.push({id:'weekly', day:'Saturday', subject:'Weekly class', start:'11:00', end:'12:00'});
  cycleStart = '2026-10-26';
  cycleWeekSelect.value = '0';
  buildDayUi();
  render();
`);
const displayed = () => JSON.parse(run('JSON.stringify(visibleClasses().map(c => [c.id, c.day]))'));
assert.deepEqual(displayed(), [
  ['1','Monday'], ['2','Tuesday'], ['3','Wednesday'], ['4','Thursday'], ['5','Friday'], ['weekly','Saturday']
]);
assert.equal(run('dayCols.Monday.list.children.length'), 1);
assert.match(run('dayCols.Monday.list.children[0].innerHTML'), /Subject 1/);
assert.equal(elements.get('cycleWeekField').hidden, false);
run("cycleWeekSelect.value = '1'; render();");
assert.deepEqual(displayed(), [
  ['6','Monday'], ['7','Tuesday'], ['8','Wednesday'], ['9','Thursday'], ['10','Friday'], ['weekly','Saturday']
]);
assert.match(run('dayCols.Friday.list.children[0].innerHTML'), /Subject 10/);
run("mode = 'cycle'; buildDayUi(); render();");
assert.equal(displayed().length, 10);
assert.equal(elements.get('cycleWeekField').hidden, true);
assert.equal(run('classes[0].day'), 'Day 1');
assert.equal(run('classes.length'), 11);

// Next up uses the actual cycle date even while a different week is displayed.
run(`
  const RealDate = Date;
  Date = class extends RealDate {
    constructor(...args){ super(...(args.length ? args : [2026, 10, 2, 8])); }
  };
  mode = 'weekly';
  cycleWeekSelect.value = '0';
  buildDayUi();
  render();
`);
assert.match(elements.get('nextUp').children[0].innerHTML, /Subject 6/);
run("cycleWeekSelect.value = '1'; render();");
assert.match(elements.get('nextUp').children[0].innerHTML, /Subject 6/);
run("mode = 'cycle'; buildDayUi(); render();");
assert.match(elements.get('nextUp').children[0].innerHTML, /Subject 6/);

run("classes = [classes.find(c => c.id === 'weekly')]; mode = 'weekly'; buildDayUi(); render();");
assert.deepEqual(displayed(), [['weekly','Saturday']]);
assert.equal(elements.get('cycleWeekField').hidden, true);
