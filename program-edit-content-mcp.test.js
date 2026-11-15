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
test('MCP Program content edits work through both composers and roll back failures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const graph='<graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node></graph>';
 const cueGraph='<graph><node id="n2" type="action"><settings><setting key="x">keep</setting></settings></node></graph>';
 const timeline=`<sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old">${cueGraph}</cue></sktimeline>`;
 const program=`<skprogram version="1"><item start="0" name="A" notes="">${graph}${timeline}</item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}</skshow>`,source=f('source.skshow'),sha256=hash('sha256',show);await writeFile(source,show);
 const client=new Client({name:'program-content-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools;const call=(name,args)=>client.callTool({name,arguments:args});const parse=r=>JSON.parse(r.content[0].text);
 const operations=[{action:'edit_graph_setting',index:0,nodeId:'n1',key:'trigger.path',value:'new'},{action:'edit_timeline_cue',index:0,cueId:'c1',startMs:50,label:'Go'}];
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy',schema=JSON.stringify(tools.find(t=>t.name===name)?.inputSchema);
  assert.ok(schema.includes('edit_graph_setting'));assert.ok(schema.includes('edit_timeline_cue'));
  const destination=f(full?'full.skshow':'direct.skshow'),args={source,destination,sha256,...(full?{program:{operations}}:{operations})};
  const result=await call(name,args);assert.notEqual(result.isError,true,JSON.stringify(result));const output=parse(result);
  const graphResult=await call('showkontrol_inspect_program_item_graph',{file:destination,sha256:output.sha256,index:0});assert.notEqual(graphResult.isError,true,JSON.stringify(graphResult));assert.equal(parse(graphResult).graph.nodes[0].settings[0].value,'new');
  const timelineResult=await call('showkontrol_inspect_program_timeline',{file:destination,sha256:output.sha256,index:0});assert.notEqual(timelineResult.isError,true,JSON.stringify(timelineResult));const cue=parse(timelineResult).cueElements[0];assert.equal(cue.attributes.id,'c1');assert.equal(cue.attributes.startMs,'50');assert.equal(cue.attributes.label,'Go');
  const extracted=f(full?'full.sktl':'direct.sktl');assert.notEqual((await call('showkontrol_extract_program_timeline_copy',{source:destination,destination:extracted,sha256:output.sha256,index:0})).isError,true);assert.ok((await readFile(extracted,'utf8')).includes(cueGraph));
  const failed=f(full?'failed-full.skshow':'failed-direct.skshow'),bad=[operations[0],{...operations[1],cueId:'missing'}];
  assert.equal((await call(name,{...args,destination:failed,...(full?{program:{operations:bad}}:{operations:bad})})).isError,true);await assert.rejects(readFile(failed),{code:'ENOENT'});
  const invalid=[{...operations[0],unexpected:true}];assert.equal((await call(name,{...args,destination:failed,...(full?{program:{operations:invalid}}:{operations:invalid})})).isError,true);await assert.rejects(readFile(failed),{code:'ENOENT'});
 }
 assert.equal(await readFile(source,'utf8'),show);assert.deepEqual((await readdir(dir)).sort(),['direct.skshow','direct.sktl','full.skshow','full.sktl','source.skshow']);
});
