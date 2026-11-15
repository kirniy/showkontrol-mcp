import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {inspectTimeline} from './timeline.js';
test('inspect version 1 timeline without assuming cue nesting',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-timeline-'));t.after(()=>rm(dir,{recursive:true,force:true}));let file=path.join(dir,'track.sktl');
 await writeFile(file,'<?xml version="1.0"?><sktimeline version="1" name="Track"><layers><layer name="Layer 1"/></layers><audio name="Audio 1" follow="0"/></sktimeline>');
 const r=await inspectTimeline({file});assert.equal(r.attributes.name,'Track');assert.deepEqual(r.layers,[{name:'Layer 1'}]);assert.deepEqual(r.audio,[{name:'Audio 1',follow:'0'}]);assert.deepEqual(r.cueElements,[]);assert.equal(r.sha256.length,64);
 await writeFile(file,'<sktimeline version="2"/>');await assert.rejects(inspectTimeline({file}),/version 1/);
});
import {addTimelineCueCopy} from './timeline.js';
import {readFile} from 'node:fs/promises';
test('add cue to timeline copy with escaped label and preserve source',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-cue-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.sktl'),destination=path.join(dir,'out.sktl');const xml='<sktimeline version="1"><layers><layer name="Layer 1"/></layers><audio name="Audio 1"/></sktimeline>';await writeFile(source,xml);
 const before=await inspectTimeline({file:source});const result=await addTimelineCueCopy({source,destination,sha256:before.sha256,layer:0,startMs:1234,lengthMs:40,label:'Light & "GO"'});const after=await inspectTimeline({file:destination});
 assert.equal(await readFile(source,'utf8'),xml);assert.equal(after.cueElements.length,1);assert.deepEqual(after.cueElements[0].attributes,{id:result.id,layer:'0',startMs:'1234',lenMs:'40',label:'Light & "GO"'});
 await assert.rejects(addTimelineCueCopy({source,destination,sha256:before.sha256,layer:0,startMs:0,lengthMs:40,label:'x'}),/EEXIST/);
 await assert.rejects(addTimelineCueCopy({source,destination:path.join(dir,'bad'),sha256:before.sha256,layer:1,startMs:0,lengthMs:40,label:'x'}),/outside/);
});
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP adds a cue to a new timeline file',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-cue-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.sktl'),destination=path.join(dir,'out.sktl');await writeFile(source,'<sktimeline version="1"><layers><layer name="Layer 1"/></layers></sktimeline>');
 const client=new Client({name:'cue-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 let read=await client.callTool({name:'showkontrol_inspect_timeline',arguments:{file:source}});const sha256=JSON.parse(read.content[0].text).sha256;
 const result=await client.callTool({name:'showkontrol_add_timeline_cue_copy',arguments:{source,destination,sha256,layer:0,startMs:100,lengthMs:250,label:'Test'}});assert.equal(result.isError,undefined);
 read=await client.callTool({name:'showkontrol_inspect_timeline',arguments:{file:destination}});assert.equal(JSON.parse(read.content[0].text).cueElements[0].attributes.label,'Test');
});
import {inspectShowTimeline,addShowTimelineCueCopy} from './timeline.js';
import {createHash} from 'node:crypto';
test('archive cue copy updates the timeline checksum and preserves unrelated parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-cue-show-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'input.skshow'),destination=path.join(dir,'output.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const untouched=part('patch.skf','<showkontrol version="2"/>');const original=`<skshow>${untouched}${part('content/Track.sktl','<sktimeline version="1"><layers><layer name="Layer 1"/></layers></sktimeline>')}</skshow>`;await writeFile(source,original);
 const before=await inspectShowTimeline({file:source,name:'content/Track.sktl'});const args={source,destination,sha256:before.sha256,name:'content/Track.sktl',layer:0,startMs:5000,lengthMs:2000,label:'Generated'};
 const result=await addShowTimelineCueCopy(args);const after=await inspectShowTimeline({file:destination,name:args.name});assert.equal(after.cueElements[0].attributes.id,result.id);assert.equal(after.cueElements[0].attributes.startMs,'5000');assert.equal(after.cueElements[0].attributes.lenMs,'2000');
 assert.ok((await readFile(destination,'utf8')).includes(untouched));assert.equal(await readFile(source,'utf8'),original);await assert.rejects(addShowTimelineCueCopy(args),/EEXIST/);await assert.rejects(addShowTimelineCueCopy({...args,destination:path.join(dir,'stale.skshow'),sha256:'0'.repeat(64)}),/changed/);
});
import {inspectCueGraph,copyCueGraphInShow} from './timeline.js';
test('copy fixture cue graph remaps node and wire IDs and preserves source',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-cue-graph-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const patch=part('patch.skf','<showkontrol version="2"><graph><node id="n200"/></graph></showkontrol>');
 const timeline='<sktimeline version="1"><layers><layer name="Layer 1"/></layers><cue id="source" layer="0" startMs="0" lenMs="40" label="A"><graph><node id="n1" type="groupin"><settings/></node><node id="n2" type="trigger"><settings><setting key="trigger.path">cue.active</setting></settings></node><node id="n3" type="action"><settings><setting key="action.category">Application</setting></settings></node><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/><connection fromNode="n2" fromPin="0" toNode="n3" toPin="0"/></graph></cue><cue id="target" layer="0" startMs="5000" lenMs="2000" label="B"/></sktimeline>';
 const original=`<skshow>${patch}${part('content/Track.sktl',timeline)}</skshow>`;await writeFile(source,original);const before=await inspectShowTimeline({file:source,name:'content/Track.sktl'});
 const args={source,destination,sha256:before.sha256,name:'content/Track.sktl',sourceCueId:'source',targetCueId:'target'};const result=await copyCueGraphInShow(args);assert.deepEqual(result.idMap,{n1:'n201',n2:'n202',n3:'n203'});
 const graph=(await inspectCueGraph({file:destination,format:'skshow',name:args.name,cueId:'target'})).graph;assert.deepEqual(graph.nodes.map(n=>n.id),['n201','n202','n203']);assert.equal(graph.nodes[1].settings[0].value,'cue.active');assert.deepEqual(graph.connections.map(c=>[c.fromNode,c.toNode]),[['n201','n202'],['n202','n203']]);
 assert.equal(await readFile(source,'utf8'),original);assert.ok((await readFile(destination,'utf8')).includes(patch));await assert.rejects(copyCueGraphInShow(args),/EEXIST/);await assert.rejects(copyCueGraphInShow({...args,destination:path.join(dir,'bad'),targetCueId:'source'}),/different/);
});
import {editTimelineCueCopy} from './timeline.js';
test('edit cue fields preserves graph, source and unrelated archive parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-edit-cue-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const patch=part('patch.skf','<showkontrol version="2"/>');
 const graph='<graph><node id="n1" type="groupin"><settings/></node></graph>';
 const timeline=`<sktimeline version="1"><layers><layer name="one"/><layer name="two"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Old">${graph}</cue></sktimeline>`;
 const original=`<skshow>${patch}${part('content/Track.sktl',timeline)}</skshow>`;await writeFile(source,original);
 const before=await inspectShowTimeline({file:source,name:'content/Track.sktl'});
 const args={source,destination,format:'skshow',sha256:before.sha256,name:'content/Track.sktl',cueId:'c1',layer:1,startMs:100,lengthMs:250,label:`Light & 'GO'`};
 await editTimelineCueCopy(args);
 const after=await inspectShowTimeline({file:destination,name:args.name});
 assert.deepEqual(after.cueElements[0].attributes,{id:'c1',layer:'1',startMs:'100',lenMs:'250',label:`Light & 'GO'`});
 assert.equal((await inspectCueGraph({file:destination,format:'skshow',name:args.name,cueId:'c1'})).graph.nodes[0].id,'n1');
 assert.ok((await readFile(destination,'utf8')).includes(patch));assert.equal(await readFile(source,'utf8'),original);
 await assert.rejects(editTimelineCueCopy(args),/EEXIST/);
 await assert.rejects(editTimelineCueCopy({...args,destination:path.join(dir,'stale'),sha256:'0'.repeat(64)}),/changed/);
 await assert.rejects(editTimelineCueCopy({...args,destination:path.join(dir,'bad'),layer:2}),/outside/);
});
test('edit standalone cue rejects ambiguous IDs and missing fields',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-edit-cue-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.sktl');
 await writeFile(source,'<sktimeline version="1"><layers><layer name="one"/></layers><cue id="x" layer="0" startMs="0" lenMs="40" label="one"/><cue id="x" layer="0" startMs="1" lenMs="40" label="two"/></sktimeline>');
 const {sha256}=await inspectTimeline({file:source});await assert.rejects(editTimelineCueCopy({source,destination:path.join(dir,'out'),format:'sktl',sha256,cueId:'x',label:'new'}),/exactly once/);
});
import {createShowTrackCopy} from './timeline.js';
test('create track from empty saved timeline preserves all existing parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-track-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const template='<?xml version="1.0" encoding="UTF-8"?><sktimeline version="1" name="Track 2" fps="25" fpsdef="1" offsetMs="0" smpteMs="0" media="" mediaWave="" mediaGrid="" mediaPps="75" mediaStructS="" mediaStructE="" mediaStructL=""><titles/><layers><layer name="Layer 1"/><layer name="Layer 2"/><layer name="Layer 3"/><layer name="Layer 4"/></layers><audio name="Audio 1" follow="0"/></sktimeline>';
 const existing=part('content/Track_2.sktl',template),setlist=part('content/Setlist.skls','<sksetlist version="2" active="0"><set name="Set 1"><entry track="Track"/></set></sksetlist>');
 const patch=part('patch.skf','<showkontrol version="2"/>');const original=`<skshow>${existing}${setlist}${patch}</skshow>`;await writeFile(source,original);
 const {sha256}=await inspectShowTimeline({file:source,name:'content/Track_2.sktl'});const args={source,destination,sha256,templateName:'content/Track_2.sktl',trackName:'New Track',partName:'content/New_Track.sktl'};
 await createShowTrackCopy(args);const result=await inspectShowTimeline({file:destination,name:args.partName});assert.equal(result.attributes.name,'New Track');assert.equal(result.layers.length,4);assert.equal(result.cueElements.length,0);
 const output=await readFile(destination,'utf8');assert.ok(output.includes(existing));assert.ok(output.includes(setlist));assert.ok(output.indexOf('content/New_Track.sktl')<output.indexOf('patch.skf'));assert.equal(await readFile(source,'utf8'),original);
 await assert.rejects(createShowTrackCopy(args),/EEXIST/);
 await assert.rejects(createShowTrackCopy({...args,destination:path.join(dir,'dup'),trackName:'track 2'}),/already exists/);
 await assert.rejects(createShowTrackCopy({...args,destination:path.join(dir,'bad'),partName:'content/../bad.sktl'}),/Part name/);
 await assert.rejects(createShowTrackCopy({...args,destination:path.join(dir,'stale'),sha256:'0'.repeat(64)}),/changed/);
});
import {deleteTimelineCueCopy} from './timeline.js';
test('move a cue to another layer without changing its ID or graph',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-move-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.sktl'),destination=path.join(dir,'out.sktl');
 const graph='<graph><node id="n154" type="groupin" x="60" y="140" title="Cue" layer="-1" kind=""><settings/></node></graph>';
 await writeFile(source,`<sktimeline version="1"><layers><layer name="Layer 1"/><layer name="Layer 2"/></layers><cue id="c1" layer="0" startMs="0.0" lenMs="40.0" label="Cue">${graph}</cue></sktimeline>`);
 const {sha256}=await inspectTimeline({file:source});await editTimelineCueCopy({source,destination,format:'sktl',sha256,cueId:'c1',layer:1});
 const out=await readFile(destination,'utf8');assert.ok(out.includes(graph));const cue=(await inspectTimeline({file:destination})).cueElements[0];assert.equal(cue.attributes.id,'c1');assert.equal(cue.attributes.layer,'1');
});
test('delete cue in archive requires explicit graph deletion and preserves other parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-delete-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const patch=part('patch.skf','<showkontrol version="2"/>');const timeline='<sktimeline version="1"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0.0" lenMs="40.0" label="Cue"><graph><node id="n154" type="groupin"><settings/></node></graph></cue><cue id="c2" layer="0" startMs="5000.0" lenMs="2000.0" label="Other"/></sktimeline>';const original=`<skshow>${part('content/Track.sktl',timeline)}${patch}</skshow>`;await writeFile(source,original);
 const name='content/Track.sktl',{sha256}=await inspectShowTimeline({file:source,name});const args={source,destination,format:'skshow',sha256,name,cueId:'c1'};
 await assert.rejects(deleteTimelineCueCopy(args),/action graph/);const result=await deleteTimelineCueCopy({...args,deleteGraph:true});assert.equal(result.deletedGraph,true);
 const after=await inspectShowTimeline({file:destination,name});assert.deepEqual(after.cueElements.map(c=>c.attributes.id),['c2']);assert.ok((await readFile(destination,'utf8')).includes(patch));assert.equal(await readFile(source,'utf8'),original);
 await assert.rejects(deleteTimelineCueCopy({...args,deleteGraph:true}),/EEXIST/);await assert.rejects(deleteTimelineCueCopy({...args,destination:path.join(dir,'stale'),sha256:'0'.repeat(64)}),/changed/);
});
test('edit and delete cues when labels contain literal greater-than signs',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-cue-quoted-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.sktl'),edited=path.join(dir,'edit.sktl'),deleted=path.join(dir,'delete.sktl');
 const xml=`<sktimeline version="1"><layers><layer name="one"/><layer name="two"/></layers><cue id="other" layer="0" startMs="0" lenMs="40" label="A > B"/><cue id="target" layer="0" startMs="40" lenMs="40" label='C > D'><graph><node id="n1" type="groupin"><settings/></node></graph></cue></sktimeline>`;await writeFile(source,xml);const {sha256}=await inspectTimeline({file:source});
 await editTimelineCueCopy({source,destination:edited,format:'sktl',sha256,cueId:'target',layer:1});const info=await inspectTimeline({file:edited});assert.equal(info.cueElements[1].attributes.layer,'1');assert.equal(info.cueElements[1].attributes.label,'C > D');
 await deleteTimelineCueCopy({source,destination:deleted,format:'sktl',sha256,cueId:'target',deleteGraph:true});const after=await inspectTimeline({file:deleted});assert.deepEqual(after.cueElements.map(c=>c.attributes.id),['other']);assert.equal(after.cueElements[0].attributes.label,'A > B');
});
