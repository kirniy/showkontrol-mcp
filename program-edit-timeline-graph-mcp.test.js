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
test('MCP composers edit embedded cue graph settings and roll back failures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-graph-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=name=>path.join(dir,name);
 const timeline=`<sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old"><graph><node id="n2" type="trigger" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>`;
 const program=`<skprogram version="1"><item start="0" name="A" notes=""/> <item start="1" name="B" notes="">${timeline}</item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}</skshow>`,source=f('source.skshow'),sha256=hash('sha256',show);await writeFile(source,show);
 const client=new Client({name:'program-graph-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools,call=(name,args)=>client.callTool({name,arguments:args});
 const edit=(key,value)=>({action:'edit_timeline_graph_setting',index:0,cueId:'c1',nodeId:'n2',key,value});
 const operations=[{action:'remove',index:0},edit('trigger.path','new & safe'),edit('node.stopped','false')];
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy';
  assert.ok(JSON.stringify(tools.find(tool=>tool.name===name)?.inputSchema).includes('edit_timeline_graph_setting'));
  const destination=f(full?'full.skshow':'direct.skshow');
  const args={source,destination,sha256,...(full?{program:{operations}}:{operations})};
  const response=await call(name,args);assert.notEqual(response.isError,true,JSON.stringify(response));
  const output=JSON.parse(response.content[0].text),extracted=f(full?'full.sktl':'direct.sktl');
  const extraction=await call('showkontrol_extract_program_timeline_copy',{source:destination,destination:extracted,sha256:output.sha256,index:0});assert.notEqual(extraction.isError,true,JSON.stringify(extraction));
  const xml=await readFile(extracted,'utf8');
  assert.equal(xml,timeline.replace('>old</setting>','>new &amp; safe</setting>').replace('stopped="1"','stopped="0"').replace('>true</setting>','>false</setting>'));
  const failed=f(full?'failed-full.skshow':'failed-direct.skshow'),bad=[...operations,edit('node.stopped','invalid')];
  const failure=await call(name,{...args,destination:failed,...(full?{program:{operations:bad}}:{operations:bad})});
  assert.equal(failure.isError,true);await assert.rejects(readFile(failed),{code:'ENOENT'});
 }
 assert.equal(await readFile(source,'utf8'),show);
 assert.deepEqual((await readdir(dir)).sort(),['direct.skshow','direct.sktl','full.skshow','full.sktl','source.skshow']);
});
