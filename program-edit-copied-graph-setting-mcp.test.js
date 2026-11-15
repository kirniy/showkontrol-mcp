import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
test('MCP composers configure copied cue graph settings and roll back invalid selectors',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'copied-graph-setting-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=name=>path.join(dir,name);
 const timeline='<sktimeline version="1"><layers><layer name="Base"/></layers></sktimeline>';
 const program=`<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes="">${timeline}</item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${part('other.txt','preserved')}</skshow>`;
 const donor='<sktimeline version="1"><layers/><cue id="donor"><graph><node id="n1" type="trigger" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>';
 await writeFile(f('source.skshow'),show);await writeFile(f('donor.sktl'),donor);
 const client=new Client({name:'copied-graph-setting-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools,call=(name,args)=>client.callTool({name,arguments:args});
 const add={action:'add_timeline_cue',index:1,layer:0,startMs:100,lengthMs:20,label:'New'};
 const copy={action:'copy_timeline_cue_graph',index:1,cueFromOperation:0,donor:f('donor.sktl'),donorSha256:hash('sha256',donor),donorCueId:'donor'};
 const edit=(key,value)=>({action:'edit_copied_timeline_graph_setting',index:0,graphFromOperation:1,donorNodeId:'n1',key,value});
 const operations=[add,copy,{action:'remove',index:0},edit('trigger.path','new & safe'),edit('node.stopped','false')];
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy';
  assert.match(JSON.stringify(tools.find(tool=>tool.name===name)?.inputSchema),/edit_copied_timeline_graph_setting/);
  const destination=f(`${full}.skshow`),base={source:f('source.skshow'),destination,sha256:hash('sha256',show)};
  const wrap=ops=>full?{program:{operations:ops}}:{operations:ops};
  const response=await call(name,{...base,...wrap(operations)});assert.notEqual(response.isError,true,JSON.stringify(response));
  const result=JSON.parse(response.content[0].text),out=full?result.program:result,mapping=out.copiedCueGraphs[0];
  const extracted=f(`${full}.sktl`);
  const extraction=await call('showkontrol_extract_program_timeline_copy',{source:destination,destination:extracted,sha256:result.sha256,index:0});assert.notEqual(extraction.isError,true,JSON.stringify(extraction));
  const xml=await readFile(extracted,'utf8');assert.match(xml,new RegExp(`id="${mapping.idMap.n1}"[^>]*stopped="0"`));
  assert.match(xml,/>new &amp; safe<\/setting>/);assert.match(xml,/>false<\/setting>/);
  for(const [label,bad] of [['forward',{...edit('trigger.path','bad'),graphFromOperation:99}],['missing-node',{...edit('trigger.path','bad'),donorNodeId:'missing'}],['wrong-item',{...edit('trigger.path','bad'),index:1}]]){
   const failed=f(`${full}-${label}.skshow`);
   const failure=await call(name,{...base,destination:failed,...wrap([...operations,bad])});
   assert.equal(failure.isError,true,JSON.stringify(failure));await assert.rejects(readFile(failed),{code:'ENOENT'});
  }
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),show);assert.equal(await readFile(f('donor.sktl'),'utf8'),donor);
});
