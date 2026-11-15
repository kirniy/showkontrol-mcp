import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';
const hash=(algorithm,text)=>createHash(algorithm).update(text).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'created-node-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),donor=path.join(dir,'donor.skshow');
 const timeline='<sktimeline version="1"><layers><layer name="Base"/></layers></sktimeline>';
 const program=`<skprogram version="1"><item start="0" name="blank" notes=""/><item start="1" name="target" notes="">${timeline}</item><item start="2" name="other" notes="">${timeline}</item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><appSettings/><graph/></showkontrol>')}</skshow>`;
 const donorShow=`<skshow>${part('content/Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n10" type="trigger"/><node id="n11" type="action"/></graph></cue></sktimeline>')}</skshow>`;
 await Promise.all([writeFile(source,show),writeFile(donor,donorShow)]);
 const add={action:'add_timeline_cue',index:1,layer:0,startMs:0,lengthMs:50,label:'New'};
 const assembly={action:'assemble_timeline_cue_graph',index:1,cueFromOperation:0,nodes:[{kind:'cue',template:donor,templateSha256:hash('sha256',donorShow),templateName:'content/Donor.sktl',templateCueId:'d',nodeId:'n11'}]};
 const copy={action:'copy_timeline_cue_node',index:1,cueFromOperation:0,donorType:'cue',donor,donorSha256:hash('sha256',donorShow),donorName:'content/Donor.sktl',donorCueId:'d',donorNodeId:'n10'};
 const wire={action:'edit_timeline_graph_wire_mapped',index:1,cueFromOperation:0,operation:'add',from:{nodeFromOperation:2},to:{nodeId:'n12'}};
 return {source,destination,show,add,assembly,copy,wire,args:{source,destination,sha256:hash('sha256',show)}};
}
test('created cue selector supports node copy and mapped wire after an item shift',async t=>{
 const f=await fixture(t);
 const result=await compose({...f.args,operations:[f.add,f.assembly,f.copy,{action:'remove',index:0},{...f.wire,index:0}]});
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.ok(xml.includes(`fromNode="${result.copiedCueNodes[0].nodeId}" fromPin="0" toNode="n12" toPin="0"`));
 assert.equal(await readFile(f.source,'utf8'),f.show);
});
test('created cue selectors reject invalid and stale references with rollback',async t=>{
 for(const scenario of ['copy both','copy neither','wire both','wire neither','copy future','wire future','copy wrong item','wire wrong item','stale node','later failure']){
  const f=await fixture(t);let ops=[f.add,f.assembly,f.copy];
  const copy={...f.copy},wire={...f.wire};
  if(scenario==='copy both'){copy.cueId='c1';ops=[f.add,f.assembly,copy];}
  if(scenario==='copy neither'){delete copy.cueFromOperation;ops=[f.add,f.assembly,copy];}
  if(scenario==='wire both'){wire.cueId='c1';ops.push(wire);}
  if(scenario==='wire neither'){delete wire.cueFromOperation;ops.push(wire);}
  if(scenario==='copy future'){copy.cueFromOperation=2;ops=[f.add,f.assembly,copy];}
  if(scenario==='wire future'){wire.cueFromOperation=3;ops.push(wire);}
  if(scenario==='copy wrong item'){copy.index=2;ops=[f.add,f.assembly,copy];}
  if(scenario==='wire wrong item'){wire.index=2;ops.push(wire);}
  if(scenario==='stale node')ops.push({action:'remove',index:1,allowContentRemoval:true},{...wire,index:1});
  if(scenario==='later failure')ops.push(wire,{action:'edit',index:99,name:'bad'});
  const expected=scenario.includes('both')||scenario.includes('neither')?/exactly one/:scenario.includes('future')?/prior add_timeline_cue/:scenario.includes('wrong item')||scenario==='stale node'?/selected current item/:/Item index out of range/;
  await assert.rejects(compose({...f.args,operations:ops}),expected);
  await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.equal(await readFile(f.source,'utf8'),f.show);
 }
});
test('mapped node receipt must belong to the selected created cue',async t=>{
 const f=await fixture(t);
 const second={...f.add,startMs:100,label:'Second'};
 const assembly={...f.assembly,cueFromOperation:3};
 const wire={...f.wire,cueFromOperation:3};
 await assert.rejects(compose({...f.args,operations:[f.add,f.assembly,f.copy,second,assembly,wire]}),/active prior copy_timeline_cue_node in the selected cue/);
 await assert.rejects(readFile(f.destination),{code:'ENOENT'});
 assert.equal(await readFile(f.source,'utf8'),f.show);
});
