import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile,truncate} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeFullShowCopy as compose} from './compose-full-show.js';
import {inspectShow} from './xml-copy.js';
import {inspectShowSetlist} from './setlist.js';
import {inspectProgramItemGraph,extractProgramTimelineCopy} from './program.js';
import {inspectCueGraph} from './timeline.js';
const hash=(type,text)=>createHash(type).update(text).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'full-show-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const source=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer/></layers></sktimeline>')}${part('Set.skls','<sksetlist version="2"><set name="Main"/></sksetlist>')}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 const donor=`<skshow>${part('Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node><node id="n2" type="trigger"><settings><setting key="trigger.path">second</setting></settings></node></graph></cue></sktimeline>')}</skshow>`;
 await writeFile(f('in.skshow'),source);await writeFile(f('donor.skshow'),donor);
 const cue={layer:0,startMs:0,lengthMs:100,label:'Go'};
 const tracks=[{templateName:'Empty.sktl',trackName:'First',partName:'content/First.sktl',cues:[cue],donor:{file:f('donor.skshow'),sha256:hash('sha256',donor),name:'Donor.sktl',cueId:'d'},set:{name:'Set.skls',setName:'Main'}},{templateName:'Empty.sktl',trackName:'Second',partName:'content/Second.sktl',cues:[cue],set:{name:'Set.skls',setName:'Main'}}];
 return {dir,f,source,donor,args:{source:f('in.skshow'),destination:f('out.skshow'),sha256:hash('sha256',source),tracks,program:{items:[{start:0,name:'Item',notes:'',timeline:{stagedShow:{trackIndex:0},remapCueIds:true},graph:{stagedShow:{trackIndex:0,cueIndex:0}}}]}}};
}
test('composes tracks, set and Program from staged donors',async t=>{
 const {args,f}=await fixture(t);const r=await compose(args);assert.equal(r.sha256,(await inspectShow({file:args.destination})).sha256);assert.deepEqual((await inspectShowSetlist({file:args.destination,name:'Set.skls'})).sets[0].tracks,['First','Second']);
 const cue=r.tracks[0].cues[0];assert.ok(r.program.mappings[0].timeline.cues[cue.id]);assert.notEqual(r.program.mappings[0].timeline.cues[cue.id],cue.id);assert.ok(r.program.mappings[0].graph.nodes[cue.idMap.n1]);
 const graph=await inspectProgramItemGraph({file:args.destination,sha256:r.sha256,index:0});assert.match(JSON.stringify(graph),/old/);await extractProgramTimelineCopy({source:args.destination,destination:f('extracted.sktl'),sha256:r.sha256,index:0});assert.match(await readFile(f('extracted.sktl'),'utf8'),/Go/);
 assert.equal(r.validation.file,args.destination);assert.match(r.validation.note,/before publication/);
});
test('resolves staged graph setting node indices against the composed cue graph',async t=>{
 const {args}=await fixture(t);args.program.items[0].graph.settings=[{nodeIndex:1,key:'trigger.path',value:'item.active'}];
 const r=await compose(args);const graph=await inspectProgramItemGraph({file:args.destination,sha256:r.sha256,index:0});
 assert.equal(graph.graph.nodes[0].settings.find(s=>s.key==='trigger.path').value,'old');assert.equal(graph.graph.nodes[1].settings.find(s=>s.key==='trigger.path').value,'item.active');
});
test('rejects invalid or ambiguous staged graph node selectors',async t=>{
 const {args}=await fixture(t);
 for(const setting of [{nodeIndex:2,key:'trigger.path',value:'x'},{nodeIndex:-1,key:'trigger.path',value:'x'},{nodeIndex:0,nodeId:'n1',key:'trigger.path',value:'x'},{key:'trigger.path',value:'x'}]){
  args.program.items[0].graph.settings=[setting];await assert.rejects(compose(args),/node (index|selector)/);await assert.rejects(readFile(args.destination),{code:'ENOENT'});
 }
});
test('resolves staged timeline settings per item before remapping',async t=>{
 const {args,f}=await fixture(t);
 args.program.items=[0,1].map(index=>({start:index,name:`Item ${index}`,notes:'',timeline:{stagedShow:{trackIndex:0},remapCueIds:true,settings:[{cueIndex:0,nodeIndex:1,key:'trigger.path',value:`item.${index}`}]}}));
 const r=await compose(args);const cue=r.tracks[0].cues[0];
 for(const index of [0,1]){
  const file=f(`timeline-${index}.sktl`);await extractProgramTimelineCopy({source:args.destination,destination:file,sha256:r.sha256,index});
  const mapping=r.program.mappings[index].timeline;const graph=await inspectCueGraph({file,format:'sktl',cueId:mapping.cues[cue.id]});
  assert.equal(graph.graph.nodes.find(n=>n.id===mapping.nodes[cue.idMap.n1]).settings.find(s=>s.key==='trigger.path').value,'old');
  assert.equal(graph.graph.nodes.find(n=>n.id===mapping.nodes[cue.idMap.n2]).settings.find(s=>s.key==='trigger.path').value,`item.${index}`);
 }
});
test('rejects invalid and mixed staged timeline setting selectors without publication',async t=>{
 const {args,dir}=await fixture(t);
 for(const selectors of [{cueIndex:-1,nodeIndex:0},{cueIndex:1,nodeIndex:0},{cueIndex:0,nodeIndex:-1},{cueIndex:0,nodeIndex:2},{cueIndex:0,nodeId:'n1'},{cueId:'d',nodeIndex:0},{cueIndex:0,nodeIndex:0,cueId:'d'},{cueId:'d',nodeId:'n1',nodeIndex:0},{cueIndex:0},{}]){
  args.program.items[0].timeline.settings=[{...selectors,key:'trigger.path',value:'x'}];
  await assert.rejects(compose(args),/Timeline setting|staged timeline/);await assert.rejects(readFile(args.destination),{code:'ENOENT'});
  assert.deepEqual((await readdir(dir)).sort(),['donor.skshow','in.skshow']);
 }
});
test('accepts explicit staged timeline cue and node IDs',async t=>{
 const {args,f}=await fixture(t);
 const source=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer/></layers><cue id="known"><graph><node id="n42" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>')}${part('Set.skls','<sksetlist version="2"><set name="Main"/></sksetlist>')}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 await writeFile(args.source,source);args.sha256=hash('sha256',source);
 args.tracks=[{existingPartName:'Empty.sktl',cues:[{layer:0,startMs:0,lengthMs:100,label:'New'}]}];delete args.program.items[0].graph;
 args.program.items[0].timeline.settings=[{cueId:'known',nodeId:'n42',key:'trigger.path',value:'explicit'}];
 const r=await compose(args);const file=f('explicit.sktl');await extractProgramTimelineCopy({source:args.destination,destination:file,sha256:r.sha256,index:0});
 const mapping=r.program.mappings[0].timeline;const graph=await inspectCueGraph({file,format:'sktl',cueId:mapping.cues.known});
 assert.equal(graph.graph.nodes.find(n=>n.id===mapping.nodes['n42']).settings.find(s=>s.key==='trigger.path').value,'explicit');
});
test('external Program donor, failures, stale input and existing destination',async t=>{
 const {args,f,source,donor,dir}=await fixture(t);const external={donor:f('donor.skshow'),donorName:'Donor.sktl',donorSha256:hash('sha256',donor),donorCueId:'d'};
 const program={items:[{start:0,name:'Item',notes:'',graph:external}]};
 for(const bad of [{sha256:'0'.repeat(64)},{program:{items:[{start:0,name:'Item',notes:'',graph:{...external,donorSha256:'0'.repeat(64)}}]}},{program:{items:[{start:0,name:'Item',notes:'',graph:{stagedShow:{trackIndex:0,cueIndex:0},donorCueId:'d'}}]}},{program:{items:[{start:0,name:'Item',notes:'',graph:{stagedShow:{trackIndex:0,cueIndex:9}}}]}},{tracks:[],program:undefined}]){
  await assert.rejects(compose({...args,...bad}));await assert.rejects(readFile(args.destination),{code:'ENOENT'});assert.deepEqual((await readdir(dir)).sort(),['donor.skshow','in.skshow']);
 }
 const r=await compose({...args,program});assert.ok(r.program.mappings[0].graph.nodes.n1);await assert.rejects(compose({...args,program}),{code:'EEXIST'});assert.equal(await readFile(args.source,'utf8'),source);assert.equal(await readFile(f('donor.skshow'),'utf8'),donor);
});

test('rejects FIFO and oversized external donors without publishing',async t=>{
 const {args,f,dir}=await fixture(t);const fifo=f('pipe.sktl');execFileSync('mkfifo',[fifo]);
 const oversized=f('large.sktl');await writeFile(oversized,'');await truncate(oversized,128*1024*1024+1);
 for(const [file,pattern] of [[fifo,/regular file/],[oversized,/size limit/]]){
  const program={items:[{start:0,name:'Item',notes:'',timeline:{donor:file,donorSha256:'0'.repeat(64)}}]};
  await assert.rejects(compose({...args,program}),pattern);await assert.rejects(readFile(args.destination),{code:'ENOENT'});
 }
 assert.deepEqual((await readdir(dir)).sort(),['donor.skshow','in.skshow','large.sktl','pipe.sktl']);
});
