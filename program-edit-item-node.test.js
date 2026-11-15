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
 const cue={action:'copy_item_graph_node',index:0,donorType:'cue',donor,donorSha256:hash('sha256',donorShow),donorName:'content/Donor.sktl',donorCueId:'d',donorNodeId:'n1'};
 const patchOp={action:'copy_item_graph_node',index:0,donorType:'patch',donor:patch,donorSha256:hash('sha256',patchXml),donorFormat:'skf',donorNodeId:'n2'};
 return {dir,source,destination,show,cue,patchOp,args:{source,destination,sha256:hash('sha256',show)}};
}
test('copies cue and patch nodes, allocates IDs and edits copied node',async t=>{
 const f=await fixture(t);const result=await compose({...f.args,operations:[f.cue,f.patchOp,{action:'edit_copied_item_node_setting',index:0,nodeFromOperation:0,key:'trigger.path',value:'new'}]});
 assert.deepEqual(result.copiedItemNodes.map(x=>x.nodeId),['n5001','n5002']);
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;assert.match(xml,/>new<\/setting>/);assert.equal(await readFile(f.source,'utf8'),f.show);
});
test('removal rejects references and stale receipts with atomic cleanup',async t=>{
 for(const operations of [f=>[{action:'remove_item_graph_node',index:0,nodeId:'n5000'}],f=>[f.cue,{action:'remove_item_graph_node',index:0,nodeId:'n5001'},{action:'edit_copied_item_node_setting',index:0,nodeFromOperation:0,key:'trigger.path',value:'new'}],f=>[{...f.cue,donorSha256:'0'.repeat(64)}]]){
  const f=await fixture(t,operations.toString().includes('n5000')?'<wire fromNode="n5000" toNode="n3"/>':'');
  await assert.rejects(compose({...f.args,operations:operations(f)}));await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.deepEqual((await readdir(f.dir)).sort(),['donor.skf','donor.skshow','in.skshow']);
 }
});
test('removes only the matching receipt',async t=>{
 const f=await fixture(t);const result=await compose({...f.args,operations:[f.cue,f.cue,{action:'remove_item_graph_node',index:0,nodeId:'n5001'},{action:'edit_copied_item_node_setting',index:0,nodeFromOperation:1,key:'trigger.path',value:'kept'}]});
 assert.equal(result.copiedItemNodes[1].nodeId,'n5002');assert.match((await readShowPart({file:f.destination,name:'content/Program.skpr'})).text,/>kept<\/setting>/);
});
test('receipt follows the item after an index shift',async t=>{
 const f=await fixture(t);const show=await readFile(f.source,'utf8');
 const updated=show.replace(/<\/part><part name="patch.skf"/, '</part><part name="patch.skf"');
 const program=(await readShowPart({file:f.source,name:'content/Program.skpr'})).text;
 const shifted=program.replace('<item start="0"', '<item start="0" name="Empty" notes=""/><item start="0"');
 const replacement=updated.replace(part('content/Program.skpr',program),part('content/Program.skpr',shifted));await writeFile(f.source,replacement);
 await compose({...f.args,sha256:hash('sha256',replacement),operations:[{...f.cue,index:1},{action:'remove',index:0},{action:'edit_copied_item_node_setting',index:0,nodeFromOperation:0,key:'trigger.path',value:'shifted'}]});
 assert.match((await readShowPart({file:f.destination,name:'content/Program.skpr'})).text,/>shifted<\/setting>/);
});
test('removal checks references in supported show parts',async t=>{
 const f=await fixture(t);const show=f.show.replace('</skshow>',`${part('content/Refs.skcp','<refs target="n5000"/>')}</skshow>`);await writeFile(f.source,show);
 await assert.rejects(compose({...f.args,sha256:hash('sha256',show),operations:[{action:'remove_item_graph_node',index:0,nodeId:'n5000'}]}),/surviving XML references/);
 await assert.rejects(readFile(f.destination),{code:'ENOENT'});
});
test('rejects nested and duplicate node structures during removal',async t=>{
 for(const graph of ['<graph><node id="n5000" type="action"/><group><node id="n8" type="action"/></group></graph>','<graph><node id="n5000" type="action"/><node id="n5000" type="action"/></graph>']){
  const f=await fixture(t);const program=(await readShowPart({file:f.source,name:'content/Program.skpr'})).text;
  const modified=program.replace('<graph><node id="n5000" type="action"/></graph>',graph);
  const show=f.show.replace(part('content/Program.skpr',program),part('content/Program.skpr',modified));await writeFile(f.source,show);
  await assert.rejects(compose({...f.args,sha256:hash('sha256',show),operations:[{action:'remove_item_graph_node',index:0,nodeId:'n5000'}]}));
  await assert.rejects(readFile(f.destination),{code:'ENOENT'});
 }
});
test('adding a node preserves assembled graph receipts for settings and wires',async t=>{
 const f=await fixture(t);const program=(await readShowPart({file:f.source,name:'content/Program.skpr'})).text;
 const modified=program.replace('<graph><node id="n5000" type="action"/></graph>','');
 const show=f.show.replace(part('content/Program.skpr',program),part('content/Program.skpr',modified));await writeFile(f.source,show);
 const nodes=[{kind:'cue',template:f.cue.donor,templateSha256:f.cue.donorSha256,templateName:f.cue.donorName,templateCueId:f.cue.donorCueId,nodeId:f.cue.donorNodeId},{kind:'patch',template:f.patchOp.donor,templateSha256:f.patchOp.donorSha256,templateFormat:'skf',nodeId:'n2'}];
 const assemble={action:'assemble_item_graph',index:0,nodes};
 const edit={action:'edit_assembled_item_graph_setting',index:0,graphFromOperation:0,nodeIndex:0,key:'trigger.path',value:'retained'};
 const wire={action:'edit_item_graph_wire',index:0,operation:'add',from:{graphFromOperation:0,nodeIndex:0},to:{graphFromOperation:0,nodeIndex:1}};
 const result=await compose({...f.args,sha256:hash('sha256',show),operations:[assemble,f.cue,edit,wire]});
 const ids=result.assembledItemGraphs[0].nodeIds,xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.match(xml,/>retained<\/setting>/);assert.ok(xml.includes(`fromNode="${ids[0]}" fromPin="0" toNode="${ids[1]}"`));
 const unrelated=path.join(f.dir,'unrelated.skshow');
 const afterRemoval=await compose({...f.args,sha256:hash('sha256',show),destination:unrelated,operations:[assemble,f.cue,{action:'remove_item_graph_node',index:0,nodeId:result.copiedItemNodes[0].nodeId},edit]});
 const retained=(await readShowPart({file:unrelated,name:'content/Program.skpr'})).text;
 assert.match(retained,/>retained<\/setting>/);assert.equal(afterRemoval.assembledItemGraphs[0].operationIndex,0);
 const failed=path.join(f.dir,'removed.skshow');
 await assert.rejects(compose({...f.args,sha256:hash('sha256',show),destination:failed,operations:[assemble,f.cue,{action:'remove_item_graph_node',index:0,nodeId:ids[0]},edit]}),/active prior assemble_item_graph/);
 await assert.rejects(readFile(failed),{code:'ENOENT'});
});
