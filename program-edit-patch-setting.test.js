import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';
const hash=(a,s)=>createHash(a).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
const router=(id,name)=>`<node id="${id}" type="router"><settings><setting key="router.name">${name}</setting></settings></node>`;
async function fixture(t,{targetType='action',settings='<settings/>',routers='',value='hello',key='notify.message'}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-setting-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),donor=path.join(dir,'donor.skf');
 const program=`<skprogram version="1"><item start="0" name="A" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old"><graph><node id="n3" type="${targetType}">${settings}</node></graph></cue></sktimeline></item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',`<showkontrol version="2"><appSettings/><graph>${routers}</graph></showkontrol>`)}</skshow>`;
 const patch=`<showkontrol version="2"><graph><node id="n2" type="action"><settings><setting key="${key}">${value}</setting></settings></node></graph></showkontrol>`;
 await Promise.all([writeFile(source,show),writeFile(donor,patch)]);
 const op={action:'copy_patch_setting_to_timeline_cue',index:0,cueId:'c1',nodeId:'n3',donor,donorFormat:'skf',donorSha256:hash('sha256',patch),donorNodeId:'n2',key};
 return {dir,source,destination,show,op,args:{source,destination,sha256:hash('sha256',show)}};
}
const output=async f=>(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
test('inserts and replaces settings without changing source',async t=>{
 for(const settings of ['<settings/>','<settings><setting key="notify.message">old</setting></settings>']){
  const f=await fixture(t,{settings});await compose({...f.args,operations:[f.op]});
  assert.match(await output(f),/<setting key="notify.message">hello<\/setting>/);assert.equal(await readFile(f.source,'utf8'),f.show);
 }
});
test('checks type, donor checksum, references and rollback',async t=>{
 for(const options of [{targetType:'trigger'},{value:'n99'},{}]){
  const f=await fixture(t,options);const op=options.targetType||options.value?f.op:{...f.op,donorSha256:'0'.repeat(64)};
  await assert.rejects(compose({...f.args,operations:[op]}));await assert.rejects(readFile(f.destination),{code:'ENOENT'});
  assert.deepEqual((await readdir(f.dir)).sort(),['donor.skf','in.skshow']);
 }
});
test('checks router names against staged destination patch',async t=>{
 for(const [routers,ok] of [[router('n8','A'),true],['',false],[router('n8','A')+router('n9','A'),false]]){
  const f=await fixture(t,{routers,key:'route.router_target',value:'A'});
  if(ok){await compose({...f.args,operations:[f.op]});assert.match(await output(f),/>A<\/setting>/);}
  else {await assert.rejects(compose({...f.args,operations:[f.op]}),/router target/i);await assert.rejects(readFile(f.destination),{code:'ENOENT'});}
 }
});
test('resolves active node receipts and rejects wrong cue and removed receipts',async t=>{
 for(const mode of ['valid','wrong','removed']){
  const f=await fixture(t);const copy={action:'copy_timeline_cue_node',index:0,cueId:'c1',donorType:'patch',donor:f.op.donor,donorSha256:f.op.donorSha256,donorFormat:'skf',donorNodeId:'n2'};
  const {nodeId,...base}=f.op;const setting={...base,nodeFromOperation:0};
  const operations=mode==='removed'?[copy,{action:'remove_timeline_cue_node',index:0,cueId:'c1',nodeId:'n4'},setting]:[copy,mode==='wrong'?{...setting,cueId:'missing'}:setting];
  if(mode==='valid'){await compose({...f.args,operations});assert.match(await output(f),/id="n4"[^]*notify.message/);}
  else {await assert.rejects(compose({...f.args,operations}));await assert.rejects(readFile(f.destination),{code:'ENOENT'});}
 }
});
test('selects a created cue and its copied node by operation receipts',async t=>{
 const f=await fixture(t);const add={action:'add_timeline_cue',index:0,layer:0,startMs:100,lengthMs:100,label:'New'};
 const copy={action:'copy_timeline_cue_node',index:0,cueFromOperation:0,donorType:'patch',donor:f.op.donor,donorSha256:f.op.donorSha256,donorFormat:'skf',donorNodeId:'n2'};
 // A created cue starts without a graph, so first copy a graph into it.
 const graphDonor=path.join(f.dir,'graph.sktl');const graph='<sktimeline version="1"><cue id="d"><graph><node id="n10" type="action"><settings/></node></graph></cue></sktimeline>';await writeFile(graphDonor,graph);
 const graphCopy={action:'copy_timeline_cue_graph',index:0,cueFromOperation:0,donor:graphDonor,donorSha256:hash('sha256',graph),donorCueId:'d'};
 const {cueId,nodeId,...base}=f.op;
 await compose({...f.args,operations:[add,graphCopy,{...copy}, {...base,cueFromOperation:0,nodeFromOperation:2}]});
 assert.match(await output(f),/label="New"[^]*notify.message/);
});
