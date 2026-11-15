import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';
const hash=(a,s)=>createHash(a).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
async function fixture(t,variant='valid'){
 const dir=await mkdtemp(path.join(os.tmpdir(),'remove-graph-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),donor=path.join(dir,'donor.sktl');
 const node=variant==='nested'?'<extension><node id="n3" type="action"/></extension>':'<node id="n3" type="action"/>';
 const extra=variant==='program-ref'?'<graph><node id="n4" target="n3"/></graph>':variant==='duplicate'?'<graph><node id="n3"/></graph>':'<graph><node id="n4" target="c1"/></graph>';
 const program=`<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old"><graph>${node}</graph></cue></sktimeline></item><item start="2" name="C" notes="">${extra}</item></skprogram>`;
 const other=variant==='show-ref'?'<showkontrol version="2"><appSettings/><graph><node id="n9" target="n3"/></graph></showkontrol>':variant==='unreadable'?'<broken>':'<showkontrol version="2"><appSettings/><graph><node id="n9" target="c1"/></graph></showkontrol>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',other)}</skshow>`;
 const xml='<sktimeline version="1"><layers/><cue id="donor"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>';
 await writeFile(source,show);await writeFile(donor,xml);
 return {dir,source,destination,show,donor,xml,args:{source,destination,sha256:hash('sha256',show)},remove:{action:'remove_timeline_cue_graph',index:0,cueId:'c1'},copy:{action:'copy_timeline_cue_graph',index:0,cueId:'c1',donor,donorSha256:hash('sha256',xml),donorCueId:'donor'}};
}
test('removes after index shift, copies a graph and configures it',async t=>{
 const f=await fixture(t);const result=await compose({...f.args,operations:[{action:'remove',index:0},f.remove,f.copy,{action:'edit_copied_timeline_graph_setting',index:0,graphFromOperation:2,donorNodeId:'n1',key:'trigger.path',value:'new'}]});
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.match(xml,/<cue id="c1"[^>]*><graph>/);assert.doesNotMatch(xml,/id="n3"/);assert.match(xml,/>new<\/setting>/);assert.equal(result.copiedCueGraphs[0].cueId,'c1');
});
test('assembles and configures a replacement graph after removal',async t=>{
 const f=await fixture(t);const template=path.join(f.dir,'template.skshow');const templateShow=`<skshow>${part('content/Donor.sktl',f.xml)}</skshow>`;await writeFile(template,templateShow);
 const nodes=[{kind:'cue',template,templateSha256:hash('sha256',templateShow),templateName:'content/Donor.sktl',templateCueId:'donor',nodeId:'n1'}];
 const result=await compose({...f.args,operations:[{action:'remove',index:0},f.remove,{action:'assemble_timeline_cue_graph',index:0,cueId:'c1',nodes},{action:'edit_assembled_timeline_graph_setting',index:0,graphFromOperation:2,nodeIndex:0,key:'trigger.path',value:'assembled'}]});
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;assert.match(xml,/>assembled<\/setting>/);assert.equal(result.assembledCueGraphs[0].cueId,'c1');
});
test('copy then remove in one transaction preserves the cue',async t=>{
 const f=await fixture(t);await compose({...f.args,operations:[{action:'remove',index:0},f.remove,f.copy,f.remove]});
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;assert.match(xml,/<cue id="c1"[^>]*><\/cue>/);assert.doesNotMatch(xml,/id="n3"/);
});
test('rejects references, ambiguous and nested nodes, unreadable parts and later failure without publication',async t=>{
 for(const variant of ['program-ref','show-ref','duplicate','nested','unreadable','later']){
  const f=await fixture(t,variant);const operations=[{action:'remove',index:0},f.remove,...(variant==='later'?[{action:'edit',index:99,name:'bad'}]:[])];
  const expected={'program-ref':/surviving XML references in Program/,'show-ref':/surviving XML references in patch.skf/,duplicate:/ambiguous node IDs/,nested:/Nested graph or node/,unreadable:/could not be scanned/,later:/index out of range/};
  await assert.rejects(compose({...f.args,operations}),expected[variant]);await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.deepEqual((await readdir(f.dir)).sort(),['donor.sktl','in.skshow']);assert.equal(await readFile(f.source,'utf8'),f.show);
 }
});
test('rejects stale copy and assembly selectors when replacement node IDs are reused',async t=>{
 for(const kind of ['copy','assemble']){
  const f=await fixture(t);const template=path.join(f.dir,'template.skshow');const templateShow=`<skshow>${part('content/Donor.sktl',f.xml)}</skshow>`;await writeFile(template,templateShow);
  const graph=kind==='copy'?f.copy:{action:'assemble_timeline_cue_graph',index:0,cueId:'c1',nodes:[{kind:'cue',template,templateSha256:hash('sha256',templateShow),templateName:'content/Donor.sktl',templateCueId:'donor',nodeId:'n1'}]};
  const operations=[{action:'remove',index:0},f.remove,graph,f.remove,graph];
  const result=await compose({...f.args,operations});const receipts=kind==='copy'?result.copiedCueGraphs:result.assembledCueGraphs;
  assert.equal(kind==='copy'?receipts[0].idMap.n1:receipts[0].nodeIds[0],kind==='copy'?receipts[1].idMap.n1:receipts[1].nodeIds[0]);
  const stale=kind==='copy'?{action:'edit_copied_timeline_graph_setting',index:0,graphFromOperation:2,donorNodeId:'n1',key:'trigger.path',value:'stale'}:{action:'edit_assembled_timeline_graph_setting',index:0,graphFromOperation:2,nodeIndex:0,key:'trigger.path',value:'stale'};
  const failed=path.join(f.dir,'failed.skshow');await assert.rejects(compose({...f.args,destination:failed,operations:[...operations,stale]}),/active prior/);await assert.rejects(readFile(failed),{code:'ENOENT'});
  assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('.showkontrol-')),[]);assert.equal(await readFile(f.source,'utf8'),f.show);
 }
});
