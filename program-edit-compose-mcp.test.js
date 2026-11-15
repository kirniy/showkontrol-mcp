import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;

test('MCP composes ordered Program edits directly and with staged tracks',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-edit-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow');
 const show=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}${part('content/Program.skpr','<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""/></skprogram>')}</skshow>`;
 await writeFile(source,show);const sha256=hash('sha256',show);
 const client=new Client({name:'program-edit-integration',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name:`showkontrol_${name}`,arguments:args});
 const tools=(await client.listTools()).tools.map(tool=>tool.name);
 for(const name of ['showkontrol_compose_program_edits_copy','showkontrol_compose_full_show_copy'])assert.ok(tools.includes(name));
 const operations=[{action:'remove',index:0},{action:'add',start:2,name:'C',notes:''},{action:'edit',index:1,name:'D'}];
 const tracks=[{templateName:'Empty.sktl',trackName:'First',partName:'content/First.sktl',cues:[{layer:0,startMs:0,lengthMs:100,label:'Go'}]}];
 for(const full of [false,true]){
  const destination=path.join(dir,full?'full.skshow':'direct.skshow');
  const name=full?'compose_full_show_copy':'compose_program_edits_copy';
  const args={source,destination,sha256,...(full?{tracks,program:{operations}}:{operations})};
  const response=await call(name,args);assert.equal(response.isError,undefined,JSON.stringify(response));
  const result=JSON.parse(response.content[0].text);if(full)assert.equal(result.tracks.length,1);
  const readback=await call('inspect_show_program',{file:destination});assert.equal(readback.isError,undefined);
  const inspected=JSON.parse(readback.content[0].text);assert.deepEqual(inspected.items.map(item=>item.name),['B','D']);assert.equal(inspected.sha256,result.sha256);
  const bad=path.join(dir,full?'full-bad.skshow':'direct-bad.skshow');
  const failed=await call(name,{...args,destination:bad,...(full?{program:{operations:[...operations,{action:'remove',index:99}]}}:{operations:[...operations,{action:'remove',index:99}]})});
  assert.equal(failed.isError,true);await assert.rejects(readFile(bad),{code:'ENOENT'});
 }
 const conflict=path.join(dir,'conflict.skshow');
 for(const program of [{operations,items:[]},{operations,replaceExisting:true}]){
  const response=await call('compose_full_show_copy',{source,destination:conflict,sha256,tracks,program});assert.equal(response.isError,true);await assert.rejects(readFile(conflict),{code:'ENOENT'});
 }
 assert.equal(await readFile(source,'utf8'),show);assert.deepEqual((await readdir(dir)).sort(),['direct.skshow','full.skshow','in.skshow']);
});
