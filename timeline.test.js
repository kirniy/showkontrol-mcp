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
 const original=`<skshow>${patch}${part('content/Track.sktl',timeline)}${part('content/Program.skpr','<skprogram><item><graph><node id="n400"/></graph><sktimeline><cue><graph><node id="n500"/></graph></cue></sktimeline></item></skprogram>')}</skshow>`;await writeFile(source,original);const before=await inspectShowTimeline({file:source,name:'content/Track.sktl'});
 const args={source,destination,sha256:before.sha256,name:'content/Track.sktl',sourceCueId:'source',targetCueId:'target'};const result=await copyCueGraphInShow(args);assert.deepEqual(result.idMap,{n1:'n501',n2:'n502',n3:'n503'});
 const graph=(await inspectCueGraph({file:destination,format:'skshow',name:args.name,cueId:'target'})).graph;assert.deepEqual(graph.nodes.map(n=>n.id),['n501','n502','n503']);assert.equal(graph.nodes[1].settings[0].value,'cue.active');assert.deepEqual(graph.connections.map(c=>[c.fromNode,c.toNode]),[['n501','n502'],['n502','n503']]);
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
import {editCueGraphSettingCopy} from './timeline.js';
test('edit an existing fixture cue graph setting and preserve connections and other parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-graph-setting-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const graph='<graph><node id="n154" type="groupin" x="60" y="140" title="Cue" layer="-1" kind=""><settings/></node><node id="n155" type="trigger" x="300" y="140" title="cue_active" layer="-1" kind=""><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node><node id="n156" type="action" x="540" y="140" title="FeedbackBeep" layer="-1" kind=""><settings><setting key="action.category">Application</setting></settings></node><connection fromNode="n154" fromPin="0" toNode="n155" toPin="0"/><connection fromNode="n155" fromPin="0" toNode="n156" toPin="0"/></graph>';
 const timeline=`<sktimeline version="1"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0.0" lenMs="40.0" label="Cue">${graph}</cue></sktimeline>`;const patch=part('patch.skf','<showkontrol version="2"/>');const original=`<skshow>${part('content/Track.sktl',timeline)}${patch}</skshow>`;await writeFile(source,original);
 const name='content/Track.sktl',{sha256}=await inspectShowTimeline({file:source,name});const args={source,destination,format:'skshow',sha256,name,cueId:'c1',nodeId:'n155',key:'trigger.path',value:'cue.test & value'};
 await editCueGraphSettingCopy(args);const result=await inspectCueGraph({file:destination,format:'skshow',name,cueId:'c1'});assert.equal(result.graph.nodes[1].settings[0].value,'cue.test & value');assert.equal(result.graph.nodes[1].settings[1].value,'State On');assert.equal(result.graph.connections.length,2);assert.equal(await readFile(source,'utf8'),original);assert.ok((await readFile(destination,'utf8')).includes(patch));
 await assert.rejects(editCueGraphSettingCopy(args),/EEXIST/);await assert.rejects(editCueGraphSettingCopy({...args,destination:path.join(dir,'stale'),sha256:'0'.repeat(64)}),/changed/);await assert.rejects(editCueGraphSettingCopy({...args,destination:path.join(dir,'missing'),key:'unknown'}),/exactly once/);
});
test('cue graph setting selection ignores similarly named attributes and attribute text',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-graph-select-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.sktl'),destination=path.join(dir,'out.sktl');
 const xml=`<sktimeline version="1"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue"><graph><node id="decoy" data-id="n155" type="trigger"><settings><setting key="trigger.path">leave node</setting></settings></node><node id="n155" type="trigger"><settings><setting key="other" data-key="trigger.path">leave setting</setting><setting key="trigger.path">cue.active</setting></settings></node></graph></cue></sktimeline>`;await writeFile(source,xml);const {sha256}=await inspectTimeline({file:source});
 await editCueGraphSettingCopy({source,destination,format:'sktl',sha256,cueId:'c1',nodeId:'n155',key:'trigger.path',value:'new'});
 const graph=(await inspectCueGraph({file:destination,format:'sktl',cueId:'c1'})).graph;assert.equal(graph.nodes[0].settings[0].value,'leave node');assert.equal(graph.nodes[1].settings[0].value,'leave setting');assert.equal(graph.nodes[1].settings[1].value,'new');
});
import {readShowSnapshot,readSnapshotPart} from './xml-copy.js';
test('timeline archive snapshot keeps all parts and hash tied to one source read',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-snapshot-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'in.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const archive=(track,patch)=>`<skshow>${part('content/Track.sktl',`<sktimeline version="1" name="${track}"/>`)}${part('patch.skf',`<showkontrol version="2" name="${patch}"/>`)}</skshow>`;
 const initial=archive('A','A'),replacement=archive('B','B');await writeFile(file,initial);const snapshot=await readShowSnapshot({file});await writeFile(file,replacement);
 assert.equal(snapshot.sha256,createHash('sha256').update(initial).digest('hex'));assert.match(readSnapshotPart({snapshot,name:'content/Track.sktl'}).text,/name="A"/);assert.match(readSnapshotPart({snapshot,name:'patch.skf'}).text,/name="A"/);
 const next=await inspectShowTimeline({file,name:'content/Track.sktl'});assert.equal(next.attributes.name,'B');assert.equal(next.sha256,createHash('sha256').update(replacement).digest('hex'));
});
test('edit a self-closing cue setting and leave adjacent settings unchanged',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-empty-setting-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.sktl'),destination=path.join(dir,'out.sktl');
 const xml='<sktimeline version="1"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue"><graph><node id="n155" type="trigger"><settings><setting key="trigger.path"/><setting key="trigger.on">State On</setting></settings></node></graph></cue></sktimeline>';await writeFile(source,xml);const {sha256}=await inspectTimeline({file:source});
 assert.equal((await inspectCueGraph({file:source,format:'sktl',cueId:'c1'})).graph.nodes[0].settings[0].value,'');
 await editCueGraphSettingCopy({source,destination,format:'sktl',sha256,cueId:'c1',nodeId:'n155',key:'trigger.path',value:'cue.active'});
 const settings=(await inspectCueGraph({file:destination,format:'sktl',cueId:'c1'})).graph.nodes[0].settings;assert.deepEqual(settings,[{key:'trigger.path',value:'cue.active'},{key:'trigger.on',value:'State On'}]);assert.equal(await readFile(source,'utf8'),xml);
});
test('copy an app-fixture cue graph between tracks in the same show',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-graph-tracks-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const graph='<graph><node id="n154" type="groupin"><settings/></node><node id="n155" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node><node id="n156" type="action"><settings><setting key="action.category">Application</setting></settings></node><connection fromNode="n154" fromPin="0" toNode="n155" toPin="0"/><connection fromNode="n155" fromPin="0" toNode="n156" toPin="0"/></graph>';
 const donor=part('content/Track.sktl',`<sktimeline version="1"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue">${graph}</cue></sktimeline>`),target=part('content/Track_2.sktl','<sktimeline version="1"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue"/></sktimeline>'),patch=part('patch.skf','<showkontrol version="2"><graph><node id="n200"/></graph></showkontrol>');const original=`<skshow>${donor}${target}${patch}</skshow>`;await writeFile(source,original);
 const name='content/Track_2.sktl',{sha256}=await inspectShowTimeline({file:source,name});const args={source,destination,sha256,name,sourceName:'content/Track.sktl',sourceCueId:'c1',targetCueId:'c1'};const result=await copyCueGraphInShow(args);assert.deepEqual(result.idMap,{n154:'n201',n155:'n202',n156:'n203'});
 const copied=(await inspectCueGraph({file:destination,format:'skshow',name,cueId:'c1'})).graph;assert.deepEqual(copied.connections.map(c=>[c.fromNode,c.toNode]),[['n201','n202'],['n202','n203']]);assert.equal(copied.nodes[1].settings[0].value,'cue.active');assert.ok((await readFile(destination,'utf8')).includes(donor));assert.equal(await readFile(source,'utf8'),original);
 await assert.rejects(copyCueGraphInShow({...args,destination:path.join(dir,'bad'),sourceName:name}),/different/);
});
test('cue graph copy uses actual IDs rather than ID-like text inside labels',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-cue-id-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),name='Track.sktl';
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const timeline=`<sktimeline version="1"><cue id="decoySource" label=" id='s'"><graph><node id="n9" type="action"><settings/></node></graph></cue><cue id = "s"><graph><node id="n1" type="trigger"><settings/></node></graph></cue><cue id="decoyTarget" label=" id='t'"/><cue id = "t"/></sktimeline>`;
 await writeFile(source,`<skshow>${part(name,timeline)}</skshow>`);
 const before=await inspectShowTimeline({file:source,name});
 await copyCueGraphInShow({source,destination,sha256:before.sha256,name,sourceCueId:'s',targetCueId:'t'});
 const get=cueId=>inspectCueGraph({file:destination,format:'skshow',name,cueId});
 assert.equal((await get('t')).graph.nodes[0].type,'trigger');assert.equal((await get('decoyTarget')).graph,null);
 assert.equal((await get('decoySource')).graph.nodes[0].id,'n9');
});
test('cue graph copy ignores comment, CDATA and nested cue decoys',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-graph-spans-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const decoys='<!-- <cue id="source"><graph><node id="bad"/></graph></cue><cue id="target"/> --><![CDATA[<cue id="source"><graph>fake</graph></cue><cue id="target"/>]]><wrapper><cue id="source"/><cue id="target"/></wrapper>';
 const graph='<graph><node id="n1" type="groupin"><settings/></node><node id="n2" type="trigger"><settings><setting key="trigger.path">cue.active</setting></settings></node><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/></graph>';
 const timeline=`<sktimeline version="1"><layers><layer name="Layer 1"/></layers>${decoys}<cue id="source" layer="0" startMs="0" lenMs="40" label="Source &gt; 😀">${graph}</cue><cue id="target" layer="0" startMs="40" lenMs="40" label="Target"/></sktimeline>`;
 const original=`<skshow>${part('content/Track.sktl',timeline)}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`;await writeFile(source,original);const name='content/Track.sktl',{sha256}=await inspectShowTimeline({file:source,name});
 await copyCueGraphInShow({source,destination,sha256,name,sourceCueId:'source',targetCueId:'target'});
 const target=(await inspectCueGraph({file:destination,format:'skshow',name,cueId:'target'})).graph;assert.equal(target.nodes.length,2);assert.equal(target.connections.length,1);assert.equal(await readFile(source,'utf8'),original);
});
test('copy fixture cue graph from a separately checked template show',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-graph-template-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'target.skshow'),template=path.join(dir,'template.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const graph='<graph><node id="n154" type="groupin"><settings/></node><node id="n155" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node><node id="n156" type="action"><settings><setting key="action.category">Application</setting></settings></node><connection fromNode="n154" fromPin="0" toNode="n155" toPin="0"/><connection fromNode="n155" fromPin="0" toNode="n156" toPin="0"/></graph>';
 const donorXml=`<skshow>${part('content/Donor.sktl',`<sktimeline version="1"><layers><layer name="L"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue">${graph}</cue></sktimeline>`)}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`;
 const patch=part('patch.skf','<showkontrol version="2"><graph><node id="n700"/></graph></showkontrol>');const targetXml=`<skshow>${part('content/Track.sktl','<sktimeline version="1"><layers><layer name="L"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Target"/></sktimeline>')}${patch}</skshow>`;await writeFile(template,donorXml);await writeFile(source,targetXml);
 const name='content/Track.sktl',sourceName='content/Donor.sktl';const targetInfo=await inspectShowTimeline({file:source,name}),donorInfo=await inspectShowTimeline({file:template,name:sourceName});const args={source,destination,sha256:targetInfo.sha256,template,templateSha256:donorInfo.sha256,name,sourceName,sourceCueId:'c1',targetCueId:'c1'};
 const result=await copyCueGraphInShow(args);assert.deepEqual(result.idMap,{n154:'n701',n155:'n702',n156:'n703'});const copied=(await inspectCueGraph({file:destination,format:'skshow',name,cueId:'c1'})).graph;assert.deepEqual(copied.connections.map(c=>[c.fromNode,c.toNode]),[['n701','n702'],['n702','n703']]);assert.equal(copied.nodes[1].settings[0].value,'cue.active');assert.ok((await readFile(destination,'utf8')).includes(patch));assert.equal(await readFile(source,'utf8'),targetXml);assert.equal(await readFile(template,'utf8'),donorXml);
 await assert.rejects(copyCueGraphInShow({...args,destination:path.join(dir,'bad'),templateSha256:'0'.repeat(64)}),/Template changed/);await assert.rejects(copyCueGraphInShow({...args,destination:path.join(dir,'bad2'),templateSha256:undefined}),/both template/);
});
test('cue edit rejects attribute-like label text when requested field is absent',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-cue-attr-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.sktl'),destination=path.join(dir,'out.sktl');
 const xml=`<sktimeline version="1"><layers><layer name="L"/></layers><cue id="c1" layer="0" lenMs="40" label=" startMs='0'"/></sktimeline>`;await writeFile(source,xml);const {sha256}=await inspectTimeline({file:source});
 await assert.rejects(editTimelineCueCopy({source,destination,format:'sktl',sha256,cueId:'c1',startMs:5}),/field startMs/);await assert.rejects(readFile(destination),/ENOENT/);assert.equal(await readFile(source,'utf8'),xml);
});
test('cue graph setting edit skips comment decoy and replaces actual CDATA value',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-setting-cdata-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.sktl'),destination=path.join(dir,'out.sktl');
 const xml='<sktimeline version="1"><layers><layer name="L"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue"><graph><node id="n1" type="trigger"><settings><!-- <setting key="trigger.path">fake</setting> --><setting key="trigger.path"><![CDATA[cue.active]]></setting></settings></node></graph></cue></sktimeline>';await writeFile(source,xml);const {sha256}=await inspectTimeline({file:source});
 await editCueGraphSettingCopy({source,destination,format:'sktl',sha256,cueId:'c1',nodeId:'n1',key:'trigger.path',value:'cue.other'});const output=await readFile(destination,'utf8');assert.ok(output.includes('<!-- <setting key="trigger.path">fake</setting> -->'));assert.equal((await inspectCueGraph({file:destination,format:'sktl',cueId:'c1'})).graph.nodes[0].settings[0].value,'cue.other');
});
test('external graph copying allocates above donor IDs when target IDs are lower',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-low-ids-'));t.after(()=>rm(dir,{recursive:true,force:true}));const template=path.join(dir,'donor.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const donor=ids=>`<skshow>${part('content/Donor.sktl',`<sktimeline version="1"><layers><layer name="L"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue"><graph>${ids.map(id=>`<node id="${id}" type="groupin"><settings/></node>`).join('')}</graph></cue></sktimeline>`)}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`;
 const target=patchNode=>`<skshow>${part('content/Track.sktl','<sktimeline version="1"><layers><layer name="L"/></layers><cue id="c2" layer="0" startMs="0" lenMs="40" label="Target"/></sktimeline>')}${part('patch.skf',`<showkontrol version="2"><graph>${patchNode}</graph></showkontrol>`)}</skshow>`;
 for(const [i,donorIds,patchNode,expected] of [[1,['n1'],'',{n1:'n2'}],[2,['n1','n2'],'<node id="n1"/>',{n1:'n3',n2:'n4'}]]){
  const source=path.join(dir,`target${i}.skshow`),destination=path.join(dir,`out${i}.skshow`);await writeFile(template,donor(donorIds));await writeFile(source,target(patchNode));
  const name='content/Track.sktl',sourceName='content/Donor.sktl',targetInfo=await inspectShowTimeline({file:source,name}),donorInfo=await inspectShowTimeline({file:template,name:sourceName});
  const result=await copyCueGraphInShow({source,destination,sha256:targetInfo.sha256,template,templateSha256:donorInfo.sha256,name,sourceName,sourceCueId:'c1',targetCueId:'c2'});assert.deepEqual(result.idMap,expected);
  assert.deepEqual((await inspectCueGraph({file:destination,format:'skshow',name,cueId:'c2'})).graph.nodes.map(n=>n.id),Object.values(expected));
 }
});
import {copyCueGraphBetweenTimelines} from './timeline.js';
test('copy fixture graph between standalone timelines with independent hashes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-standalone-graph-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'target.sktl'),template=path.join(dir,'donor.sktl'),destination=path.join(dir,'out.sktl');
 const graph='<graph><node id="n1" type="groupin"><settings/></node><node id="n2" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node><node id="n3" type="action"><settings><setting key="action.category">Application</setting></settings></node><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/><connection fromNode="n2" fromPin="0" toNode="n3" toPin="0"/></graph>';
 const donor=`<sktimeline version="1"><layers><layer name="L"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Source">${graph}</cue></sktimeline>`,target='<sktimeline version="1"><layers><layer name="L"/></layers><cue id="c2" layer="0" startMs="0" lenMs="40" label="Target"/></sktimeline>';await writeFile(source,target);await writeFile(template,donor);
 const a=await inspectTimeline({file:source}),b=await inspectTimeline({file:template});const args={source,destination,sha256:a.sha256,template,templateSha256:b.sha256,sourceCueId:'c1',targetCueId:'c2'};const r=await copyCueGraphBetweenTimelines(args);assert.deepEqual(r.idMap,{n1:'n4',n2:'n5',n3:'n6'});
 const result=(await inspectCueGraph({file:destination,format:'sktl',cueId:'c2'})).graph;assert.equal(result.nodes[1].settings[0].value,'cue.active');assert.deepEqual(result.connections.map(c=>[c.fromNode,c.toNode]),[['n4','n5'],['n5','n6']]);assert.equal(await readFile(source,'utf8'),target);assert.equal(await readFile(template,'utf8'),donor);
 await assert.rejects(copyCueGraphBetweenTimelines({...args,destination:path.join(dir,'bad'),templateSha256:'0'.repeat(64)}),/Template changed/);
});
test('track creation targets actual timeline name instead of text inside info',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-track-name-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const template='<sktimeline version="1" info=" name=\'fake\'" name="Track 2"><titles/><layers><layer name="Layer 1"/></layers><audio name="Audio 1" follow="0"/></sktimeline>';
 await writeFile(source,`<skshow>${part('content/Track_2.sktl',template)}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`);const {sha256}=await inspectShowTimeline({file:source,name:'content/Track_2.sktl'});
 await createShowTrackCopy({source,destination,sha256,templateName:'content/Track_2.sktl',trackName:'New Track',partName:'content/New_Track.sktl'});
 const info=await inspectShowTimeline({file:destination,name:'content/New_Track.sktl'});assert.equal(info.attributes.name,'New Track');assert.equal(info.attributes.info," name='fake'");
});
import {removeCueGraphCopy} from './timeline.js';
test('remove a fixture cue graph while preserving cue fields and other parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-remove-graph-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const graph='<graph><node id="n154" type="groupin"><settings/></node><node id="n155" type="trigger"><settings><setting key="trigger.path">cue.active</setting></settings></node><connection fromNode="n154" fromPin="0" toNode="n155" toPin="0"/></graph>';
 const timeline=`<sktimeline version="1"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0.0" lenMs="40.0" label="Cue"><!-- <graph>decoy</graph> -->${graph}</cue></sktimeline>`,patch=part('patch.skf','<showkontrol version="2"/>'),original=`<skshow>${part('content/Track.sktl',timeline)}${patch}</skshow>`;await writeFile(source,original);
 const name='content/Track.sktl',before=await inspectShowTimeline({file:source,name}),args={source,destination,format:'skshow',sha256:before.sha256,name,cueId:'c1'};const result=await removeCueGraphCopy(args);assert.equal(result.removedNodeCount,2);assert.equal(result.removedConnectionCount,1);
 const after=await inspectShowTimeline({file:destination,name});assert.deepEqual(after.cueElements,before.cueElements);assert.equal((await inspectCueGraph({file:destination,format:'skshow',name,cueId:'c1'})).graph,null);assert.ok((await readFile(destination,'utf8')).includes(patch));assert.equal(await readFile(source,'utf8'),original);
 await assert.rejects(removeCueGraphCopy(args),/EEXIST/);await assert.rejects(removeCueGraphCopy({...args,destination:path.join(dir,'stale'),sha256:'0'.repeat(64)}),/changed/);
 const updated=await inspectShowTimeline({file:destination,name});await assert.rejects(removeCueGraphCopy({...args,source:destination,destination:path.join(dir,'missing'),sha256:updated.sha256}),/no action graph/);
});
test('replace a removed graph in paired cues for shows and standalone timelines',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-replace-graph-'));t.after(()=>rm(dir,{recursive:true,force:true}));const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const graph='<graph><node id="n1" type="groupin"><settings/></node><node id="n2" type="trigger"><settings><setting key="trigger.path">cue.active</setting></settings></node><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/></graph>',donor=`<sktimeline version="1"><layers><layer name="L"/></layers><cue id="src" layer="0" startMs="0" lenMs="40" label="Source">${graph}</cue></sktimeline>`,target=`<sktimeline version="1"><layers><layer name="L"/></layers><cue id="dst" layer="0" startMs="0" lenMs="40" label="Target"> \n ${graph} \n </cue></sktimeline>`;
 const template=path.join(dir,'donor.sktl'),source=path.join(dir,'target.sktl'),removed=path.join(dir,'removed.sktl'),output=path.join(dir,'output.sktl');await writeFile(template,donor);await writeFile(source,target);const original=await inspectTimeline({file:source});await removeCueGraphCopy({source,destination:removed,format:'sktl',sha256:original.sha256,cueId:'dst'});
 const empty=await inspectTimeline({file:removed}),templateInfo=await inspectTimeline({file:template});await copyCueGraphBetweenTimelines({source:removed,destination:output,sha256:empty.sha256,template,templateSha256:templateInfo.sha256,sourceCueId:'src',targetCueId:'dst'});assert.equal((await inspectCueGraph({file:output,format:'sktl',cueId:'dst'})).graph.connections.length,1);
 const show=path.join(dir,'show.skshow'),showRemoved=path.join(dir,'show-removed.skshow'),showOutput=path.join(dir,'show-output.skshow'),name='content/Track.sktl';await writeFile(show,`<skshow>${part(name,target.replace('</sktimeline>',`<cue id="src" layer="0" startMs="100" lenMs="40" label="Source">${graph.replaceAll('n1','n10').replaceAll('n2','n20')}</cue></sktimeline>`))}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`);
 const showInfo=await inspectShowTimeline({file:show,name});await removeCueGraphCopy({source:show,destination:showRemoved,format:'skshow',sha256:showInfo.sha256,name,cueId:'dst'});const showEmpty=await inspectShowTimeline({file:showRemoved,name});await copyCueGraphInShow({source:showRemoved,destination:showOutput,sha256:showEmpty.sha256,name,sourceCueId:'src',targetCueId:'dst'});assert.equal((await inspectCueGraph({file:showOutput,format:'skshow',name,cueId:'dst'})).graph.connections.length,1);
});
test('graph copy rejects paired target cues with non-whitespace contents',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-nonempty-graph-'));t.after(()=>rm(dir,{recursive:true,force:true}));const template=path.join(dir,'donor.sktl'),source=path.join(dir,'target.sktl');
 await writeFile(template,'<sktimeline version="1"><cue id="src"><graph><node id="n1" type="groupin"><settings/></node></graph></cue></sktimeline>');await writeFile(source,'<sktimeline version="1"><cue id="dst"><!-- preserve --></cue></sktimeline>');const a=await inspectTimeline({file:source}),b=await inspectTimeline({file:template});
 await assert.rejects(copyCueGraphBetweenTimelines({source,destination:path.join(dir,'out'),sha256:a.sha256,template,templateSha256:b.sha256,sourceCueId:'src',targetCueId:'dst'}),/only whitespace/);
});
test('cue creation preserves tab, newline and carriage return in label',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-cue-label-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.sktl'),destination=path.join(dir,'out.sktl');await writeFile(source,'<sktimeline version="1"><layers><layer name="L"/></layers></sktimeline>');const {sha256}=await inspectTimeline({file:source});
 const label='A\tB\nC\rD';await addTimelineCueCopy({source,destination,sha256,layer:0,startMs:0,lengthMs:40,label});const result=await inspectTimeline({file:destination});assert.equal(result.cueElements[0].attributes.label,label);const xml=await readFile(destination,'utf8');assert.match(xml,/&#x9;/);assert.match(xml,/&#xA;/);assert.match(xml,/&#xD;/);
});
import {addCueGraphSettingCopy} from './timeline.js';
test('add a fixture-supported setting to an empty cue node settings element',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-add-setting-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.sktl'),destination=path.join(dir,'out.sktl');
 const xml='<sktimeline version="1"><layers><layer name="L"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Cue"><graph><node id="n1" type="trigger"><settings/></node></graph></cue></sktimeline>';await writeFile(source,xml);const {sha256}=await inspectTimeline({file:source});const args={source,destination,format:'sktl',sha256,cueId:'c1',nodeId:'n1',key:'trigger.path',value:'cue.active'};
 await addCueGraphSettingCopy(args);assert.equal((await inspectCueGraph({file:destination,format:'sktl',cueId:'c1'})).graph.nodes[0].settings[0].value,'cue.active');assert.equal(await readFile(source,'utf8'),xml);await assert.rejects(addCueGraphSettingCopy(args),/EEXIST/);
 await assert.rejects(addCueGraphSettingCopy({...args,destination:path.join(dir,'wrong'),key:'action.category'}),/fixture/);await assert.rejects(addCueGraphSettingCopy({...args,destination:path.join(dir,'stale'),sha256:'0'.repeat(64)}),/changed/);
 const info=await inspectTimeline({file:destination});await assert.rejects(addCueGraphSettingCopy({...args,source:destination,destination:path.join(dir,'duplicate'),sha256:info.sha256}),/already exists/);
});
test('graph copies remap only node and connection attributes, preserving metadata',async t=>{
 const {copyCueGraphBetweenTimelines}=await import('./timeline.js');const {readShowPart}=await import('./xml-copy.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-graph-meta-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const graph=`<graph><node id = "n1" type="trigger"><settings><setting key="note" description="metadata">safe</setting></settings></node><connection fromNode = "n1" toNode = "n1"/></graph>`;
 const donor=`<sktimeline version="1"><cue id="s">${graph}</cue></sktimeline>`,target='<sktimeline version="1"><cue id="t"/></sktimeline>';
 const donorFile=path.join(dir,'donor.sktl'),targetFile=path.join(dir,'target.sktl'),out=path.join(dir,'out.sktl');await writeFile(donorFile,donor);await writeFile(targetFile,target);
 const d=await inspectTimeline({file:donorFile}),tgt=await inspectTimeline({file:targetFile});
 const standalone=await copyCueGraphBetweenTimelines({source:targetFile,destination:out,sha256:tgt.sha256,template:donorFile,templateSha256:d.sha256,sourceCueId:'s',targetCueId:'t'});
 const output=await readFile(out,'utf8');assert.ok(output.includes(`description="metadata">safe</setting>`));assert.ok(output.includes(`id = "${standalone.idMap.n1}"`));assert.ok(output.includes(`fromNode = "${standalone.idMap.n1}"`));
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const show=path.join(dir,'show.skshow'),showOut=path.join(dir,'show-out.skshow');await writeFile(show,`<skshow>${part('Track.sktl',`<sktimeline version="1"><cue id="s">${graph}</cue><cue id="t"/></sktimeline>`)}</skshow>`);
 const info=await inspectShowTimeline({file:show,name:'Track.sktl'});await copyCueGraphInShow({source:show,destination:showOut,sha256:info.sha256,name:'Track.sktl',sourceCueId:'s',targetCueId:'t'});
 const xml=(await readShowPart({file:showOut,name:'Track.sktl'})).text;assert.equal(xml.split(`description="metadata">safe</setting>`).length-1,2);
});
