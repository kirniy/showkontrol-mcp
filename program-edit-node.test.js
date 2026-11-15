import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';
const hash=(a,s)=>createHash(a).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
async function fixture(t,reference=''){
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-node-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),donor=path.join(dir,'donor.skshow'),patch=path.join(dir,'donor.skf');
 const program=`<skprogram version="1"><item start="0" name="A" notes=""><graph><node id="n5000" type="action"/></graph><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old"><graph><node id="n3" type="action"/>${reference}</graph></cue></sktimeline></item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><appSettings/><graph/></showkontrol>')}</skshow>`;
 const donorShow=`<skshow>${part('content/Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>')}</skshow>`;
 const patchXml='<showkontrol version="2"><graph><node id="n2" type="action"/></graph></showkontrol>';
 await Promise.all([writeFile(source,show),writeFile(donor,donorShow),writeFile(patch,patchXml)]);
 const cue={action:'copy_timeline_cue_node',index:0,cueId:'c1',donorType:'cue',donor,donorSha256:hash('sha256',donorShow),donorName:'content/Donor.sktl',donorCueId:'d',donorNodeId:'n1'};
 const patchOp={action:'copy_timeline_cue_node',index:0,cueId:'c1',donorType:'patch',donor:patch,donorSha256:hash('sha256',patchXml),donorFormat:'skf',donorNodeId:'n2'};
 return {dir,source,destination,show,cue,patchOp,args:{source,destination,sha256:hash('sha256',show)}};
}
test('copies both donor types with fresh IDs and edits a receipt',async t=>{
 const f=await fixture(t);const result=await compose({...f.args,operations:[f.cue,f.patchOp,{action:'edit_copied_timeline_node_setting',index:0,nodeFromOperation:0,key:'trigger.path',value:'new'}]});
 assert.deepEqual(result.copiedCueNodes.map(x=>x.nodeId),['n5001','n5002']);
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;assert.match(xml,/>new<\/setting>/);assert.equal(await readFile(f.source,'utf8'),f.show);
});
test('removes an unreferenced node and rejects references',async t=>{
 const f=await fixture(t);await compose({...f.args,operations:[{action:'remove_timeline_cue_node',index:0,cueId:'c1',nodeId:'n3'}]});
 assert.doesNotMatch((await readShowPart({file:f.destination,name:'content/Program.skpr'})).text,/id="n3"/);
 const g=await fixture(t,'<wire fromNode="n3" toNode="n3"/>');await assert.rejects(compose({...g.args,operations:[{action:'remove_timeline_cue_node',index:0,cueId:'c1',nodeId:'n3'}]}));
});
test('rejects stale donors and invalidates node receipts with rollback',async t=>{
 for(const stale of [true,false]){const f=await fixture(t);const op=stale?{...f.cue,donorSha256:'0'.repeat(64)}:f.cue;
 const operations=stale?[op]:[op,{action:'remove_timeline_cue_node',index:0,cueId:'c1',nodeId:'n5001'},{action:'edit_copied_timeline_node_setting',index:0,nodeFromOperation:0,key:'trigger.path',value:'new'}];
 await assert.rejects(compose({...f.args,operations}));await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.deepEqual((await readdir(f.dir)).sort(),['donor.skf','donor.skshow','in.skshow']);}
});
test('node removal invalidates graph receipts',async t=>{
 const f=await fixture(t);
 const operations=[{action:'remove_timeline_cue_graph',index:0,cueId:'c1'},{action:'assemble_timeline_cue_graph',index:0,cueId:'c1',nodes:[{kind:'cue',template:f.cue.donor,templateSha256:f.cue.donorSha256,templateName:f.cue.donorName,templateCueId:'d',nodeId:'n1'}]},{action:'remove_timeline_cue_node',index:0,cueId:'c1',nodeId:'n5001'},{action:'edit_assembled_timeline_graph_setting',index:0,graphFromOperation:1,nodeIndex:0,key:'trigger.path',value:'new'}];
 await assert.rejects(compose({...f.args,operations}),/active prior/);await assert.rejects(readFile(f.destination),{code:'ENOENT'});
});
