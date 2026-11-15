import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {parseTimeline} from './timeline.js';

const xml=`<sktimeline version="1"><!-- <audio><clip name="comment"/></audio> --><other><audio><clip name="nested lane"/></audio></other><audio name="A &amp; B"><clip name="A &quot;clip&quot;" file="a&amp;b.wav" wave="" grid="" pps="75" offsetMs="1000" vol="0.5" trimStartMs="1000" trimEndMs="3000" fadeInMs="250" fadeOutMs="500"/><wrapper><clip name="nested clip"/></wrapper></audio><audio name="second"><clip name="second clip"/></audio></sktimeline>`;
const expected=[{audioIndex:0,attributes:{name:'A "clip"',file:'a&b.wav',wave:'',grid:'',pps:'75',offsetMs:'1000',vol:'0.5',trimStartMs:'1000',trimEndMs:'3000',fadeInMs:'250',fadeOutMs:'500'}},{audioIndex:1,attributes:{name:'second clip'}}];

test('parse direct audio clips and preserve lane attributes',()=>{
 const result=parseTimeline(xml);
 assert.deepEqual(result.audio,[{name:'A & B'},{name:'second'}]);
 assert.deepEqual(result.audioClips,expected);
 assert.deepEqual(parseTimeline('<sktimeline version="1"><audio/></sktimeline>').audioClips,[]);
});

test('MCP exposes audio clips in standalone and show timeline inspection',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-audio-inspect-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'track.sktl'),show=path.join(dir,'show.skshow'),name='content/Track.sktl';
 await writeFile(file,xml);
 await writeFile(show,`<skshow><part name="${name}" md5="${createHash('md5').update(xml).digest('hex')}">${Buffer.from(xml).toString('base64')}</part></skshow>`);
 const client=new Client({name:'audio-inspection-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 for(const [tool,args] of [['showkontrol_inspect_timeline',{file}],['showkontrol_inspect_show_timeline',{file:show,name}]]){
  const response=await client.callTool({name:tool,arguments:args});assert.equal(response.isError,undefined);
  const result=JSON.parse(response.content[0].text);assert.deepEqual(result.audio,[{name:'A & B'},{name:'second'}]);assert.deepEqual(result.audioClips,expected.map(clip=>({...clip,clipIndex:0})));
 }
});

// The edit and removal tools take a per-lane clipIndex, so inspection must report it rather than only a flat order.
test('timeline inspection reports each clip index within its lane and the edit tools accept it',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-audio-clip-index-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const c=name=>`<clip name="${name}" file="/m/${name}.wav" wave="" grid="" pps="75" offsetMs="0" trimStartMs="0" trimEndMs="1000" fadeInMs="0" fadeOutMs="0"/>`;
 const timeline=`<sktimeline version="1" name="T"><layers><layer/></layers><audio name="A">${c('a0')}${c('a1')}${c('a2')}</audio><audio name="B">${c('b0')}${c('b1')}</audio><audio name="C"/></sktimeline>`;
 const name='content/T.sktl',show=path.join(dir,'show.skshow'),file=path.join(dir,'t.sktl');
 const showXml=`<skshow><part name="${name}" md5="${createHash('md5').update(timeline).digest('hex')}">${Buffer.from(timeline).toString('base64')}</part></skshow>`;
 await writeFile(show,showXml);await writeFile(file,timeline);
 const client=new Client({name:'audio-clip-index-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=async(tool,args)=>{const response=await client.callTool({name:tool,arguments:args});assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};
 const expected=[[0,0,'a0'],[0,1,'a1'],[0,2,'a2'],[1,0,'b0'],[1,1,'b1']];
 const standalone=await call('showkontrol_inspect_timeline',{file});
 assert.deepEqual(standalone.audioClips.map(clip=>[clip.audioIndex,clip.clipIndex,clip.attributes.name]),expected);
 const inspected=await call('showkontrol_inspect_show_timeline',{file:show,name});
 assert.deepEqual(inspected.audioClips.map(clip=>[clip.audioIndex,clip.clipIndex,clip.attributes.name]),expected);
 const target=inspected.audioClips.find(clip=>clip.attributes.name==='b1');
 const edited=path.join(dir,'edited.skshow');
 await call('showkontrol_edit_timeline_audio_clip_copy',{source:show,destination:edited,format:'skshow',sha256:inspected.sha256,name,audioIndex:target.audioIndex,clipIndex:target.clipIndex,attributes:{name:'b1 edited'}});
 const afterEdit=await call('showkontrol_inspect_show_timeline',{file:edited,name});
 assert.deepEqual(afterEdit.audioClips.map(clip=>clip.attributes.name),['a0','a1','a2','b0','b1 edited']);
 const second=afterEdit.audioClips.find(clip=>clip.attributes.name==='a1'),removed=path.join(dir,'removed.skshow');
 await call('showkontrol_remove_timeline_audio_clip_copy',{source:edited,destination:removed,format:'skshow',sha256:afterEdit.sha256,name,audioIndex:second.audioIndex,clipIndex:second.clipIndex});
 const afterRemove=await call('showkontrol_inspect_show_timeline',{file:removed,name});
 assert.deepEqual(afterRemove.audioClips.map(clip=>[clip.audioIndex,clip.clipIndex,clip.attributes.name]),[[0,0,'a0'],[0,1,'a2'],[1,0,'b0'],[1,1,'b1 edited']]);
});
