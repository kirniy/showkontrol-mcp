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
test('adds and removes wires after item index shifts and preserves surrounding XML',async t=>{
 const {f,nodes,args}=await fixture(t);
 const add={action:'edit_item_graph_wire',index:0,operation:'add',from:{graphFromOperation:0,nodeIndex:0},to:{graphFromOperation:0,nodeIndex:1}};
 const result=await compose({...args,operations:[{action:'assemble_item_graph',index:1,nodes},{action:'remove',index:0},add]});
 const ids=result.assembledItemGraphs[0].nodeIds;
 await extractShowProgramCopy({source:args.destination,destination:f('add.skpr'),sha256:result.sha256});
 const added=await readFile(f('add.skpr'),'utf8');assert.ok(added.includes(`fromNode="${ids[0]}" fromPin="0" toNode="${ids[1]}"`));
 const removed=await compose({source:args.destination,destination:f('removed.skshow'),sha256:result.sha256,operations:[{action:'edit_item_graph_wire',index:0,operation:'remove',from:{nodeId:ids[0]},to:{nodeId:ids[1]}}]});
 await extractShowProgramCopy({source:f('removed.skshow'),destination:f('removed.skpr'),sha256:removed.sha256});
 const final=await readFile(f('removed.skpr'),'utf8');assert.equal(final,added.replace(`<connection fromNode="${ids[0]}" fromPin="0" toNode="${ids[1]}" toPin="0"/>`,''));
});
test('rejects invalid, occupied, wrong-item and stale selections with atomic rollback',async t=>{
 const {dir,nodes,args}=await fixture(t);const assemble={action:'assemble_item_graph',index:0,nodes};
 const ep=i=>({graphFromOperation:0,nodeIndex:i});
 const wire=(from,to,extra={})=>({action:'edit_item_graph_wire',index:0,operation:'add',from,to,...extra});
 for(const operations of [
  [assemble,wire(ep(1),ep(0))],
  [{...assemble,wires:[{from:0,to:1}]},wire(ep(0),ep(1))],
  [assemble,wire(ep(0),ep(1),{index:1})],
  [assemble,wire(ep(0),ep(2))],
  [assemble,{...assemble,replaceExisting:true},wire(ep(0),ep(1))],
  [assemble,wire({nodeId:'n999'},ep(1))],
  [assemble,wire({nodeId:'n1',nodeIndex:0},ep(1))],
  [assemble,wire(ep(0),ep(1),{operation:'remove'})],
  [{...assemble,nodes:[{...nodes[0],templateSha256:'0'.repeat(64)}]},wire(ep(0),ep(1))],
 ]){await assert.rejects(compose({...args,operations}));await assert.rejects(readFile(args.destination),{code:'ENOENT'});}
 assert.deepEqual((await readdir(dir)).sort(),['cue.skshow','in.skshow','patch.skf']);
});
test('edits an existing item graph without changing its timeline or external references',async t=>{
 const {f,args}=await fixture(t);const show=await readFile(args.source,'utf8');
 const old='<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""/></skprogram>';
 const graph='<graph><node id="n1" type="groupin"/><node id="n2" type="groupin"/><node id="n3" type="trigger"/></graph>';
 const timeline='<sktimeline version="1"><layers/><cue id="kept"/></sktimeline>';
 const program=`<skprogram version="1"><item start="0" name="A" notes="">${graph}${timeline}</item><item start="1" name="B" notes=""/></skprogram>`;
 const reference='<references target="n1"/>';
 const updated=show.replace(part('content/Program.skpr',old),part('content/Program.skpr',program)).replace('</skshow>',`${part('content/References.skcp',reference)}</skshow>`);await writeFile(args.source,updated);
 const sourceSha=hash('sha256',updated),wire=(from,operation='add')=>({action:'edit_item_graph_wire',index:0,operation,from:{nodeId:from},to:{nodeId:'n3'}});
 const result=await compose({...args,sha256:sourceSha,operations:[wire('n1')]});
 await extractShowProgramCopy({source:args.destination,destination:f('direct.skpr'),sha256:result.sha256});
 const output=await readFile(f('direct.skpr'),'utf8');assert.equal(output,program.replace('</graph>','<connection fromNode="n1" fromPin="0" toNode="n3" toPin="0"/></graph>'));
 const outputShow=await readFile(args.destination,'utf8');assert.ok(outputShow.includes(part('content/References.skcp',reference)));
 await assert.rejects(compose({source:args.destination,destination:f('occupied.skshow'),sha256:result.sha256,operations:[wire('n2')]}),/already connected/);
 await assert.rejects(readFile(f('occupied.skshow')),{code:'ENOENT'});
});
