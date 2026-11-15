import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const hash=(kind,s)=>createHash(kind).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
const parse=response=>{assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};

test('both MCP composers wire copied item nodes and reject stale or wrong-item receipts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'item-wire-copied-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const program='<skprogram version="1"><item start="0" name="A" notes=""><graph><node id="n5000" type="action"/></graph></item><item start="1" name="B" notes=""><graph><node id="n5002" type="action"/></graph></item></skprogram>';
 const patch='<showkontrol version="2"><graph><node id="n30" type="groupin"><settings><setting key="custom">old</setting></settings></node></graph><appSettings/></showkontrol>';
 const source=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch)}</skshow>`;
 const timeline='<sktimeline version="1"><cue id="src"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node></graph></cue></sktimeline>';
 const donor=`<skshow>${part('content/Donor.sktl',timeline)}</skshow>`;
 await Promise.all([writeFile(f('source.skshow'),source),writeFile(f('donor.skshow'),donor)]);
 const copy={action:'copy_item_graph_node',index:0,donorType:'cue',donor:f('donor.skshow'),donorSha256:hash('sha256',donor),donorName:'content/Donor.sktl',donorCueId:'src',donorNodeId:'n1'};
 const wire={action:'edit_item_graph_wire',index:0,operation:'add',from:{nodeFromOperation:0},to:{nodeId:'n5000'}};
 const client=new Client({name:'item-wire-copied-integration',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args});
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy',prefix=full?'full':'program';
  const extra=operations=>full?{patchOperations:[{kind:'setting',nodeId:'n30',key:'custom',value:'new'}],program:{operations}}:{operations};
  const base={source:f('source.skshow'),sha256:hash('sha256',source)},destination=f(`${prefix}.skshow`);
  const result=parse(await call(name,{...base,destination,...extra([copy,wire])}));
  const receipt=(full?result.program:result).copiedItemNodes[0];assert.equal(receipt.operationIndex,0);
  const inspected=parse(await call('showkontrol_inspect_program_item_graph',{file:destination,sha256:result.sha256,index:0}));
  assert.ok(inspected.graph.nodes.some(node=>node.id===receipt.nodeId));
  assert.equal(inspected.graph.connections.length,1);assert.equal(inspected.graph.connections[0].fromNode,receipt.nodeId);assert.equal(inspected.graph.connections[0].toNode,'n5000');
  const failed=f(`${prefix}-failed.skshow`);
  for(const operations of [
   [copy,{action:'remove_item_graph_node',index:0,nodeId:receipt.nodeId},wire],
   [copy,{...wire,index:1,to:{nodeId:'n5002'}}],
  ]){
   const failure=await call(name,{...base,destination:failed,...extra(operations)});
   assert.equal(failure.isError,true,JSON.stringify(failure));assert.match(JSON.stringify(failure),/active prior copy_item_graph_node/);
   await assert.rejects(readFile(failed),{code:'ENOENT'});
  }
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),source);assert.equal(await readFile(f('donor.skshow'),'utf8'),donor);
 assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
});
