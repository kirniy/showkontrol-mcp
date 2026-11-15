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
 const dir=await mkdtemp(path.join(os.tmpdir(),'mapped-wire-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),donor=path.join(dir,'donor.skshow');
 const program='<skprogram version="1"><item start="0" name="blank" notes=""/><item start="1" name="target" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="A"><graph><node id="n1" type="trigger"/><node id="n2" type="action"/></graph></cue><cue id="c2" layer="0" startMs="100" lenMs="100" label="B"><graph><node id="n3" type="action"/></graph></cue></sktimeline></item></skprogram>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><appSettings/><graph/></showkontrol>')}</skshow>`;
 const donorShow=`<skshow>${part('content/Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n10" type="trigger"/><node id="n11" type="action"/></graph></cue></sktimeline>')}</skshow>`;
 await Promise.all([writeFile(source,show),writeFile(donor,donorShow)]);
 const copy=(node,index=1)=>({action:'copy_timeline_cue_node',index,cueId:'c1',donorType:'cue',donor,donorSha256:hash('sha256',donorShow),donorName:'content/Donor.sktl',donorCueId:'d',donorNodeId:node});
 const wire=(from,to,operation='add',index=1,cueId='c1')=>({action:'edit_timeline_graph_wire_mapped',index,cueId,operation,from,to});
 return {source,destination,show,copy,wire,args:{source,destination,sha256:hash('sha256',show)}};
}
test('mapped wires resolve two receipts and mixed endpoints after item indices shift',async t=>{
 const f=await fixture(t),ops=[f.copy('n10'),f.copy('n11'),{action:'remove',index:0},f.wire({nodeFromOperation:0},{nodeFromOperation:1},'add',0),f.wire({nodeFromOperation:0},{nodeId:'n2'},'add',0),f.wire({nodeId:'n1'},{nodeFromOperation:1},'add',0)];
 // Remove the first connection before reusing its input.
 ops.splice(5,0,f.wire({nodeFromOperation:0},{nodeFromOperation:1},'remove',0));
 const result=await compose({...f.args,operations:ops});
 const [trigger,action]=result.copiedCueNodes.map(x=>x.nodeId),xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.ok(xml.includes(`fromNode="${trigger}" fromPin="0" toNode="n2" toPin="0"`));
 assert.ok(xml.includes(`fromNode="n1" fromPin="0" toNode="${action}" toPin="0"`));
 assert.ok(result.warnings.some(w=>w.includes('fixture-supported pin 0 connection')));
 assert.equal(await readFile(f.source,'utf8'),f.show);
});
test('mapped wires reject stale, wrong cue, occupied inputs and malformed endpoints with rollback',async t=>{
 for(const scenario of ['stale','wrong cue','occupied','future','malformed','later failure']){
  const f=await fixture(t);let ops=[f.copy('n10')];
  if(scenario==='stale')ops.push({action:'remove_timeline_cue_node',index:1,cueId:'c1',nodeId:'n11'},f.wire({nodeFromOperation:0},{nodeId:'n2'}));
  if(scenario==='wrong cue')ops.push(f.wire({nodeFromOperation:0},{nodeId:'n3'},'add',1,'c2'));
  if(scenario==='occupied')ops.push(f.wire({nodeId:'n1'},{nodeId:'n2'}),f.wire({nodeFromOperation:0},{nodeId:'n2'}));
  if(scenario==='future')ops.push(f.wire({nodeFromOperation:1},{nodeId:'n2'}));
  if(scenario==='malformed')ops.push(f.wire({nodeId:'n1',nodeFromOperation:0},{nodeId:'n2'}));
  if(scenario==='later failure')ops.push(f.wire({nodeFromOperation:0},{nodeId:'n2'}),{action:'edit',index:99,name:'bad'});
  await assert.rejects(compose({...f.args,operations:ops}),scenario==='stale'||scenario==='wrong cue'||scenario==='future'?/active prior/:scenario==='occupied'?/already connected/:scenario==='malformed'?/exactly one/:/Item index out of range/);
  await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.equal(await readFile(f.source,'utf8'),f.show);
 }
});
test('removing one copied node preserves the other receipt',async t=>{
 const f=await fixture(t),remove={action:'remove_timeline_cue_node',index:1,cueId:'c1',nodeId:'n11'};
 const result=await compose({...f.args,operations:[f.copy('n10'),f.copy('n11'),remove,f.wire({nodeId:'n1'},{nodeFromOperation:1})]});
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.ok(xml.includes(`fromNode="n1" fromPin="0" toNode="${result.copiedCueNodes[1].nodeId}" toPin="0"`));
});
test('item removal invalidates copied node receipts',async t=>{
 const f=await fixture(t),ops=[f.copy('n10'),{action:'remove',index:1,allowContentRemoval:true},{action:'edit_copied_timeline_node_setting',index:0,nodeFromOperation:0,key:'trigger.path',value:'new'}];
 await assert.rejects(compose({...f.args,operations:ops}),/active prior copy_timeline_cue_node/);
 await assert.rejects(readFile(f.destination),{code:'ENOENT'});
});
test('reused node IDs do not revive removed receipts',async t=>{
 const f=await fixture(t),remove={action:'remove_timeline_cue_node',index:1,cueId:'c1',nodeId:'n11'};
 const prefix=[f.copy('n10'),remove,f.copy('n10')];
 await assert.rejects(compose({...f.args,operations:[...prefix,f.wire({nodeFromOperation:0},{nodeId:'n2'})]}),/active prior copy_timeline_cue_node/);
 await assert.rejects(readFile(f.destination),{code:'ENOENT'});
 const result=await compose({...f.args,operations:[...prefix,f.wire({nodeFromOperation:2},{nodeId:'n2'})]});
 assert.deepEqual(result.copiedCueNodes.map(node=>node.nodeId),['n11','n11']);
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.ok(xml.includes('fromNode="n11" fromPin="0" toNode="n2" toPin="0"'));
});
