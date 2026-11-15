import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';import {createHash} from 'node:crypto';import os from 'node:os';import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';import {readShowPart} from './xml-copy.js';
const hash=(a,s)=>createHash(a).update(s).digest('hex');const part=(n,s)=>`<part name="${n}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'wire-assembled-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),donor=path.join(dir,'donor.skshow');
 const program='<skprogram version="1"><item start="0" name="A" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="A"/><cue id="c2" layer="0" startMs="100" lenMs="100" label="B"><graph><node id="n3" type="trigger"/><node id="n4" type="action"/></graph></cue></sktimeline></item></skprogram>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><appSettings/><graph/></showkontrol>')}</skshow>`;
 const donorShow=`<skshow>${part('content/Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n10" type="groupin"/><node id="n11" type="trigger"/><node id="n12" type="action"/></graph></cue></sktimeline>')}</skshow>`;await Promise.all([writeFile(source,show),writeFile(donor,donorShow)]);
 const template={template:donor,templateSha256:hash('sha256',donorShow),templateName:'content/Donor.sktl',templateCueId:'d'};
 const assemble={action:'assemble_timeline_cue_graph',index:0,cueId:'c1',nodes:[{kind:'cue',...template,nodeId:'n10'}]};
 const copy=id=>({action:'copy_timeline_cue_node',index:0,cueId:'c1',donorType:'cue',donor,donorSha256:template.templateSha256,donorName:template.templateName,donorCueId:'d',donorNodeId:id});
 const wire=(from,to,cueId='c1')=>({action:'edit_timeline_graph_wire_mapped',index:0,cueId,operation:'add',from,to});
 return {dir,source,destination,show,assemble,copy,wire,args:{source,destination,sha256:hash('sha256',show)}};
}
test('wires an assembled group input to copied trigger and action',async t=>{
 const f=await fixture(t),ops=[f.assemble,f.copy('n11'),f.copy('n12'),f.wire({graphFromOperation:0,nodeIndex:0},{nodeFromOperation:1}),f.wire({nodeFromOperation:1},{nodeFromOperation:2})];
 const result=await compose({...f.args,operations:ops});const [group]=result.assembledCueGraphs[0].nodeIds,[trigger,action]=result.copiedCueNodes.map(n=>n.nodeId);const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.ok(xml.includes(`fromNode="${group}" fromPin="0" toNode="${trigger}" toPin="0"`));assert.ok(xml.includes(`fromNode="${trigger}" fromPin="0" toNode="${action}" toPin="0"`));
});
test('rejects invalid, wrong cue and removed assembled receipts with rollback',async t=>{
 for(const kind of ['wrong cue','removed graph','removed node','future','range','missing index','mixed','item removed']){
  const f=await fixture(t);const ops=[f.assemble];let ep={graphFromOperation:0,nodeIndex:0},cue='c1';
  if(kind==='wrong cue')cue='c2';
  if(kind==='removed graph')ops.push({action:'remove_timeline_cue_graph',index:0,cueId:'c1'});
  if(kind==='removed node')ops.push({action:'remove_timeline_cue_node',index:0,cueId:'c1',nodeId:'n11'});
  if(kind==='future')ep.graphFromOperation=ops.length;
  if(kind==='range')ep.nodeIndex=1;
  if(kind==='missing index')delete ep.nodeIndex;
  if(kind==='mixed')ep.nodeId='n3';
  if(kind==='item removed')ops.push({action:'remove',index:0,allowContentRemoval:true},{action:'add',start:0,name:'new',notes:''});
  ops.push(f.wire(ep,{nodeId:'n3'},cue));await assert.rejects(compose({...f.args,operations:ops}),['wrong cue','removed graph','removed node','future','range'].includes(kind)?/active prior assemble_timeline_cue_graph/:undefined);await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.equal(await readFile(f.source,'utf8'),f.show);assert.deepEqual((await readdir(f.dir)).sort(),['donor.skshow','in.skshow']);
 }
});
test('recreating a graph with the same node ID does not revive its old receipt',async t=>{
 const f=await fixture(t),remove={action:'remove_timeline_cue_graph',index:0,cueId:'c1'};
 const prefix=[f.assemble,remove,f.assemble,f.copy('n11')];
 await assert.rejects(compose({...f.args,operations:[...prefix,f.wire({graphFromOperation:0,nodeIndex:0},{nodeFromOperation:3})]}),/active prior assemble_timeline_cue_graph/);
 await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.equal(await readFile(f.source,'utf8'),f.show);
 const result=await compose({...f.args,operations:[...prefix,f.wire({graphFromOperation:2,nodeIndex:0},{nodeFromOperation:3})]});
 assert.deepEqual(result.assembledCueGraphs.map(g=>g.nodeIds),[['n11'],['n11']]);
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.ok(xml.includes(`fromNode="n11" fromPin="0" toNode="${result.copiedCueNodes[0].nodeId}" toPin="0"`));assert.equal(await readFile(f.source,'utf8'),f.show);
});
