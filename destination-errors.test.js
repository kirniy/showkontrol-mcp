import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const hash=(algorithm,text)=>createHash(algorithm).update(text).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;

test('a destination in a missing directory is named instead of a temporary-file ENOENT',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-destination-errors-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),name='content/Main.sktl';
 const xml=`<skshow>${part(name,'<sktimeline version="1" name="Main"><layers><layer/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 await writeFile(source,xml);const sha256=hash('sha256',xml);
 const client=new Client({name:'destination-errors-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const missing=path.join(dir,'missing'),destination=path.join(missing,'out.skshow');
 const cue={name,layer:0,startMs:0,lengthMs:100,label:'Go'};
 for(const [tool,args] of [
  ['showkontrol_add_show_timeline_cues_copy',{cues:[cue]}],
  ['showkontrol_add_show_timeline_cue_copy',cue],
  ['showkontrol_edit_show_part_copy',{name,edits:[{find:'name="Main"',replace:'name="Other"'}]}],
  ['showkontrol_compose_multi_track_show_copy',{tracks:[{existingPartName:name,cues:[{layer:0,startMs:0,lengthMs:100,label:'Go'}]}]}],
 ]){
  const response=await client.callTool({name:tool,arguments:{source,destination,sha256,...args}});
  assert.equal(response.isError,true,tool);
  assert.equal(response.content[0].text,`Destination directory does not exist: ${missing}`,tool);
 }
 assert.deepEqual(await readdir(dir),['in.skshow']);
 // A missing source with an existing destination directory keeps the original error.
 const response=await client.callTool({name:'showkontrol_edit_show_part_copy',arguments:{source:path.join(dir,'absent.skshow'),destination:path.join(dir,'out.skshow'),sha256,name,edits:[{find:'a',replace:'b'}]}});
 assert.equal(response.isError,true);assert.match(response.content[0].text,/ENOENT.*absent\.skshow/);
});
