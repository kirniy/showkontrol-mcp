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
  const result=JSON.parse(response.content[0].text);assert.deepEqual(result.audio,[{name:'A & B'},{name:'second'}]);assert.deepEqual(result.audioClips,expected);
 }
});
