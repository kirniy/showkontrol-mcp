import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {extractShowProgramCopy} from './program.js';
const hash=(type,s)=>createHash(type).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'item-setting-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const graph='<graph><node id="n1" type="action"><settings><setting key="notify.message">Old</setting></settings></node><node id="n2" type="trigger"><settings/></node><connection fromNode="n2" fromPin="0" toNode="n1" toPin="0"/></graph>';
 const program=`<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes="">${graph}</item></skprogram>`;
 const patch='<showkontrol version="2"><graph><node id="n7" type="router"><settings><setting key="router.name">A</setting></settings></node></graph><appSettings/></showkontrol>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch)}</skshow>`;
 const donor='<showkontrol version="2"><graph><node id="n9" type="action"><settings><setting key="notify.message">New</setting><setting key="notify.title">Title</setting><setting key="route.router_target">A</setting><setting key="bad">n123</setting></settings></node><node id="n10" type="trigger"><settings><setting key="notify.message">Wrong</setting></settings></node></graph><appSettings/></showkontrol>';
 await Promise.all([writeFile(f('in.skshow'),show),writeFile(f('donor.skf'),donor)]);
 return {f,args:{source:f('in.skshow'),destination:f('out.skshow'),sha256:hash('sha256',show)},op:{action:'copy_patch_setting_to_item_graph',index:0,nodeId:'n1',donor:f('donor.skf'),donorFormat:'skf',donorSha256:hash('sha256',donor),donorNodeId:'n9',key:'notify.message'}};
}
test('copies and inserts settings on shifted direct item while retaining graph IDs and wires',async t=>{
 const {f,args,op}=await fixture(t);const result=await compose({...args,operations:[{action:'remove',index:0},op,{...op,key:'notify.title'},{...op,key:'route.router_target'}]});
 await extractShowProgramCopy({source:args.destination,destination:f('out.skpr'),sha256:result.sha256});const xml=await readFile(f('out.skpr'),'utf8');
 for(const s of ['<setting key="notify.message">New</setting>','<setting key="notify.title">Title</setting>','<setting key="route.router_target">A</setting>','fromNode="n2" fromPin="0" toNode="n1" toPin="0"'])assert.ok(xml.includes(s),s);
});
test('rejects invalid donors, node types, references and selectors without output',async t=>{
 const {args,op}=await fixture(t);for(const bad of [{donorSha256:'0'.repeat(64)},{donorNodeId:'n10'},{key:'bad'},{key:'node.stopped'},{nodeId:'n2'},{nodeId:'n404'},{graphFromOperation:0,nodeIndex:0,nodeId:undefined}]){
  const operation={...op,...bad};if(bad.graphFromOperation!==undefined)delete operation.nodeId;
  await assert.rejects(compose({...args,operations:[{action:'remove',index:0},operation]}));await assert.rejects(readFile(args.destination),{code:'ENOENT'});
 }
});
test('resolves a nonzero assembly receipt after an index shift and rejects stale receipts',async t=>{
 const {f,args,op}=await fixture(t);
 const cue='<sktimeline version="1"><cue id="src"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node></graph></cue></sktimeline>';
 const cueShow=`<skshow>${part('content/Donor.sktl',cue)}</skshow>`;
 const patch='<showkontrol version="2"><graph><node id="n228" type="action" x="2603.152" y="120" title="FeedbackNotify" layer="-1" kind=""><settings><setting key="action.category">Application</setting><setting key="action.t7">Feedback/Notify</setting><setting key="notify.title">Test</setting><setting key="notify.message">Message</setting><setting key="notify.web">true</setting><setting key="notify.push">false</setting></settings></node></graph><appSettings/></showkontrol>';
 await Promise.all([writeFile(f('cue.skshow'),cueShow),writeFile(f('assembly.skf'),patch)]);
 const nodes=[{kind:'cue',template:f('cue.skshow'),templateSha256:hash('sha256',cueShow),templateName:'content/Donor.sktl',templateCueId:'src',nodeId:'n1'},{kind:'patch',template:f('assembly.skf'),templateSha256:hash('sha256',patch),templateFormat:'skf',nodeId:'n228'}];
 const assemble={action:'assemble_item_graph',index:1,nodes,replaceExisting:true},mapped={...op,graphFromOperation:1,nodeIndex:1};delete mapped.nodeId;
 const operations=[{action:'edit',index:0,name:'First'},assemble,{action:'remove',index:0},mapped];
 const result=await compose({...args,operations});await extractShowProgramCopy({source:args.destination,destination:f('receipt.skpr'),sha256:result.sha256});const xml=await readFile(f('receipt.skpr'),'utf8');assert.ok(xml.includes(`id="${result.assembledItemGraphs[0].nodeIds[1]}"`));assert.ok(xml.includes('<setting key="notify.message">New</setting>'));
 for(const altered of [{...mapped,graphFromOperation:0},{...mapped,nodeIndex:2},{...mapped,index:1}]){const destination=f('bad.skshow');await assert.rejects(compose({...args,destination,operations:[...operations.slice(0,3),altered]}));await assert.rejects(readFile(destination),{code:'ENOENT'});}
 const destination=f('stale.skshow');await assert.rejects(compose({...args,destination,operations:[...operations.slice(0,2),{...assemble,replaceExisting:true}, {...mapped,index:1}]}),/active prior assemble_item_graph/);await assert.rejects(readFile(destination),{code:'ENOENT'});
});
