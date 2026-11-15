import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {inspectShow} from './xml-copy.js';

const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('MCP creates and composes a set list with readback and rollback',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-create-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow');
 const original=`<skshow>${part('One.sktl','<sktimeline version="1" name="One"><layers><layer/></layers></sktimeline>')}${part('Two.sktl','<sktimeline version="1" name="Two"><layers><layer/></layers></sktimeline>')}</skshow>`;
 await writeFile(source,original);const {sha256}=await inspectShow({file:source});
 const client=new Client({name:'create-setlist-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args});
 const names=(await client.listTools()).tools.map(tool=>tool.name);assert.ok(names.includes('showkontrol_create_show_setlist_copy'));assert.ok(names.includes('showkontrol_compose_multi_track_show_copy'));
 const name='content/Set.skls',single=path.join(dir,'single.skshow');
 const created=await call('showkontrol_create_show_setlist_copy',{source,destination:single,sha256,name,setName:'Main',tracks:['One']});assert.equal(created.isError,undefined,JSON.stringify(created));
 const inspect=async file=>{const response=await call('showkontrol_inspect_show_setlist',{file,name});assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};
 assert.deepEqual((await inspect(single)).sets,[{name:'Main',tracks:['One']}]);
 const destination=path.join(dir,'composed.skshow');const operations=[{operation:'create_setlist',name,setName:'Main',tracks:['One']},{operation:'create_set',name,newSetName:'Other'},{operation:'append_track',name,setName:'Other',trackName:'Two'}];
 const result=await call('showkontrol_compose_multi_track_show_copy',{source,destination,sha256,tracks:[],setlistOperations:operations});assert.equal(result.isError,undefined,JSON.stringify(result));const output=JSON.parse(result.content[0].text);assert.equal(output.sha256,(await inspectShow({file:destination})).sha256);assert.deepEqual(output.setlistOperations,operations);
 assert.deepEqual((await inspect(destination)).sets,[{name:'Main',tracks:['One']},{name:'Other',tracks:['Two']}]);
 for(const file of [single,destination]){const validation=await call('showkontrol_validate_show',{file});assert.equal(validation.isError,undefined,JSON.stringify(validation));assert.deepEqual(JSON.parse(validation.content[0].text).diagnostics.filter(d=>d.severity==='error'),[]);}
 const failed=path.join(dir,'failed.skshow');const failure=await call('showkontrol_compose_multi_track_show_copy',{source,destination:failed,sha256,tracks:[],setlistOperations:[...operations,{operation:'append_track',name,setName:'Missing',trackName:'Two'}]});assert.equal(failure.isError,true);await assert.rejects(readFile(failed),{code:'ENOENT'});
 const invalid=await call('showkontrol_create_show_setlist_copy',{source,destination:failed,sha256,name,setName:'Main',tracks:['Missing']});assert.equal(invalid.isError,true);await assert.rejects(readFile(failed),{code:'ENOENT'});
 assert.equal(await readFile(source,'utf8'),original);assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
});
