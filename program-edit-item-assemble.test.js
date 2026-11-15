import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {extractShowProgramCopy} from './program.js';
const hash=(type,s)=>createHash(type).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'item-assemble-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const program='<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""/></skprogram>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}${part('content/Other.sktl','<sktimeline version="1"><cue id="other"><graph><node id="n30" type="groupin"/></graph></cue></sktimeline>')}</skshow>`;
 const timeline='<sktimeline version="1"><cue id="src"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node></graph></cue></sktimeline>';
 const donor=`<skshow>${part('content/Donor.sktl',timeline)}</skshow>`;
 const patch='<showkontrol version="2"><graph><node id="n228" type="action" x="2603.152" y="120" title="FeedbackNotify" layer="-1" kind=""><settings><setting key="action.category">Application</setting><setting key="action.t7">Feedback/Notify</setting><setting key="notify.title">Test</setting><setting key="notify.message">Message</setting><setting key="notify.web">true</setting><setting key="notify.push">false</setting></settings></node></graph><appSettings/></showkontrol>';
 await Promise.all([writeFile(f('in.skshow'),show),writeFile(f('cue.skshow'),donor),writeFile(f('patch.skf'),patch)]);
 const nodes=[{kind:'cue',template:f('cue.skshow'),templateSha256:hash('sha256',donor),templateName:'content/Donor.sktl',templateCueId:'src',nodeId:'n1'},{kind:'patch',template:f('patch.skf'),templateSha256:hash('sha256',patch),templateFormat:'skf',nodeId:'n228'}];
 return {dir,f,nodes,args:{source:f('in.skshow'),destination:f('out.skshow'),sha256:hash('sha256',show)}};
}
test('assembles mixed nodes, remaps IDs and edits after an item index shift',async t=>{
 const {f,nodes,args}=await fixture(t);
 const result=await compose({...args,operations:[{action:'assemble_item_graph',index:1,nodes,wires:[{from:0,to:1}]},{action:'remove',index:0},{action:'edit_assembled_item_graph_setting',index:0,graphFromOperation:0,nodeIndex:1,key:'notify.message',value:'Updated'}]});
 assert.equal(result.assembledItemGraphs.length,1);const ids=result.assembledItemGraphs[0].nodeIds;assert.equal(new Set(ids).size,2);assert.ok(ids.every(id=>Number(id.slice(1))>30));
 await extractShowProgramCopy({source:args.destination,destination:f('out.skpr'),sha256:result.sha256});const xml=await readFile(f('out.skpr'),'utf8');assert.match(xml,/<setting key="notify.message">Updated<\/setting>/);assert.ok(xml.includes(`fromNode="${ids[0]}"`));assert.ok(xml.includes(`toNode="${ids[1]}"`));
});
test('guards existing graphs, receipt selectors, stale donors and cleans up failures',async t=>{
 const {dir,nodes,args}=await fixture(t);const assemble={action:'assemble_item_graph',index:0,nodes};
 for(const operations of [
  [assemble,assemble],
  [assemble,{action:'edit_assembled_item_graph_setting',index:1,graphFromOperation:0,nodeIndex:0,key:'trigger.on',value:'State Off'}],
  [assemble,{action:'edit_assembled_item_graph_setting',index:0,graphFromOperation:0,nodeIndex:9,key:'trigger.on',value:'State Off'}],
  [assemble,{...assemble,replaceExisting:true},{action:'edit_assembled_item_graph_setting',index:0,graphFromOperation:0,nodeIndex:0,key:'trigger.on',value:'State Off'}],
  [{...assemble,nodes:[{...nodes[0],templateSha256:'0'.repeat(64)}]}],
 ]) {await assert.rejects(compose({...args,operations}));await assert.rejects(readFile(args.destination),{code:'ENOENT'});}
 assert.deepEqual((await readdir(dir)).sort(),['cue.skshow','in.skshow','patch.skf']);
});
test('rejects a donor node whose router target is absent from the target show',async t=>{
 const {f,nodes,args,dir}=await fixture(t);const patch=await readFile(f('patch.skf'),'utf8');const altered=patch.replace('<setting key="notify.title">','<setting key="route.router_target">Missing</setting><setting key="notify.title">');await writeFile(f('patch.skf'),altered);
 const node={...nodes[1],templateSha256:hash('sha256',altered)};
 await assert.rejects(compose({...args,operations:[{action:'assemble_item_graph',index:0,nodes:[node]}]}),/router[_ ]target/i);
 await assert.rejects(readFile(args.destination),{code:'ENOENT'});assert.deepEqual((await readdir(dir)).sort(),['cue.skshow','in.skshow','patch.skf']);
});
test('successfully replaces an assembled graph and edits the new receipt',async t=>{
 const {f,nodes,args}=await fixture(t);
 const result=await compose({...args,operations:[{action:'assemble_item_graph',index:0,nodes},{action:'assemble_item_graph',index:0,nodes,replaceExisting:true},{action:'edit_assembled_item_graph_setting',index:0,graphFromOperation:1,nodeIndex:1,key:'notify.message',value:'Replacement'}]});
 assert.equal(result.assembledItemGraphs.length,2);assert.notDeepEqual(result.assembledItemGraphs[0].nodeIds,result.assembledItemGraphs[1].nodeIds);
 await extractShowProgramCopy({source:args.destination,destination:f('replacement.skpr'),sha256:result.sha256});const xml=await readFile(f('replacement.skpr'),'utf8');assert.match(xml,/<setting key="notify.message">Replacement<\/setting>/);assert.ok(xml.includes(`id="${result.assembledItemGraphs[1].nodeIds[1]}"`));assert.ok(!xml.includes(`id="${result.assembledItemGraphs[0].nodeIds[1]}"`));
});
test('replacement rejects references in skls and skcp parts',async t=>{
 for(const ext of ['skls','skcp']){
  const {f,nodes,args,dir}=await fixture(t);const show=await readFile(args.source,'utf8');
  const oldProgram='<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""/></skprogram>';
  const newProgram='<skprogram version="1"><item start="0" name="A" notes=""><graph><node id="n7" type="groupin"/></graph></item><item start="1" name="B" notes=""/></skprogram>';
  const updated=show.replace(part('content/Program.skpr',oldProgram),part('content/Program.skpr',newProgram)).replace('</skshow>',`${part(`content/References.${ext}`,'<references target="n7"/>')}</skshow>`);await writeFile(args.source,updated);
  await assert.rejects(compose({...args,sha256:hash('sha256',updated),operations:[{action:'assemble_item_graph',index:0,nodes,replaceExisting:true}]}),/referenced outside the graph/);
  await assert.rejects(readFile(args.destination),{code:'ENOENT'});assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
 }
});
test('removed graph receipt stays invalid when later assembly reuses its node IDs',async t=>{
 const {f,nodes,args}=await fixture(t);
 const operations=[{action:'assemble_item_graph',index:0,nodes},{action:'remove',index:0,allowContentRemoval:true},{action:'add',start:2,name:'C',notes:''},{action:'assemble_item_graph',index:1,nodes}];
 const result=await compose({...args,operations});assert.deepEqual(result.assembledItemGraphs[0].nodeIds,result.assembledItemGraphs[1].nodeIds);
 const destination=f('invalid.skshow');await assert.rejects(compose({...args,destination,operations:[...operations,{action:'edit_assembled_item_graph_setting',index:1,graphFromOperation:0,nodeIndex:1,key:'notify.message',value:'Bad'}]}),/active prior assemble_item_graph/);await assert.rejects(readFile(destination),{code:'ENOENT'});
});
