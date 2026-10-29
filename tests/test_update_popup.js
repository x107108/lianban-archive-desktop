const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/updates.js'), 'utf8');
const releasePrefix = 'https://github.com/x107108/lianban-archive-desktop/releases/tag/v';
const notice = (version = '2026.10.29.2') => ({id:'release:'+version, version,
  title:'更新说明<script>', notes:'纯文字更新内容', published_at:'2026-10-29T08:00:00Z', url:releasePrefix+version});
const snapshot = (value = notice(), changes = {}) => ({current_version:'2026.10.29.1',
  notice:value, checking:false, checked_at:100, unavailable:false, ...changes});
const flush = () => new Promise(resolve => setImmediate(resolve));

function mount({readId = '', hidden = false, otherOpen = false} = {}) {
  let now = 100000, timerId = 0;
  const timers = new Map(), pending = [], stored = new Map(), writes = [], elements = [];
  if (readId) stored.set('lianban-desktop-read-release', readId);
  const documentEvents = new Map(), windowEvents = new Map();
  function listen(map, name, callback) {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(callback);
  }
  function emit(map, name, extra = {}) {
    const event = {type:name, prevented:false, preventDefault(){this.prevented=true;}, ...extra};
    for (const callback of map.get(name) || []) callback(event);
    return event;
  }
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.events = new Map(); this.attributes = {};
      this.hidden = false; this.open = false; this.textContent = ''; this.className = '';
      this.classList = {toggle:(name, on) => {this.classes ||= new Set(); on ? this.classes.add(name) : this.classes.delete(name);}};
      elements.push(this);
    }
    append(...nodes){this.children.push(...nodes);}
    prepend(node){this.children.unshift(node);}
    after(node){this.afterNode=node;}
    setAttribute(name,value){this.attributes[name]=value;}
    removeAttribute(name){delete this.attributes[name];}
    addEventListener(name,callback){listen(this.events,name,callback);}
    showModal(){this.open=true;this.shown=(this.shown || 0)+1;}
    close(){this.open=false;emit(this.events,'close');emit(documentEvents,'close',{target:this});}
    focus(){this.focused=true;}
    click(){return emit(this.events,'click');}
  }
  const topbar = new Element('header'), intro = new Element('section'), body = new Element('body');
  const other = new Element('dialog'); other.open = otherOpen;
  const document = {body, visibilityState:hidden ? 'hidden' : 'visible',
    createElement:tag=>new Element(tag),
    querySelector(selector){
      if (selector === '.topbar-right') return topbar;
      if (selector === '.intro') return intro;
      if (selector === 'dialog[open]') return elements.find(node=>node.tag==='dialog' && node.open) || null;
      throw new Error('Unknown selector '+selector);
    }, addEventListener:(name, callback)=>listen(documentEvents,name,callback)};
  const context = vm.createContext({document, window:{addEventListener:(name,callback)=>listen(windowEvents,name,callback)},
    localStorage:{getItem:key=>stored.get(key) || null,setItem(key,value){stored.set(key,value);writes.push([key,value]);}},
    Date:class extends Date {static now(){return now;}}, AbortSignal:{timeout:()=>({})},
    setTimeout(callback,delay){const id=++timerId;timers.set(id,{callback,at:now+delay});return id;},
    clearTimeout:id=>timers.delete(id),
    fetch:(url,options)=>new Promise((resolve,reject)=>pending.push({url,options,resolve,reject}))});
  vm.runInContext(source,context);
  const byText = text => elements.find(node=>node.textContent === text);
  const byClass = cls => elements.find(node=>node.className === cls);
  return {document,other,elements,pending,stored,writes,byText,byClass,
    dialog:elements.find(node=>node.id==='update-inbox'), banner:intro.afterNode,
    async respond(payload){assert.ok(pending.length,'expected a request');pending.shift().resolve({ok:true,json:async()=>payload});await flush();},
    async fail(){pending.shift().reject(new Error('offline'));await flush();},
    emitDocument:(name,extra)=>emit(documentEvents,name,extra), emitWindow:(name,extra)=>emit(windowEvents,name,extra),
    advance(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.callback();}}};
}

(async()=>{
  const app = mount();
  await app.respond(snapshot());
  assert.equal(app.dialog.open,true,'a published newer version opens the modal without a click');
  assert.equal(app.writes.length,0,'automatic display never marks the notice read');
  assert.equal(app.byClass('icon-button').hidden,true,'a new-version prompt has no ambiguous close icon');
  const cancel = {prevented:false,preventDefault(){this.prevented=true;}};
  for(const callback of app.dialog.events.get('cancel'))callback(cancel);
  assert.equal(cancel.prevented,true,'Escape cannot silently dismiss an update');
  assert.equal(app.byClass('update-notice').children[0].textContent,'更新说明<script>','notice title remains plain text');
  assert.equal(app.byText('去更新').href,releasePrefix+'2026.10.29.2');
  app.byText('稍后提醒').click();
  assert.equal(app.dialog.open,false);
  assert.equal(app.banner.hidden,false,'the upgrade banner remains after postponing');
  assert.equal(app.stored.get('lianban-desktop-read-release'),'release:2026.10.29.2');
  assert.ok(app.writes.every(([key])=>key==='lianban-desktop-read-release'));
  app.advance(599999); await app.respond(snapshot());
  assert.equal(app.dialog.open,false,'postponing lasts ten minutes in this page');
  app.advance(1); await app.respond(snapshot());
  assert.equal(app.dialog.open,true,'the modal returns after the reminder interval');

  const alreadyRead = mount({readId:'release:2026.10.29.2'});
  await alreadyRead.respond(snapshot());
  assert.equal(alreadyRead.dialog.open,true,'opening a new page prompts even if the same inbox notice was previously read');
  alreadyRead.byText('去更新').click();
  assert.equal(alreadyRead.dialog.open,false,'the explicit update choice acknowledges the modal');

  const editing = mount({otherOpen:true});
  await editing.respond(snapshot());
  assert.equal(editing.dialog.open,false,'an existing editing dialog is allowed to finish');
  editing.other.open=false;editing.emitDocument('close',{target:editing.other});
  assert.equal(editing.dialog.open,true,'the update is shown as soon as the other dialog closes');

  const background = mount({hidden:true});
  await background.respond(snapshot());
  assert.equal(background.dialog.open,false,'hidden tabs defer the visible prompt');
  background.document.visibilityState='visible';background.emitDocument('visibilitychange');
  assert.equal(background.dialog.open,true);
  assert.ok(background.pending[0].url.endsWith('?check=1'),'returning to the page actively rechecks');
  await background.respond(snapshot());

  const offline = mount();
  await offline.fail();
  assert.equal(offline.dialog.open,false);
  assert.equal(offline.banner.hidden,false,'failure is visible instead of silently looking current');
  assert.ok(offline.banner.children[0].textContent.includes('未成功'));
  assert.ok(!offline.byClass('update-status').textContent.includes('已是最新'));
  offline.emitWindow('online');
  assert.ok(offline.pending[0].url.endsWith('?check=1'),'network recovery retries immediately');
  await offline.respond(snapshot());
  assert.equal(offline.dialog.open,true);

  const current = mount();await current.respond(snapshot(null));
  assert.equal(current.dialog.open,false,'the current release never prompts to update itself');
  assert.equal(current.banner.hidden,true);
  current.byText('站内信').click();await current.respond(snapshot(null));
  assert.equal(current.dialog.open,true);
  assert.equal(current.byClass('icon-button').hidden,false,'the ordinary inbox remains closable');

  const nextRelease = mount();await nextRelease.respond(snapshot());
  nextRelease.byText('稍后提醒').click();nextRelease.advance(60000);
  await nextRelease.respond(snapshot(notice('2026.10.29.3')));
  assert.equal(nextRelease.dialog.open,true,'a different new release is not suppressed by an older reminder');
  console.log('Automatic update prompt: explicit choice, re-open, snooze, modal coordination, hidden tabs, offline recovery and installed-version isolation passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
