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
test('MCP Program and full composers copy two graphs and roll back invalid selectors',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-graph-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const timeline='<sktimeline version="1"><layers><layer name="Base"/></layers><cue id="old" layer="0" startMs="0" lenMs="10" label="Old"><graph><node id="n50" type="trigger"/></graph></cue></sktimeline>';
 const program=`<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes="">${timeline}</item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}</skshow>`;
 const donor='<sktimeline version="1"><layers/><cue id="donor"><graph><node id="n1" type="groupin"/><node id="n2" type="action"/><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/></graph></cue></sktimeline>';
 await writeFile(f('source.skshow'),show);await writeFile(f('donor.sktl'),donor);
 const client=new Client({name:'program-graph-copy-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools,call=(name,args)=>client.callTool({name,arguments:args});
 const add=label=>({action:'add_timeline_cue',index:1,layer:0,startMs:100,lengthMs:20,label});
 const copy=cueFromOperation=>({action:'copy_timeline_cue_graph',index:1,cueFromOperation,donor:f('donor.sktl'),donorSha256:hash('sha256',donor),donorCueId:'donor'});
 const operations=[add('First'),copy(0),add('Second'),copy(2)];
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy';
  assert.match(JSON.stringify(tools.find(tool=>tool.name===name)?.inputSchema),/copy_timeline_cue_graph/);
  const base={source:f('source.skshow'),destination:f(`${full}.skshow`),sha256:hash('sha256',show)};
  const wrap=operations=>full?{program:{operations}}:{operations};
  const response=await call(name,{...base,...wrap(operations)});assert.notEqual(response.isError,true,JSON.stringify(response));
  const result=JSON.parse(response.content[0].text),out=full?result.program:result;
  assert.equal(out.createdCues.length,2);assert.equal(out.copiedCueGraphs.length,2);
  const first=out.copiedCueGraphs[0],second=out.copiedCueGraphs[1];
  assert.equal(first.cueId,out.createdCues[0].id);assert.equal(second.cueId,out.createdCues[1].id);
  assert.equal(new Set([...Object.values(first.idMap),...Object.values(second.idMap),'n50']).size,5);
  const extracted=f(`${full}.sktl`);
  const extraction=await call('showkontrol_extract_program_timeline_copy',{source:base.destination,destination:extracted,sha256:result.sha256,index:1});assert.notEqual(extraction.isError,true,JSON.stringify(extraction));
  for(const mapping of [first,second]){
   const inspection=await call('showkontrol_inspect_cue_graph',{file:extracted,format:'sktl',cueId:mapping.cueId});assert.notEqual(inspection.isError,true,JSON.stringify(inspection));
   const graph=JSON.parse(inspection.content[0].text).graph;
   assert.deepEqual(graph.nodes.map(node=>node.id),[mapping.idMap.n1,mapping.idMap.n2]);
   assert.deepEqual(graph.connections.map(c=>[c.fromNode,c.toNode]),[[mapping.idMap.n1,mapping.idMap.n2]]);
  }
  for(const [label,badOps] of [
   ['forward',[add('First'),copy(2),add('Second')]],
   ['wrong-item',[add('First'),{...copy(0),index:0}]],
   ['later-failure',[...operations,{action:'edit',index:99,name:'bad'}]],
   ['stale-donor',[add('First'),{...copy(0),donorSha256:'0'.repeat(64)}]]
  ]){
   const destination=f(`${full}-${label}.skshow`);const failure=await call(name,{...base,destination,...wrap(badOps)});
   assert.equal(failure.isError,true,JSON.stringify(failure));await assert.rejects(readFile(destination),{code:'ENOENT'});
  }
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),show);assert.equal(await readFile(f('donor.sktl'),'utf8'),donor);
});
