import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {inspectShow,readShowSnapshot} from './xml-copy.js';
import {inspectShowTimeline,inspectCueGraph} from './timeline.js';
import {composeShowCopy} from './compose-show.js';

const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('MCP composes on existing timelines and mixes new tracks atomically',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-existing-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow');
 const timeline='<sktimeline version="1" name="Existing"><layers><layer name="Layer 1"/></layers><audio name="Audio 1" follow="0"><file>media/original.wav</file></audio><cue id="c1" layer="0" startMs="0" lenMs="40" label="Original"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">original</setting></settings></node></graph></cue></sktimeline>';
 const input=`<skshow>${part('content/Existing.sktl',timeline)}${part('content/Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="Layer 1"/></layers></sktimeline>')}${part('media/original.wav','media bytes')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 await writeFile(source,input);const sha256=(await inspectShow({file:source})).sha256;
 const client=new Client({name:'existing-compose-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args});const parse=r=>JSON.parse(r.content[0].text);
 const existing={existingPartName:'content/Existing.sktl',donor:{file:source,sha256,name:'content/Existing.sktl',cueId:'c1'},cues:[{layer:0,startMs:100,lengthMs:40,label:'Added',settings:[{nodeId:'n1',key:'trigger.path',value:'added'}]}]};
 const fresh={templateName:'content/Empty.sktl',trackName:'New',partName:'content/New.sktl',cues:[{layer:0,startMs:200,lengthMs:40,label:'New cue'}]};
 for(const multi of [false,true]){
  const destination=path.join(dir,multi?'multi.skshow':'single.skshow');
  const response=await call(multi?'showkontrol_compose_multi_track_show_copy':'showkontrol_compose_show_copy',{source,destination,sha256,...(multi?{tracks:[existing,fresh]}:existing)});
  assert.equal(response.isError,undefined,JSON.stringify(response));assert.equal(parse(response).sha256,(await inspectShow({file:destination})).sha256);
  const output=await readShowSnapshot({file:destination});assert.ok(output.parts.every(p=>p.valid));
  for(const name of ['media/original.wav','patch.skf','content/Empty.sktl'])assert.deepEqual(output.parts.find(p=>p.name===name).bytes,(await readShowSnapshot({file:source})).parts.find(p=>p.name===name).bytes);
  const target=output.parts.find(p=>p.name===existing.existingPartName).bytes.toString();assert.ok(target.includes('<audio name="Audio 1" follow="0"><file>media/original.wav</file></audio>'));assert.ok(target.includes('<cue id="c1" layer="0" startMs="0" lenMs="40" label="Original"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">original</setting></settings></node></graph></cue>'));
  assert.equal((await inspectShowTimeline({file:destination,name:existing.existingPartName})).cueElements.length,2);
  if(multi)assert.equal((await inspectShowTimeline({file:destination,name:fresh.partName})).cueElements.length,1);
  const again=await call(multi?'showkontrol_compose_multi_track_show_copy':'showkontrol_compose_show_copy',{source,destination,sha256,...(multi?{tracks:[existing,fresh]}:existing)});assert.equal(again.isError,true);
 }
 for(const [name,tracks,target,labels] of [
  ['new-then-existing',[fresh,{existingPartName:fresh.partName,cues:[{layer:0,startMs:300,lengthMs:40,label:'Second new cue'}]}],fresh.partName,['New cue','Second new cue']],
  ['repeat-existing',[existing,{existingPartName:existing.existingPartName,cues:[{layer:0,startMs:300,lengthMs:40,label:'Second added'}]}],existing.existingPartName,['Original','Added','Second added']]
 ]){
  const destination=path.join(dir,`${name}.skshow`);
  const response=await call('showkontrol_compose_multi_track_show_copy',{source,destination,sha256,tracks});
  assert.equal(response.isError,undefined,JSON.stringify(response));
  const result=await inspectShowTimeline({file:destination,name:target});
  assert.deepEqual(result.cueElements.map(cue=>cue.attributes.label),labels);
  assert.equal(parse(response).sha256,(await inspectShow({file:destination})).sha256);
 }
 for(const [name,args] of [['conflict',{...existing,trackName:'Bad'}],['missing',{...existing,existingPartName:'content/Missing.sktl'}],['late',{tracks:[existing,{...fresh,cues:[{...fresh.cues[0],layer:99}]}]}]]){
  const destination=path.join(dir,`${name}.skshow`);const response=await call(name==='late'?'showkontrol_compose_multi_track_show_copy':'showkontrol_compose_show_copy',{source,destination,sha256,...args});assert.equal(response.isError,true,JSON.stringify(response));await assert.rejects(readFile(destination),/ENOENT/);
 }
 assert.equal(await readFile(source,'utf8'),input);assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.showkontrol-')),[]);
});

test('MCP composes ordered audio clip edits atomically across existing and new tracks',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-compose-audio-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow');
 const timeline='<sktimeline version="1" name="Existing"><layers><layer name="Layer 1"/></layers><audio name="Audio 1"><clip name="original" pps="1" offsetMs="0" vol="1" trimStartMs="0" trimEndMs="1000" fadeInMs="0" custom="keep"><file>media/song.wav</file></clip><unknown value="keep"/></audio></sktimeline>';
 const empty='<sktimeline version="1" name="Empty"><layers><layer name="Layer 1"/></layers></sktimeline>';
 const input=`<skshow><!-- preserve -->${part('content/Existing.sktl',timeline)}${part('content/Empty.sktl',empty)}${part('media/song.wav','media bytes')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 await writeFile(source,input);const sha256=(await inspectShow({file:source})).sha256;
 const client=new Client({name:'compose-audio-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args});
 const edits=[{audioIndex:0,clipIndex:0,attributes:{vol:'0.5',offsetMs:'120'}},{audioIndex:0,clipIndex:0,attributes:{vol:'0.25',fadeInMs:'40'}}];
 const existing={existingPartName:'content/Existing.sktl',audioClipEdits:edits,cues:[{layer:0,startMs:100,lengthMs:40,label:'Added'}]};
 const fresh={templateName:'content/Empty.sktl',trackName:'New',partName:'content/New.sktl',cues:[{layer:0,startMs:200,lengthMs:40,label:'New cue'}]};
 for(const multi of [false,true]){
  const destination=path.join(dir,multi?'multi.skshow':'single.skshow');
  const result=await call(multi?'showkontrol_compose_multi_track_show_copy':'showkontrol_compose_show_copy',{source,destination,sha256,...(multi?{tracks:[fresh,existing]}:existing)});
  assert.equal(result.isError,undefined,JSON.stringify(result));
  const snapshot=await readShowSnapshot({file:destination});assert.ok(snapshot.parts.every(p=>p.valid));
  const target=snapshot.parts.find(p=>p.name===existing.existingPartName).bytes.toString();
  assert.ok(target.includes('pps="1" offsetMs="120" vol="0.25" trimStartMs="0" trimEndMs="1000" fadeInMs="40" custom="keep"'));assert.ok(target.includes('<unknown value="keep"/>'));
  assert.equal(snapshot.parts.find(p=>p.name==='media/song.wav').bytes.toString(),'media bytes');
  assert.equal((await inspectShowTimeline({file:destination,name:existing.existingPartName})).cueElements.length,1);
  const again=await call(multi?'showkontrol_compose_multi_track_show_copy':'showkontrol_compose_show_copy',{source,destination,sha256,...(multi?{tracks:[fresh,existing]}:existing)});assert.equal(again.isError,true);
 }
 const newTrackFailure=path.join(dir,'new-track-failure.skshow');
 const newTrackResult=await call('showkontrol_compose_show_copy',{source,destination:newTrackFailure,sha256,...fresh,audioClipEdits:edits});
 assert.equal(newTrackResult.isError,true);assert.match(newTrackResult.content[0].text,/Audio clip index/);await assert.rejects(readFile(newTrackFailure),/ENOENT/);
 const tooMany=Array.from({length:101},()=>edits[0]);
 for(const multi of [false,true]){
  const destination=path.join(dir,`too-many-${multi}.skshow`);
  const response=await call(multi?'showkontrol_compose_multi_track_show_copy':'showkontrol_compose_show_copy',{source,destination,sha256,...(multi?{tracks:[{...existing,audioClipEdits:tooMany}]}:{...existing,audioClipEdits:tooMany})});
  assert.equal(response.isError,true);await assert.rejects(readFile(destination),/ENOENT/);
 }
 const directFailure=path.join(dir,'too-many-direct.skshow');
 await assert.rejects(composeShowCopy({source,destination:directFailure,sha256,...existing,audioClipEdits:tooMany}),/at most 100/);await assert.rejects(readFile(directFailure),/ENOENT/);
 const failed=path.join(dir,'failed.skshow');
 const result=await call('showkontrol_compose_multi_track_show_copy',{source,destination:failed,sha256,tracks:[fresh,{...existing,audioClipEdits:[...edits,{audioIndex:0,clipIndex:0,attributes:{fadeOutMs:'2'}}]}]});
 assert.equal(result.isError,true);assert.match(result.content[0].text,/must exist/);await assert.rejects(readFile(failed),/ENOENT/);
 const missing=path.join(dir,'missing.skshow');
 const bad=await call('showkontrol_compose_show_copy',{source,destination:missing,sha256,...existing,audioClipEdits:[...edits,{audioIndex:0,clipIndex:0,attributes:{vol:'1',unsupported:'3'}}]});
 assert.equal(bad.isError,true);await assert.rejects(readFile(missing),/ENOENT/);
 assert.equal(await readFile(source,'utf8'),input);assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.showkontrol-')),[]);
});

test('MCP composes ordered cue edits and new cues atomically',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-compose-cue-edits-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow');
 const graph='<graph><node id="n1" type="trigger"><settings><setting key="trigger.path">original</setting></settings></node></graph>';
 const timeline=`<sktimeline version="1" name="Existing"><layers><layer name="Layer 1"/><layer name="Layer 2"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Original">${graph}</cue></sktimeline>`;
 const input=`<skshow><!-- keep -->${part('content/Existing.sktl',timeline)}${part('content/Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="Layer 1"/></layers></sktimeline>')}${part('media/file.wav','media bytes')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 await writeFile(source,input);const sha256=(await inspectShow({file:source})).sha256;
 const client=new Client({name:'compose-cue-edits-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args});
 const existing={existingPartName:'content/Existing.sktl',cueEdits:[{cueId:'c1',label:'First',startMs:10},{cueId:'c1',label:'Final',layer:1,lengthMs:80}],cues:[{layer:0,startMs:100,lengthMs:40,label:'Added'}]};
 const fresh={templateName:'content/Empty.sktl',trackName:'New',partName:'content/New.sktl',cues:[{layer:0,startMs:200,lengthMs:40,label:'New'}]};
 for(const multi of [false,true]){
  const destination=path.join(dir,`result-${multi}.skshow`),name=multi?'showkontrol_compose_multi_track_show_copy':'showkontrol_compose_show_copy';
  const args={source,destination,sha256,...(multi?{tracks:[fresh,existing]}:existing)};const result=await call(name,args);
  assert.equal(result.isError,undefined,JSON.stringify(result));assert.equal(JSON.parse(result.content[0].text).sha256,(await inspectShow({file:destination})).sha256);
  const snapshot=await readShowSnapshot({file:destination});assert.ok(snapshot.parts.every(p=>p.valid));
  const target=snapshot.parts.find(p=>p.name===existing.existingPartName).bytes.toString();assert.ok(target.includes(`<cue id="c1" layer="1" startMs="10" lenMs="80" label="Final">${graph}</cue>`));
  assert.equal(snapshot.parts.find(p=>p.name==='media/file.wav').bytes.toString(),'media bytes');assert.equal((await inspectShowTimeline({file:destination,name:existing.existingPartName})).cueElements.length,2);
  assert.equal((await call(name,args)).isError,true);
 }
 for(const [name,tracks] of [['late',[fresh,{...existing,cueEdits:[...existing.cueEdits,{cueId:'missing',label:'Bad'}]}]],['new',[{...fresh,cueEdits:[{cueId:'c1',label:'Bad'}]}]],['limit',[{...existing,cueEdits:Array.from({length:101},()=>({cueId:'c1',label:'Bad'}))}]]]){
  const destination=path.join(dir,`${name}.skshow`);const result=await call('showkontrol_compose_multi_track_show_copy',{source,destination,sha256,tracks});assert.equal(result.isError,true,JSON.stringify(result));await assert.rejects(readFile(destination),/ENOENT/);
 }
 assert.equal(await readFile(source,'utf8'),input);assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.showkontrol-')),[]);
});

test('MCP accepts edit-only composition and rolls back later failures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-compose-edit-only-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow');
 const timeline='<sktimeline version="1" name="Existing"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Original"/></sktimeline>';
 const input=`<skshow>${part('content/Existing.sktl',timeline)}${part('content/Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="Layer 1"/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 await writeFile(source,input);const sha256=(await inspectShow({file:source})).sha256;
 const client=new Client({name:'edit-only-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:{source,sha256,...args}});
 const edit={existingPartName:'content/Existing.sktl',cueEdits:[{cueId:'c1',label:'Edited'}]};
 const fresh={templateName:'content/Empty.sktl',trackName:'New',partName:'content/New.sktl',cues:[]};
 for(const multi of [false,true]){
  const destination=path.join(dir,`edit-${multi}.skshow`),name=multi?'showkontrol_compose_multi_track_show_copy':'showkontrol_compose_show_copy';
  const result=await call(name,{destination,...(multi?{tracks:[fresh,{...edit,cues:[]}]}:edit)});assert.equal(result.isError,undefined,JSON.stringify(result));
  const snapshot=await readShowSnapshot({file:destination});assert.match(snapshot.parts.find(p=>p.name===edit.existingPartName).bytes.toString(),/label="Edited"/);
  assert.equal((await inspectShowTimeline({file:destination,name:edit.existingPartName})).cueElements.length,1);
 }
 for(const multi of [false,true]){
  const destination=path.join(dir,`noop-${multi}.skshow`),name=multi?'showkontrol_compose_multi_track_show_copy':'showkontrol_compose_show_copy';
  const result=await call(name,{destination,...(multi?{tracks:[{existingPartName:edit.existingPartName,cues:[]}]}:{existingPartName:edit.existingPartName})});assert.equal(result.isError,true);await assert.rejects(readFile(destination),/ENOENT/);
 }
 const destination=path.join(dir,'rollback.skshow');
 const failed=await call('showkontrol_compose_multi_track_show_copy',{destination,tracks:[edit,{...edit,cueEdits:[{cueId:'missing',label:'Bad'}]}]});
 assert.equal(failed.isError,true);await assert.rejects(readFile(destination),/ENOENT/);assert.equal(await readFile(source,'utf8'),input);
 assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.showkontrol-')),[]);
});

test('MCP composes ordered existing graph setting edits atomically',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-compose-graph-edits-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow');
 const timeline='<sktimeline version="1" name="Existing"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0" lenMs="40" label="Original"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">original</setting><setting key="other">keep</setting></settings></node></graph></cue></sktimeline>';
 const input=`<skshow><!-- keep -->${part('content/Existing.sktl',timeline)}${part('media/file.wav','media bytes')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 await writeFile(source,input);const sha256=(await inspectShow({file:source})).sha256;
 const client=new Client({name:'compose-graph-edits-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:{source,sha256,...args}});
 const edit={existingPartName:'content/Existing.sktl',graphSettingEdits:[{cueId:'c1',nodeId:'n1',key:'trigger.path',value:'first'},{cueId:'c1',nodeId:'n1',key:'trigger.path',value:'final & value'}]};
 for(const multi of [false,true]){
  const name=multi?'showkontrol_compose_multi_track_show_copy':'showkontrol_compose_show_copy',destination=path.join(dir,`result-${multi}.skshow`);
  const result=await call(name,{destination,...(multi?{tracks:[edit]}:edit)});assert.equal(result.isError,undefined,JSON.stringify(result));
  const snapshot=await readShowSnapshot({file:destination});assert.ok(snapshot.parts.every(p=>p.valid));
  const target=snapshot.parts.find(p=>p.name===edit.existingPartName).bytes.toString();assert.ok(target.includes('<setting key="trigger.path">final &amp; value</setting>'));assert.ok(target.includes('<setting key="other">keep</setting>'));assert.ok(target.includes('label="Original"'));
  assert.equal(snapshot.parts.find(p=>p.name==='media/file.wav').bytes.toString(),'media bytes');
  const failedPath=path.join(dir,`failed-${multi}.skshow`),bad={...edit,graphSettingEdits:[...edit.graphSettingEdits,{cueId:'c1',nodeId:'n1',key:'missing',value:'bad'}]};
  const failed=await call(name,{destination:failedPath,...(multi?{tracks:[edit,bad]}:bad)});assert.equal(failed.isError,true);await assert.rejects(readFile(failedPath),/ENOENT/);
  const limitPath=path.join(dir,`limit-${multi}.skshow`),limit={...edit,graphSettingEdits:Array(101).fill(edit.graphSettingEdits[0])};
  assert.equal((await call(name,{destination:limitPath,...(multi?{tracks:[limit]}:limit)})).isError,true);await assert.rejects(readFile(limitPath),/ENOENT/);
 }
 assert.equal(await readFile(source,'utf8'),input);assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.showkontrol-')),[]);
});
