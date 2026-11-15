import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import os from 'node:os';
import {inspectShowTimeline,inspectCueGraph} from './timeline.js';import {copyCueGraphsInShow} from './batch-graphs.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('batch copies same-show and external graphs with distinct IDs',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-graphs-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),template=path.join(dir,'template.skshow'),destination=path.join(dir,'out.skshow');
 const timeline='<sktimeline version="1"><cue id="source"><graph><node id="n1" type="trigger"><settings/></node></graph></cue><cue id="a"/><cue id="b"/></sktimeline>';
 const donor='<sktimeline version="1"><cue id="donor"><graph><node id="n8" type="action"><settings/></node></graph></cue></sktimeline>';
 const input=`<skshow>${part('Track.sktl',timeline)}</skshow>`,templateInput=`<skshow>${part('Donor.sktl',donor)}</skshow>`;await writeFile(source,input);await writeFile(template,templateInput);
 const {sha256}=await inspectShowTimeline({file:source,name:'Track.sktl'}),templateSha256=(await inspectShowTimeline({file:template,name:'Donor.sktl'})).sha256;
 const copies=[{name:'Track.sktl',sourceName:'Track.sktl',sourceCueId:'source',targetCueId:'a'},{name:'Track.sktl',sourceName:'Donor.sktl',sourceCueId:'donor',targetCueId:'b',template,templateSha256}];
 const result=await copyCueGraphsInShow({source,destination,sha256,copies});assert.equal(result.copies.length,2);
 for(let i=0;i<2;i++){const graph=(await inspectCueGraph({file:destination,format:'skshow',name:'Track.sktl',cueId:copies[i].targetCueId})).graph;assert.equal(graph.nodes[0].id,Object.values(result.copies[i].idMap)[0]);}
 assert.notEqual(Object.values(result.copies[0].idMap)[0],Object.values(result.copies[1].idMap)[0]);
 assert.equal(await readFile(source,'utf8'),input);assert.equal(await readFile(template,'utf8'),templateInput);
 await assert.rejects(copyCueGraphsInShow({source,destination,sha256,copies}),{code:'EEXIST'});
 assert.deepEqual((await readdir(dir)).sort(),['in.skshow','out.skshow','template.skshow']);
});
test('batch failure cleans intermediate files and does not publish',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-graphs-fail-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const input=`<skshow>${part('Track.sktl','<sktimeline version="1"><cue id="source"><graph><node id="n1" type="trigger"><settings/></node></graph></cue><cue id="a"/><cue id="b"/></sktimeline>')}</skshow>`;await writeFile(source,input);
 const {sha256}=await inspectShowTimeline({file:source,name:'Track.sktl'});
 const good={name:'Track.sktl',sourceName:'Track.sktl',sourceCueId:'source',targetCueId:'a'};
 await assert.rejects(copyCueGraphsInShow({source,destination,sha256,copies:[good,{...good,targetCueId:'b',template:source,templateSha256:'0'.repeat(64)}]}),/Template changed/);
 await assert.rejects(copyCueGraphsInShow({source,destination,sha256:'0'.repeat(64),copies:[good]}),/Source changed/);
 assert.equal(await readFile(source,'utf8'),input);assert.deepEqual(await readdir(dir),['in.skshow']);
});
