import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';
const hash=(a,s)=>createHash(a).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
async function fixture(t,router=true){
 const dir=await mkdtemp(path.join(os.tmpdir(),'setting-graph-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),graph=path.join(dir,'graph.sktl'),donor=path.join(dir,'patch.skf');
 const program='<skprogram version="1"><item start="0" name="A" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old"/></sktimeline></item><item start="1" name="B" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c2" layer="0" startMs="0" lenMs="100" label="Other"/></sktimeline></item></skprogram>';
 const patch=`<showkontrol version="2"><appSettings/><graph>${router?'<node id="n8" type="router"><settings><setting key="router.name">A</setting></settings></node>':''}</graph></showkontrol>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch)}</skshow>`;
 const graphXml='<sktimeline version="1"><layers/><cue id="d"><graph><node id="n1" type="action"><settings/></node></graph></cue></sktimeline>';
 const graphShow=path.join(dir,'graph.skshow');const graphShowXml=`<skshow>${part('content/Donor.sktl',graphXml)}</skshow>`;
 const donorXml='<showkontrol version="2"><graph><node id="n2" type="action"><settings><setting key="route.router_target">A</setting></settings></node></graph></showkontrol>';
 await Promise.all([writeFile(source,show),writeFile(graph,graphXml),writeFile(graphShow,graphShowXml),writeFile(donor,donorXml)]);
 const common={index:0,cueId:'c1'};
 const copy={action:'copy_timeline_cue_graph',...common,donor:graph,donorSha256:hash('sha256',graphXml),donorCueId:'d'};
 const assemble={action:'assemble_timeline_cue_graph',...common,nodes:[{kind:'cue',template:graphShow,templateSha256:hash('sha256',graphShowXml),templateName:'content/Donor.sktl',templateCueId:'d',nodeId:'n1'}]};
 const setting={action:'copy_patch_setting_to_timeline_cue',...common,donor,donorFormat:'skf',donorSha256:hash('sha256',donorXml),donorNodeId:'n2',key:'route.router_target'};
 return {source,destination,show,args:{source,destination,sha256:hash('sha256',show)},copy,assemble,setting};
}
for(const kind of ['assembled','copied']){
 const selector=kind==='assembled'?{graphFromOperation:0,nodeIndex:0}:{copiedGraphFromOperation:0,copiedGraphDonorNodeId:'n1'};
 test(`${kind} receipt inserts a missing setting and validates router`,async t=>{
  const f=await fixture(t);await compose({...f.args,operations:[f[kind==='assembled'?'assemble':'copy'],{...f.setting,...selector}]});
  const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;assert.match(xml,/<setting key="route.router_target">A<\/setting>/);assert.equal(await readFile(f.source,'utf8'),f.show);
  const bad=await fixture(t,false);await assert.rejects(compose({...bad.args,operations:[bad[kind==='assembled'?'assemble':'copy'],{...bad.setting,...selector}]}),/router target/i);await assert.rejects(readFile(bad.destination),{code:'ENOENT'});
 });
 test(`${kind} receipt rejects invalid, stale and wrong-item selectors atomically`,async t=>{
  for(const mode of ['future','missing','incomplete','stale','wrong-item','mixed','donor-checksum','later']){
   const f=await fixture(t);const op={...f.setting,...selector};const ops=[f[kind==='assembled'?'assemble':'copy']];
   if(mode==='future')op[kind==='assembled'?'graphFromOperation':'copiedGraphFromOperation']=1;
   if(mode==='missing')op[kind==='assembled'?'nodeIndex':'copiedGraphDonorNodeId']=kind==='assembled'?9:'n99';
   if(mode==='incomplete')delete op[kind==='assembled'?'nodeIndex':'copiedGraphDonorNodeId'];
   if(mode==='donor-checksum')op.donorSha256='0'.repeat(64);
   if(mode==='stale')ops.push({action:'remove_timeline_cue_graph',index:0,cueId:'c1'});
   if(mode==='wrong-item'){op.index=1;op.cueId='c2';}
   if(mode==='mixed')op.nodeId='n1';
   ops.push(op);if(mode==='later')ops.push({action:'edit',index:99,name:'bad'});
   await assert.rejects(compose({...f.args,operations:ops}));await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.equal(await readFile(f.source,'utf8'),f.show);
  }
 });
}
test('assembled receipt selects a nonzero node index',async t=>{
 const f=await fixture(t);
 const assemble={...f.assemble,nodes:[f.assemble.nodes[0],f.assemble.nodes[0]]};
 const result=await compose({...f.args,operations:[assemble,{...f.setting,graphFromOperation:0,nodeIndex:1}]});
 const [first,second]=result.assembledCueGraphs[0].nodeIds;
 assert.notEqual(first,second);
 const xml=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 const nodes=[...xml.matchAll(/<node\b[^>]*id="([^"]+)"[^>]*>[\s\S]*?<\/node>/g)];
 const firstNode=nodes.find(match=>match[1]===first),secondNode=nodes.find(match=>match[1]===second);
 assert.ok(firstNode);assert.ok(secondNode);
 assert.doesNotMatch(firstNode[0],/route\.router_target/);
 assert.match(secondNode[0],/<setting key="route.router_target">A<\/setting>/);
});
