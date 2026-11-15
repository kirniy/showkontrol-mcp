import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';
const hash=(a,s)=>createHash(a).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
async function fixture(t,variant='valid'){
 const dir=await mkdtemp(path.join(os.tmpdir(),'existing-cue-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),donor=path.join(dir,'donor.sktl');
 const cue=`<cue id="c1" layer="0" startMs="0" lenMs="100" label="Old">${variant==='nonempty'?'<graph><node id="n3" type="action"/></graph>':''}</cue>`;
 const duplicate=variant==='duplicate'?`<item start="2" name="C" notes=""><sktimeline version="1"><layers/>${cue}</sktimeline></item>`:'';
 const program=`<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers>${variant==='nested'?`<extension>${cue}</extension>`:cue}</sktimeline></item>${duplicate}</skprogram>`;
 const router=variant==='router-missing'?'':'<node id="n900" type="router"><settings><setting key="router.name">A</setting></settings></node>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',`<showkontrol version="2"><appSettings/><graph>${router}</graph></showkontrol>`)}</skshow>`;
 const xml='<sktimeline version="1"><layers/><cue id="donor"><graph><node id="n1" type="action"><settings><setting key="route.router_target">A</setting><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>';
 await writeFile(source,show);await writeFile(donor,xml);
 return {dir,source,destination,donor,show,xml,args:{source,destination,sha256:hash('sha256',show)},copy:{action:'copy_timeline_cue_graph',index:0,cueId:'c1',donor,donorSha256:hash('sha256',xml),donorCueId:'donor'}};
}
test('copies into an existing cue after an index shift and edits the mapped node',async t=>{
 const f=await fixture(t);
 const result=await compose({...f.args,operations:[{action:'remove',index:0},f.copy,{action:'edit_copied_timeline_graph_setting',index:0,graphFromOperation:1,donorNodeId:'n1',key:'trigger.path',value:'changed'}]});
 assert.equal(result.copiedCueGraphs[0].cueId,'c1');assert.equal(result.copiedCueGraphs[0].idMap.n1,'n901');
 const program=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.match(program,/id="n901"/);assert.match(program,/>changed<\/setting>/);assert.match(program,/>A<\/setting>/);
 assert.equal(await readFile(f.source,'utf8'),f.show);assert.equal(await readFile(f.donor,'utf8'),f.xml);
});
test('rejects ambiguous, wrong, occupied and invalid targets and rolls back',async t=>{
 for(const variant of ['duplicate','wrong','wrong-item','nested','nonempty','router-missing','stale','later','both','neither']){
  const f=await fixture(t,variant);const copy={...f.copy};
  if(variant==='wrong')copy.cueId='missing';
  if(variant==='stale')copy.donorSha256='0'.repeat(64);
  if(variant==='both')copy.cueFromOperation=0;
  if(variant==='neither')delete copy.cueId;
  const operations=[...(variant==='wrong-item'?[]:[{action:'remove',index:0}]),copy,...(variant==='later'?[{action:'edit',index:99,name:'x'}]:[])];
  await assert.rejects(compose({...f.args,operations}));
  await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.deepEqual((await readdir(f.dir)).sort(),['donor.sktl','in.skshow']);
  assert.equal(await readFile(f.source,'utf8'),f.show);assert.equal(await readFile(f.donor,'utf8'),f.xml);
 }
});
