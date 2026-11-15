import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readShowPart} from './xml-copy.js';
const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
test('MCP composers resolve created cue selectors for node copy and mapped wire',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'created-node-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const program='<skprogram version="1"><item start="0" name="A" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers></sktimeline></item></skprogram>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><appSettings/><graph/></showkontrol>')}</skshow>`;
 const donor=`<skshow>${part('content/Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n1" type="trigger"/><node id="n2" type="action"/></graph></cue></sktimeline>')}</skshow>`;
 await Promise.all([writeFile(f('source.skshow'),show),writeFile(f('donor.skshow'),donor)]);
 const client=new Client({name:'created-node-selector-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools;
 const add={action:'add_timeline_cue',index:0,layer:0,startMs:0,lengthMs:50,label:'New'};
 const assembly={action:'assemble_timeline_cue_graph',index:0,cueFromOperation:0,nodes:[{kind:'cue',template:f('donor.skshow'),templateSha256:hash('sha256',donor),templateName:'content/Donor.sktl',templateCueId:'d',nodeId:'n2'}]};
 const copy={action:'copy_timeline_cue_node',index:0,cueFromOperation:0,donorType:'cue',donor:f('donor.skshow'),donorSha256:hash('sha256',donor),donorName:'content/Donor.sktl',donorCueId:'d',donorNodeId:'n1'};
 const wire={action:'edit_timeline_graph_wire_mapped',index:0,cueFromOperation:0,operation:'add',from:{nodeFromOperation:2},to:{nodeId:'n3'}};
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy',wrap=operations=>full?{program:{operations}}:{operations};
  const schema=JSON.stringify(tools.find(tool=>tool.name===name)?.inputSchema);assert.match(schema,/cueFromOperation/);
  const base={source:f('source.skshow'),destination:f(`${full}.skshow`),sha256:hash('sha256',show)};
  const response=await client.callTool({name,arguments:{...base,...wrap([add,assembly,copy,wire])}});assert.notEqual(response.isError,true,JSON.stringify(response));
  const result=JSON.parse(response.content[0].text),programResult=full?result.program:result;
  assert.equal(programResult.assembledCueGraphs[0].nodeIds[0],'n3');
  const node=programResult.copiedCueNodes[0].nodeId,xml=(await readShowPart({file:base.destination,name:'content/Program.skpr'})).text;
  assert.ok(xml.includes(`fromNode="${node}" fromPin="0" toNode="n3" toPin="0"`));
  const validation=await client.callTool({name:'showkontrol_validate_show',arguments:{file:base.destination}});assert.notEqual(validation.isError,true,JSON.stringify(validation));
  assert.deepEqual(JSON.parse(validation.content[0].text).diagnostics.filter(d=>d.severity==='error'),[]);
  const failed=f(`${full}-failed.skshow`),failure=await client.callTool({name,arguments:{...base,destination:failed,...wrap([add,assembly,copy,{...wire,cueFromOperation:3}])}});
  assert.equal(failure.isError,true,JSON.stringify(failure));assert.match(JSON.stringify(failure),/prior add_timeline_cue/);
  await assert.rejects(readFile(failed),{code:'ENOENT'});assert.equal(await readFile(base.source,'utf8'),show);
 }
});
