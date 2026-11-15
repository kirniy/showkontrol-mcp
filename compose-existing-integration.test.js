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
