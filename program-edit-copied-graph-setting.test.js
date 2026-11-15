import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {inspectShow,readShowPart} from './xml-copy.js';
const hash=(a,s)=>createHash(a).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'copied-graph-setting-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),donor=path.join(dir,'donor.sktl');
 const program='<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers></sktimeline></item></skprogram>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('content/other.txt','preserved')}</skshow>`;
 const xml='<sktimeline version="1"><layers/><cue id="donor"><graph><node id="n1" type="trigger" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="trigger.path">old</setting><setting key="other">keep</setting></settings></node></graph></cue></sktimeline>';
 await writeFile(source,show);await writeFile(donor,xml);
 const add={action:'add_timeline_cue',index:1,layer:0,startMs:0,lengthMs:50,label:'New'};
 const copy=(cueFromOperation,index=1)=>({action:'copy_timeline_cue_graph',index,cueFromOperation,donor,donorSha256:hash('sha256',xml),donorCueId:'donor'});
 const edit=(graphFromOperation,key,value,index=0)=>({action:'edit_copied_timeline_graph_setting',index,graphFromOperation,donorNodeId:'n1',key,value});
 return {dir,source,destination,donor,show,xml,add,copy,edit,args:{source,destination,sha256:hash('sha256',show)}};
}
test('configures two copied graphs after an item shift and preserves show data',async t=>{
 const f=await fixture(t);
 const result=await compose({...f.args,operations:[f.add,f.copy(0),{...f.add,startMs:100},f.copy(2),{action:'remove',index:0},f.edit(1,'trigger.path','first & safe'),f.edit(3,'trigger.path','second'),f.edit(1,'node.stopped','false')]});
 const program=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 const [a,b]=result.copiedCueGraphs;
 assert.notEqual(a.idMap.n1,b.idMap.n1);
 assert.match(program,new RegExp(`id="${a.idMap.n1}"[^>]*stopped="0"`));
 assert.match(program,/>first &amp; safe<\/setting>/);assert.match(program,/>second<\/setting>/);
 assert.match(program,/>false<\/setting>/);assert.equal((program.match(/>keep<\/setting>/g)||[]).length,2);
 assert.equal(result.programSha256,hash('sha256',program));assert.ok((await inspectShow({file:f.destination})).parts.every(p=>p.valid));
 assert.equal((await readShowPart({file:f.destination,name:'content/other.txt'})).text,'preserved');
 assert.ok(result.warnings.some(w=>w.includes('existing cue graph setting')));assert.equal(new Set(result.warnings).size,result.warnings.length);
 assert.equal(await readFile(f.source,'utf8'),f.show);assert.equal(await readFile(f.donor,'utf8'),f.xml);
});
test('rejects invalid references and stale item selectors with rollback',async t=>{
 for(const variant of ['forward','wrong-operation','negative','missing-node','wrong-item','removed','invalid-setting','extra']){
  const f=await fixture(t);let operations=[f.add,f.copy(0),{action:'remove',index:0}];let op=f.edit(1,'trigger.path','changed');
  if(variant==='forward')op.graphFromOperation=3;
  if(variant==='wrong-operation')op.graphFromOperation=0;
  if(variant==='negative')op.graphFromOperation=-1;
  if(variant==='missing-node')op.donorNodeId='missing';
  if(variant==='wrong-item')op.index=1;
  if(variant==='removed')operations.push({action:'remove',index:0,allowContentRemoval:true});
  if(variant==='invalid-setting')op.key='missing';
  if(variant==='extra')op.extra=true;
  await assert.rejects(compose({...f.args,operations:[...operations,op]}));
  await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.deepEqual((await readdir(f.dir)).sort(),['donor.sktl','in.skshow']);
  assert.equal(await readFile(f.source,'utf8'),f.show);assert.equal(await readFile(f.donor,'utf8'),f.xml);
 }
});
