import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {copyCueGraphInShow,copyCueGraphBetweenTimelines} from './timeline.js';
import {copyCueGraphNodeShowCopy} from './cue-node-copy.js';
import {copyPatchNodeToCueShowCopy} from './patch-node-to-cue.js';

const hash=s=>createHash('sha256').update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${createHash('md5').update(s).digest('hex')}">${Buffer.from(s).toString('base64')}</part>`;
test('copy operations report stopped values with destination IDs and preserve inputs',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'copy-stopped-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const name='track.sktl',target='<sktimeline version="1"><cue id="target"/><cue id="other"><graph><node id="n9" stopped="1"/></graph></cue></sktimeline>',donor='<sktimeline version="1"><cue id="source"><graph><node id="n1" type="trigger" stopped="1"><settings><setting key="node.stopped">true</setting></settings></node><node id="n2" type="action" stopped="0"><settings><setting key="node.stopped">false</setting></settings></node></graph></cue></sktimeline>';
 const show=`<skshow>${part(name,target)}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`,donorShow=`<skshow>${part(name,donor)}</skshow>`,patch='<showkontrol version="2"><graph><node id="n1" type="trigger" stopped="1"><settings><setting key="node.stopped">true</setting></settings></node></graph></showkontrol>';
 const source=path.join(dir,'target.skshow'),template=path.join(dir,'donor.skshow'),sourceTl=path.join(dir,'target.sktl'),donorTl=path.join(dir,'donor.sktl'),patchFile=path.join(dir,'donor.skf');
 for(const [file,data] of [[source,show],[template,donorShow],[sourceTl,target],[donorTl,donor],[patchFile,patch]])await writeFile(file,data);
 const check=(result,partName,id)=>{assert.equal(result.warnings.length,1);assert.equal(result.warnings[0].code,'stored_stopped_cue_node');assert.deepEqual(result.warnings[0].scope,{part:partName,path:'sktimeline/cue/graph',cueIndex:0,cueId:'target',nodeId:id});};
 const graph=await copyCueGraphInShow({source,destination:path.join(dir,'graph.skshow'),sha256:hash(show),name,template,templateSha256:hash(donorShow),sourceCueId:'source',targetCueId:'target'});check(graph,name,graph.idMap.n1);
 const standalone=path.join(dir,'out.sktl');const graphTl=await copyCueGraphBetweenTimelines({source:sourceTl,destination:standalone,sha256:hash(target),template:donorTl,templateSha256:hash(donor),sourceCueId:'source',targetCueId:'target'});check(graphTl,standalone,graphTl.idMap.n1);
 const nodeTarget=target.replace('<cue id="target"/>','<cue id="target"><graph/></cue>'),nodeShow=`<skshow>${part(name,nodeTarget)}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`;await writeFile(source,nodeShow);
 const cue=await copyCueGraphNodeShowCopy({source,destination:path.join(dir,'node.skshow'),sha256:hash(nodeShow),name,cueId:'target',template,templateSha256:hash(donorShow),templateName:name,templateCueId:'source',nodeId:'n1'});check(cue,name,cue.newNodeId);
 const copiedPatch=await copyPatchNodeToCueShowCopy({source,destination:path.join(dir,'patch.skshow'),sha256:hash(nodeShow),name,cueId:'target',template:patchFile,templateFormat:'skf',templateSha256:hash(patch),nodeId:'n1'});check(copiedPatch,name,copiedPatch.newNodeId);
 assert.equal(await readFile(source,'utf8'),nodeShow);assert.equal(await readFile(template,'utf8'),donorShow);assert.equal(await readFile(sourceTl,'utf8'),target);assert.equal(await readFile(donorTl,'utf8'),donor);assert.equal(await readFile(patchFile,'utf8'),patch);
});

test('batch and assembly operations aggregate warnings for remapped nodes',async t=>{
 const {copyCueGraphsInShow}=await import('./batch-graphs.js');
 const {assembleCueGraphShowCopy}=await import('./cue-graph-assemble.js');
 const {assembleMixedCueGraphShowCopy}=await import('./cue-graph-mixed.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'aggregate-stopped-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const name='track.sktl',target='<sktimeline version="1"><cue id="a"/><cue id="b"/></sktimeline>',donor='<sktimeline version="1"><cue id="src"><graph><node id="n1" type="trigger" stopped="1"><settings/></node><node id="n2" type="action"><settings><setting key="node.stopped">true</setting></settings></node></graph></cue></sktimeline>',patch='<showkontrol version="2"><graph><node id="n3" type="action" stopped="1"><settings/></node></graph></showkontrol>';
 const show=`<skshow>${part(name,target)}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`,donorShow=`<skshow>${part(name,donor)}</skshow>`,source=path.join(dir,'source.skshow'),template=path.join(dir,'donor.skshow'),patchFile=path.join(dir,'donor.skf');await writeFile(source,show);await writeFile(template,donorShow);await writeFile(patchFile,patch);
 const common={source,sha256:hash(show),name},donorArgs={template,templateSha256:hash(donorShow),templateName:name,templateCueId:'src'};
 const batch=await copyCueGraphsInShow({source,sha256:hash(show),destination:path.join(dir,'batch.skshow'),copies:['a','b'].map(targetCueId=>({name,template,templateSha256:hash(donorShow),sourceCueId:'src',targetCueId}))});
 assert.deepEqual(batch.warnings.map(w=>[w.scope.cueId,w.scope.nodeId]),batch.copies.flatMap(c=>[[c.targetCueId,c.idMap.n1],[c.targetCueId,c.idMap.n2]]));
 const assembled=await assembleCueGraphShowCopy({...common,destination:path.join(dir,'assembled.skshow'),cueId:'a',nodes:['n1','n2'].map(nodeId=>({...donorArgs,nodeId})),wires:[{from:0,to:1}]});
 assert.deepEqual(assembled.warnings.map(w=>w.scope.nodeId),assembled.nodeIds);assert.ok(assembled.warnings.every(w=>w.scope.cueId==='a'));
 const mixed=await assembleMixedCueGraphShowCopy({...common,destination:path.join(dir,'mixed.skshow'),cueId:'b',nodes:[{kind:'cue',...donorArgs,nodeId:'n1'},{kind:'patch',template:patchFile,templateFormat:'skf',templateSha256:hash(patch),nodeId:'n3'}],wires:[{from:0,to:1}]});
 assert.deepEqual(mixed.warnings.map(w=>w.scope.nodeId),mixed.nodeIds);assert.ok(mixed.warnings.every(w=>w.scope.cueId==='b'));
 assert.equal(await readFile(source,'utf8'),show);assert.equal(await readFile(template,'utf8'),donorShow);assert.equal(await readFile(patchFile,'utf8'),patch);
});
