import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';
const hash=(type,s)=>createHash(type).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'item-wire-copied-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=n=>path.join(dir,n);
 const program='<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""/></skprogram>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 const timeline='<sktimeline version="1"><cue id="src"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node></graph></cue></sktimeline>';
 const donor=`<skshow>${part('content/Donor.sktl',timeline)}</skshow>`;
 const patch='<showkontrol version="2"><graph><node id="n228" type="action" title="FeedbackNotify"><settings><setting key="action.category">Application</setting><setting key="action.t7">Feedback/Notify</setting><setting key="notify.title">Test</setting><setting key="notify.message">Message</setting><setting key="notify.web">true</setting><setting key="notify.push">false</setting></settings></node></graph><appSettings/></showkontrol>';
 await Promise.all([writeFile(f('in.skshow'),show),writeFile(f('cue.skshow'),donor),writeFile(f('patch.skf'),patch)]);
 const nodes=[{kind:'cue',template:f('cue.skshow'),templateSha256:hash('sha256',donor),templateName:'content/Donor.sktl',templateCueId:'src',nodeId:'n1'},{kind:'patch',template:f('patch.skf'),templateSha256:hash('sha256',patch),templateFormat:'skf',nodeId:'n228'}];
 const assemble={action:'assemble_item_graph',index:1,nodes};
 const copyTrigger={action:'copy_item_graph_node',index:1,donorType:'cue',donor:f('cue.skshow'),donorSha256:hash('sha256',donor),donorName:'content/Donor.sktl',donorCueId:'src',donorNodeId:'n1'};
 const copyAction={action:'copy_item_graph_node',index:1,donorType:'patch',donor:f('patch.skf'),donorSha256:hash('sha256',patch),donorFormat:'skf',donorNodeId:'n228'};
 return {dir,f,show,assemble,copyTrigger,copyAction,args:{source:f('in.skshow'),destination:f('out.skshow'),sha256:hash('sha256',show)}};
}
const wire=(from,to,index=1)=>({action:'edit_item_graph_wire',index,operation:'add',from,to});
const copied=nodeFromOperation=>({nodeFromOperation});
const assembled=nodeIndex=>({graphFromOperation:0,nodeIndex});
test('wires copied nodes with assembled and direct selectors after an item index shift',async t=>{
 const f=await fixture(t);
 const result=await compose({...f.args,operations:[f.assemble,f.copyTrigger,f.copyAction,{action:'remove',index:0},wire(assembled(0),copied(2),0),wire(copied(1),assembled(1),0)]});
 const [trigger,action]=result.assembledItemGraphs[0].nodeIds;
 const [copyTrigger,copyAction]=result.copiedItemNodes.map(n=>n.nodeId);
 const xml=(await readShowPart({file:f.args.destination,name:'content/Program.skpr'})).text;
 assert.ok(xml.includes(`fromNode="${trigger}" fromPin="0" toNode="${copyAction}" toPin="0"`));
 assert.ok(xml.includes(`fromNode="${copyTrigger}" fromPin="0" toNode="${action}" toPin="0"`));
 const direct=await compose({...f.args,destination:f.f('direct.skshow'),operations:[f.assemble,f.copyAction,wire({nodeId:trigger},copied(1))]});
 assert.ok((await readShowPart({file:f.f('direct.skshow'),name:'content/Program.skpr'})).text.includes(`toNode="${direct.copiedItemNodes[0].nodeId}"`));
});
test('rejects invalid, wrong-item, future and stale copied receipts and cleans up',async t=>{
 const f=await fixture(t);
 const baseline=await compose({...f.args,operations:[f.assemble,f.copyAction]});
 const removal={action:'remove_item_graph_node',index:1,nodeId:baseline.copiedItemNodes[0].nodeId};
 await rm(f.args.destination);
 const cases=[
  [f.assemble,f.copyAction,wire(copied(0),assembled(1))],
  [f.assemble,f.copyAction,wire(assembled(0),copied(2))],
  [f.assemble,f.copyAction,wire(copied(1),assembled(0),0)],
  [f.assemble,f.copyAction,wire(assembled(0),{nodeFromOperation:-1})],
  [f.assemble,f.copyAction,wire(assembled(0),{nodeFromOperation:1,nodeId:'n5002'})],
  [f.assemble,f.copyAction,wire(assembled(0),{nodeFromOperation:1,nodeIndex:0})],
  [f.assemble,f.copyAction,removal,f.copyAction,wire(assembled(0),copied(1))],
  [f.assemble,f.copyAction,{...f.assemble,replaceExisting:true},wire({graphFromOperation:2,nodeIndex:0},copied(1))],
  [f.assemble,f.copyAction,{action:'remove',index:1,allowContentRemoval:true},{...f.assemble,index:0},{...f.copyAction,index:0},wire({graphFromOperation:3,nodeIndex:0},copied(1),0)],
 ];
 for(const operations of cases){await assert.rejects(compose({...f.args,operations}),/nodeFromOperation|Endpoint/);await assert.rejects(readFile(f.args.destination),{code:'ENOENT'});}
 assert.equal(await readFile(f.args.source,'utf8'),f.show);
 assert.deepEqual((await readdir(f.dir)).sort(),['cue.skshow','in.skshow','patch.skf']);
});
test('a removed node receipt stays invalid when its ID is reused',async t=>{
 const f=await fixture(t),baseline=await compose({...f.args,operations:[f.assemble,f.copyAction]});
 const remove={action:'remove_item_graph_node',index:1,nodeId:baseline.copiedItemNodes[0].nodeId};
 await rm(f.args.destination);
 const result=await compose({...f.args,operations:[f.assemble,f.copyAction,remove,f.copyAction,wire(assembled(0),copied(3))]});
 assert.equal(result.copiedItemNodes[0].nodeId,result.copiedItemNodes[1].nodeId);
 const destination=f.f('stale.skshow');
 await assert.rejects(compose({...f.args,destination,operations:[f.assemble,f.copyAction,remove,f.copyAction,wire(assembled(0),copied(1))]}),/active prior copy_item_graph_node/);
 await assert.rejects(readFile(destination),{code:'ENOENT'});
});
