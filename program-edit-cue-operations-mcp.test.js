import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
test('MCP composers add and delete Program timeline cues and reject referenced deletion',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-cues-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=name=>path.join(dir,name);
 const timeline='<sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old"><graph><node id="n2" type="trigger"/></graph></cue></sktimeline>';
 const program=`<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes="">${timeline}</item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}</skshow>`;
 const referenced=`<skshow>${part('content/Program.skpr',program)}${part('content/other.skcp','<root ref="n2"/>')}</skshow>`;
 await writeFile(f('source.skshow'),show);await writeFile(f('referenced.skshow'),referenced);
 const client=new Client({name:'program-cue-operations-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools,call=(name,args)=>client.callTool({name,arguments:args});
 const operations=[{action:'remove',index:0},{action:'delete_timeline_cue',index:0,cueId:'c1',deleteGraph:true},{action:'add_timeline_cue',index:0,layer:0,startMs:200,lengthMs:50,label:'New'}];
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy';
  const schema=JSON.stringify(tools.find(tool=>tool.name===name)?.inputSchema);assert.ok(schema.includes('add_timeline_cue'));assert.ok(schema.includes('delete_timeline_cue'));
  const destination=f(full?'full.skshow':'direct.skshow');
  const args={source:f('source.skshow'),destination,sha256:hash('sha256',show),...(full?{program:{operations}}:{operations})};
  const response=await call(name,args);assert.notEqual(response.isError,true,JSON.stringify(response));
  const output=JSON.parse(response.content[0].text),created=full?output.program.createdCues:output.createdCues;
  assert.equal(created.length,1);assert.equal(created[0].operationIndex,2);assert.equal(created[0].index,0);assert.match(created[0].id,/^c/);
  const extracted=f(full?'full.sktl':'direct.sktl');
  const result=await call('showkontrol_extract_program_timeline_copy',{source:destination,destination:extracted,sha256:output.sha256,index:0});assert.notEqual(result.isError,true,JSON.stringify(result));
  const xml=await readFile(extracted,'utf8');assert.ok(!xml.includes('id="c1"'));assert.ok(xml.includes(`id="${created[0].id}"`));assert.ok(xml.includes('label="New"'));
  const failed=f(full?'failed-full.skshow':'failed-direct.skshow');
  const failure=await call(name,{...args,source:f('referenced.skshow'),sha256:hash('sha256',referenced),destination:failed});
  assert.equal(failure.isError,true);assert.match(JSON.stringify(failure),/references/);await assert.rejects(readFile(failed),{code:'ENOENT'});
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),show);assert.equal(await readFile(f('referenced.skshow'),'utf8'),referenced);
 assert.deepEqual((await readdir(dir)).sort(),['direct.skshow','direct.sktl','full.skshow','full.sktl','referenced.skshow','source.skshow']);
});
