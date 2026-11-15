import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
test('MCP composers assemble mixed graph nodes, edit settings and roll back failures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'assembled-graph-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const timeline='<sktimeline version="1"><layers><layer name="Base"/></layers></sktimeline>';
 const program=`<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""><graph><node id="n5000" type="action"/></graph>${timeline}</item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 const cueXml='<sktimeline version="1"><cue id="donor"><graph><node id="n1" type="trigger" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>';
 const cueShow=`<skshow>${part('content/Donor.sktl',cueXml)}</skshow>`;
 const patch='<showkontrol version="2"><graph><node id="n2" type="action"><settings><setting key="notify.message">old message</setting></settings></node></graph></showkontrol>';
 await Promise.all([writeFile(f('source.skshow'),show),writeFile(f('cue.skshow'),cueShow),writeFile(f('donor.skf'),patch)]);
 const client=new Client({name:'assembled-graph-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools,call=(name,args)=>client.callTool({name,arguments:args});
 const add={action:'add_timeline_cue',index:1,layer:0,startMs:100,lengthMs:20,label:'New'};
 const assembly={action:'assemble_timeline_cue_graph',index:1,cueFromOperation:0,nodes:[{kind:'cue',template:f('cue.skshow'),templateSha256:hash('sha256',cueShow),templateName:'content/Donor.sktl',templateCueId:'donor',nodeId:'n1'},{kind:'patch',template:f('donor.skf'),templateSha256:hash('sha256',patch),templateFormat:'skf',nodeId:'n2'}],wires:[{from:0,to:1}]};
 const edit=(nodeIndex,key,value)=>({action:'edit_assembled_timeline_graph_setting',index:0,graphFromOperation:1,nodeIndex,key,value});
 const operations=[add,assembly,{action:'remove',index:0},edit(0,'trigger.path','new & safe'),edit(0,'node.stopped','false'),edit(1,'notify.message','hello')];
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy';
  const schema=JSON.stringify(tools.find(tool=>tool.name===name)?.inputSchema);assert.match(schema,/assemble_timeline_cue_graph/);assert.match(schema,/edit_assembled_timeline_graph_setting/);
  const destination=f(`${full}.skshow`),base={source:f('source.skshow'),destination,sha256:hash('sha256',show)},wrap=ops=>full?{program:{operations:ops}}:{operations:ops};
  const response=await call(name,{...base,...wrap(operations)});assert.notEqual(response.isError,true,JSON.stringify(response));
  const result=JSON.parse(response.content[0].text),out=full?result.program:result,mapping=out.assembledCueGraphs[0];
  assert.equal(mapping.operationIndex,1);assert.equal(mapping.cueId,out.createdCues[0].id);assert.deepEqual(mapping.nodeIds,['n5001','n5002']);
  const extracted=f(`${full}.sktl`),extraction=await call('showkontrol_extract_program_timeline_copy',{source:destination,destination:extracted,sha256:result.sha256,index:0});assert.notEqual(extraction.isError,true,JSON.stringify(extraction));
  const xml=await readFile(extracted,'utf8');assert.match(xml,new RegExp(`id="${mapping.nodeIds[0]}"[^>]*stopped="0"`));assert.match(xml,/>new &amp; safe<\/setting>/);assert.match(xml,/>false<\/setting>/);assert.match(xml,/>hello<\/setting>/);assert.match(xml,new RegExp(`fromNode="${mapping.nodeIds[0]}"[^>]*toNode="${mapping.nodeIds[1]}"`));
  for(const [label,bad] of [['forward',{...edit(0,'trigger.path','bad'),graphFromOperation:99}],['node',{...edit(2,'trigger.path','bad')}],['stopped',edit(0,'node.stopped','invalid')]]){
   const failed=f(`${full}-${label}.skshow`),failure=await call(name,{...base,destination:failed,...wrap([...operations,bad])});assert.equal(failure.isError,true,JSON.stringify(failure));await assert.rejects(readFile(failed),{code:'ENOENT'});
  }
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),show);assert.equal(await readFile(f('cue.skshow'),'utf8'),cueShow);assert.equal(await readFile(f('donor.skf'),'utf8'),patch);
});
