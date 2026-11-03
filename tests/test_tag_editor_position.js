// Full hierarchy paths and an actual quiet save/refresh at the end of the matrix.
const assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
const elements=new Map(), listeners=new Map(), calls=[];
let board={scrollLeft:8500}, resolveDate, failed=false, paths=[];
const view={scrollX:0,scrollY:4600,scrollTo(position){this.scrollX=position.left;this.scrollY=position.top;}};
function $(id){
  if(!elements.has(id)){
    const el={value:'',hidden:false,disabled:false,open:false,textContent:'',
      setAttribute(name,value){this[name]=value;},removeAttribute(name){delete this[name];},reportValidity:()=>true,
      querySelector:()=>board,querySelectorAll:selector=>id==='tag-editor-list'&&selector==='[data-tag-path]'?paths:[],
      addEventListener(type,fn){listeners.set(`${id}:${type}`,fn);},
      close(){this.open=false;board.scrollLeft=0;view.scrollY=0;calls.push('close');}};
    let markup='';
    Object.defineProperty(el,'innerHTML',{get:()=>markup,set(value){markup=value;
      if(id==='tag-editor-list') paths=[...value.matchAll(/data-tag-path="([0-9]+)"/g)].map(match=>({dataset:{tagPath:match[1]}}));}});
    elements.set(id,el);
  }
  return elements.get(id);
}
const hierarchy=[{name:'机器人',parent:''},{name:'电机',parent:'机器人'},{name:'驱动<&>',parent:'电机'}];
const context=vm.createContext({$,URLSearchParams,window:view,state:{tab:'date',requests:{},meta:{tag_hierarchy:hierarchy},
  tagDraft:['机器人','驱动<&>'],tagEditorData:{code:'000678',revision:2,source_tags:['驱动<&>']},tagUseSource:false},
  canEditTags:()=>true,canEditBlacklist:()=>true,clearError(){},loadShareholderAlerts(){},
  getDateQuery:()=>new URLSearchParams({date:'2026-10-28'}),
  setView(){throw new Error('quiet refresh must not switch/reset the view');},
  loadingHTML(){throw new Error('quiet refresh must not replace the matrix with loading content');},
  updateIndustryNavigation(){},renderDate(data){context.state.dateData=data;board={scrollLeft:0};view.scrollY=0;calls.push('render');},
  async request(url,channel,options){
    if(url==='/api/stock-tags') {calls.push(JSON.parse(options.body));if(failed)throw new Error('保存失败');return {tags:context.state.tagDraft};}
    if(url==='/api/tags')return {tags:[{name:'机器人',count:10},{name:'驱动<&>',count:1}],hierarchy,revision:'r2'};
    if(url.startsWith('/api/date?'))return new Promise(resolve=>{resolveDate=resolve;});
    throw new Error(url);
  }});
for(const [from,to] of [['function escapeHTML','function debounce'],['function stockTags','function canEditTags'],
  ['function renderTagEditor','function renderTable'],['async function loadDate','function renderDate(data)']]){
  vm.runInContext(source.slice(source.indexOf(from),source.indexOf(to)),context);
}
vm.runInContext(source.slice(source.indexOf('$("tag-editor-list").addEventListener("input"'),source.indexOf('$("tag-editor-list").addEventListener("click"')),context);
$('trade-date').value='2026-10-28';$('tag-dialog').open=true;$('date-table-area').innerHTML='original matrix';
context.renderTagEditor();
assert.equal(paths.find(p=>p.dataset.tagPath==='0').hidden,true,'explicit root remains its own editable membership');
assert.equal(paths.find(p=>p.dataset.tagPath==='1').textContent,'机器人 / 电机 /');
assert.equal($('tag-source-label').textContent,'默认标签：机器人 / 电机 / 驱动<&>');
const markup=$('tag-editor-list').innerHTML;
assert.ok(markup.includes('value="驱动&lt;&amp;&gt;"'),'only the actual name is editable and escaped');
listeners.get('tag-editor-list:input')({target:{matches:()=>true,dataset:{tagIndex:'1'},value:'电机'}});
assert.equal(paths.find(p=>p.dataset.tagPath==='1').textContent,'机器人 /');
assert.equal($('tag-editor-list').innerHTML,markup,'updating paths does not replace or refocus text fields');
context.state.tagDraft[1]='驱动<&>';context.updateTagEditorPaths();
context.state.tagDraft.push('机器人/电机/草稿子级');context.renderTagEditor();
assert.equal(paths.find(p=>p.dataset.tagPath==='2').textContent,'机器人 / 电机 /');
listeners.get('tag-editor-list:input')({target:{matches:()=>true,dataset:{tagIndex:'2'},value:'修改子级'}});
assert.equal(context.state.tagDraft[2],'机器人/电机/修改子级','editing a new leaf retains its pending parent path');
context.state.tagDraft.pop();context.renderTagEditor();
(async()=>{
  const save=context.saveTagEditor({preventDefault(){}});
  while(!resolveDate)await Promise.resolve();
  assert.equal($('tag-dialog').open,true,'dialog remains open throughout the background refresh');
  assert.equal($('save-tags').textContent,'正在保存…');assert.equal($('save-tags').disabled,true);
  assert.equal($('date-table-area').innerHTML,'original matrix');
  assert.equal(board.scrollLeft,8500);assert.equal(view.scrollY,4600);
  resolveDate({rows:[]});await save;
  assert.deepEqual(calls[0].tags,['机器人','驱动<&>'],'paths do not add parents to the submitted payload');
  assert.equal(calls.at(-2),'render');assert.equal(calls.at(-1),'close');
  assert.equal(board.scrollLeft,8500,'horizontal end position survives replacing the matrix and dialog focus restoration');
  assert.equal(view.scrollY,4600,'page end position survives refresh and dialog closure');
  assert.equal($('save-tags').textContent,'保存标签');assert.equal(context.state.tagSaving,false);
  $('tag-dialog').open=true;failed=true;await context.saveTagEditor({preventDefault(){}});
  assert.equal($('tag-dialog').open,true);assert.equal($('tag-editor-error').hidden,false);
  assert.equal($('save-tags').disabled,false);assert.equal(board.scrollLeft,8500);assert.equal(view.scrollY,4600);
  console.log('Tag editor: full hierarchy paths, safe drafts, no skeleton collapse, loading through refresh, retained XY scroll and failure drafts passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
