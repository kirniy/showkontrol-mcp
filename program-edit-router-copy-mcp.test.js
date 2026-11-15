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

test('MCP composers copy a router graph from a show and reject missing router targets',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-router-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const program='<skprogram version="1"><item start="0" name="A" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers></sktimeline></item></skprogram>';
 const patch='<showkontrol version="2"><appSettings/><graph><node id="n50" type="router"><settings><setting key="router.name">A</setting></settings></node></graph></showkontrol>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch)}</skshow>`;
 const timeline=target=>`<sktimeline version="1"><layers/><cue id="donor"><graph><node id="n1" type="groupin"/><node id="n2" type="action"><settings><setting key="route.router_target">${target}</setting></settings></node><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/></graph></cue></sktimeline>`;
 const donor=target=>`<skshow>${part('content/Program.skpr','<skprogram version="1"/>')}${part('content/Timeline.sktl',timeline(target))}</skshow>`;
 const valid=donor('A'),invalid=donor('Missing');
 await writeFile(f('source.skshow'),show);await writeFile(f('donor.skshow'),valid);await writeFile(f('invalid.skshow'),invalid);
 const client=new Client({name:'program-router-copy-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args});
 const add={action:'add_timeline_cue',index:0,layer:0,startMs:100,lengthMs:20,label:'New'};
 const copy=(file,contents)=>({action:'copy_timeline_cue_graph',index:0,cueFromOperation:0,donor:f(file),donorName:'content/Timeline.sktl',donorSha256:hash('sha256',contents),donorCueId:'donor'});
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy';
  const wrap=operations=>full?{program:{operations}}:{operations};
  const base={source:f('source.skshow'),destination:f(`${full}.skshow`),sha256:hash('sha256',show)};
  const response=await call(name,{...base,...wrap([add,copy('donor.skshow',valid)])});assert.notEqual(response.isError,true,JSON.stringify(response));
  const result=JSON.parse(response.content[0].text),out=full?result.program:result,mapping=out.copiedCueGraphs[0];
  const extracted=f(`${full}.sktl`),extraction=await call('showkontrol_extract_program_timeline_copy',{source:base.destination,destination:extracted,sha256:result.sha256,index:0});assert.notEqual(extraction.isError,true,JSON.stringify(extraction));
  const inspection=await call('showkontrol_inspect_cue_graph',{file:extracted,format:'sktl',cueId:mapping.cueId});assert.notEqual(inspection.isError,true,JSON.stringify(inspection));
  const graph=JSON.parse(inspection.content[0].text).graph;
  assert.deepEqual(graph.nodes.map(node=>node.id),[mapping.idMap.n1,mapping.idMap.n2]);
  assert.deepEqual(graph.connections.map(c=>[c.fromNode,c.toNode]),[[mapping.idMap.n1,mapping.idMap.n2]]);
  assert.equal(graph.nodes[1].settings.find(s=>s.key==='route.router_target').value,'A');
  const destination=f(`${full}-invalid.skshow`),failure=await call(name,{...base,destination,...wrap([add,copy('invalid.skshow',invalid)])});
  assert.equal(failure.isError,true,JSON.stringify(failure));assert.match(JSON.stringify(failure),/router target/i);await assert.rejects(readFile(destination),{code:'ENOENT'});
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),show);assert.equal(await readFile(f('donor.skshow'),'utf8'),valid);assert.equal(await readFile(f('invalid.skshow'),'utf8'),invalid);
});
