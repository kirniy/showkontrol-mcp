import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';
const hash=(a,s)=>createHash(a).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
async function fixture(t,router=true){
 const dir=await mkdtemp(path.join(os.tmpdir(),'assembled-program-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),donor=path.join(dir,'donor.skshow'),patch=path.join(dir,'donor.skf');
 const program='<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""><graph><node id="n5000" type="action"/></graph><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old"/></sktimeline></item></skprogram>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',`<showkontrol version="2"><appSettings/><graph>${router?'<node id="n900" type="router"><settings><setting key="router.name">A</setting></settings></node>':''}</graph></showkontrol>`)}</skshow>`;
 const donorShow=`<skshow>${part('content/Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n1" type="trigger" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>')}</skshow>`;
 const patchXml='<showkontrol version="2"><graph><node id="n2" type="action"><settings><setting key="route.router_target">A</setting></settings></node></graph></showkontrol>';
 await Promise.all([writeFile(source,show),writeFile(donor,donorShow),writeFile(patch,patchXml)]);
 const nodes=[{kind:'cue',template:donor,templateSha256:hash('sha256',donorShow),templateName:'content/Donor.sktl',templateCueId:'d',nodeId:'n1'},{kind:'patch',template:patch,templateSha256:hash('sha256',patchXml),templateFormat:'skf',nodeId:'n2'}];
 return {dir,source,destination,show,donor,donorShow,patch,patchXml,nodes,args:{source,destination,sha256:hash('sha256',show)},op:{action:'assemble_timeline_cue_graph',index:0,cueId:'c1',nodes,wires:[{from:0,to:1}]}};
}
test('assembles into an existing cue after an index shift with fresh IDs',async t=>{
 const f=await fixture(t);const result=await compose({...f.args,operations:[{action:'remove',index:0},f.op]});
 assert.deepEqual(result.assembledCueGraphs,[{operationIndex:1,cueId:'c1',nodeIds:['n5001','n5002']}]);
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.match(xml,/fromNode="n5001"/);assert.match(xml,/toNode="n5002"/);assert.equal(await readFile(f.source,'utf8'),f.show);
});
test('assembles into a newly created cue',async t=>{
 const f=await fixture(t);const op={...f.op,cueFromOperation:1};delete op.cueId;
 const result=await compose({...f.args,operations:[{action:'remove',index:0},{action:'add_timeline_cue',index:0,layer:0,startMs:200,lengthMs:50,label:'New'},op]});
 assert.equal(result.assembledCueGraphs[0].cueId,result.createdCues[0].id);assert.equal(result.assembledCueGraphs[0].operationIndex,2);
});
test('rejects invalid targets, router, stale donor and later errors atomically',async t=>{
 for(const kind of ['router','stale','later','future','both','occupied']){
  const f=await fixture(t,kind!=='router');let op={...f.op};let operations=[{action:'remove',index:0},op];
  if(kind==='stale')op.nodes=[{...f.nodes[0],templateSha256:'0'.repeat(64)},f.nodes[1]];
  if(kind==='later')operations.push({action:'edit',index:99,name:'bad'});
  if(kind==='future'){delete op.cueId;op.cueFromOperation=2;}
  if(kind==='both')op.cueFromOperation=0;
  if(kind==='occupied')operations.push(op);
  await assert.rejects(compose({...f.args,operations}));await assert.rejects(readFile(f.destination),{code:'ENOENT'});
  assert.deepEqual((await readdir(f.dir)).sort(),['donor.skf','donor.skshow','in.skshow']);assert.equal(await readFile(f.source,'utf8'),f.show);
 }
});
test('preserves an existing destination',async t=>{
 const f=await fixture(t);await writeFile(f.destination,'keep');
 await assert.rejects(compose({...f.args,operations:[{action:'remove',index:0},f.op]}),{code:'EEXIST'});
 assert.equal(await readFile(f.destination,'utf8'),'keep');assert.equal(await readFile(f.source,'utf8'),f.show);
});

test('edits assembled node settings after an item shift',async t=>{
 const f=await fixture(t);const edit=(key,value)=>({action:'edit_assembled_timeline_graph_setting',index:0,graphFromOperation:0,nodeIndex:0,key,value});
 const result=await compose({...f.args,operations:[{...f.op,index:1},{action:'remove',index:0},edit('trigger.path','new & safe'),edit('node.stopped','false')]});
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.match(xml,new RegExp(`id="${result.assembledCueGraphs[0].nodeIds[0]}"[^>]*stopped="0"`));
 assert.match(xml,/>new &amp; safe<\/setting>/);assert.match(xml,/>false<\/setting>/);
});
test('rejects invalid assembled setting selectors and stopped values with rollback',async t=>{
 for(const kind of ['forward','wrong','negative','out-of-range','fractional','wrong-item','removed','missing-setting','invalid-stopped','extra']){
  const f=await fixture(t);const op={action:'edit_assembled_timeline_graph_setting',index:0,graphFromOperation:1,nodeIndex:0,key:'trigger.path',value:'new'};
  const operations=[{action:'remove',index:0},f.op];
  if(kind==='forward')op.graphFromOperation=2;
  if(kind==='wrong')op.graphFromOperation=0;
  if(kind==='negative')op.nodeIndex=-1;
  if(kind==='out-of-range')op.nodeIndex=2;
  if(kind==='fractional')op.nodeIndex=0.5;
  if(kind==='wrong-item')op.index=1;
  if(kind==='removed')operations.push({action:'delete_timeline_cue',index:0,cueId:'c1',deleteGraph:true});
  if(kind==='missing-setting')op.key='missing';
  if(kind==='invalid-stopped'){op.key='node.stopped';op.value='yes';}
  if(kind==='extra')op.extra=true;
  await assert.rejects(compose({...f.args,operations:[...operations,op]}));
  await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.equal(await readFile(f.source,'utf8'),f.show);
 }
});
