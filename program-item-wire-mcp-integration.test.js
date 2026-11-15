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

test('MCP Program and full composers add and remove direct item graph wires with rollback',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'item-assembly-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const program='<skprogram version="1"><item start="0" name="A" notes=""/></skprogram>';
 const patch='<showkontrol version="2"><graph><node id="n30" type="groupin"><settings><setting key="custom">old</setting></settings></node></graph><appSettings/></showkontrol>';
 const input=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch)}${part('media/untouched.wav','media')}</skshow>`;
 const timeline='<sktimeline version="1"><cue id="src"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node></graph></cue></sktimeline>';
 const cue=`<skshow>${part('content/Donor.sktl',timeline)}</skshow>`;
 const donor='<showkontrol version="2"><graph><node id="n228" type="action" x="2603.152" y="120" title="FeedbackNotify" layer="-1" kind=""><settings><setting key="action.category">Application</setting><setting key="action.t7">Feedback/Notify</setting><setting key="notify.title">Test</setting><setting key="notify.message">Message</setting><setting key="notify.web">true</setting><setting key="notify.push">false</setting></settings></node></graph><appSettings/></showkontrol>';
 await Promise.all([writeFile(f('source.skshow'),input),writeFile(f('cue.skshow'),cue),writeFile(f('donor.skf'),donor)]);
 const nodes=[{kind:'cue',template:f('cue.skshow'),templateSha256:hash('sha256',cue),templateName:'content/Donor.sktl',templateCueId:'src',nodeId:'n1'},{kind:'patch',template:f('donor.skf'),templateSha256:hash('sha256',donor),templateFormat:'skf',nodeId:'n228'}];
 const endpoint=nodeIndex=>({graphFromOperation:0,nodeIndex});
 const add={action:'edit_item_graph_wire',index:0,operation:'add',from:endpoint(0),to:endpoint(1)};
 const operations=[{action:'assemble_item_graph',index:0,nodes},add];
 const client=new Client({name:'item-wire-integration',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools;for(const name of ['showkontrol_compose_program_edits_copy','showkontrol_compose_full_show_copy']){const tool=tools.find(t=>t.name===name);assert.ok(tool);assert.match(JSON.stringify(tool.inputSchema),/edit_item_graph_wire/);}
 const call=(name,args)=>client.callTool({name,arguments:args});const base={source:f('source.skshow'),sha256:hash('sha256',input)};
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy',prefix=full?'full':'program',destination=f(`${prefix}.skshow`);
  const extra=ops=>full?{patchOperations:[{kind:'setting',nodeId:'n30',key:'custom',value:'new'}],program:{operations:ops}}:{operations:ops};
  const result=parse(await call(name,{...base,destination,...extra(operations)})),receipt=(full?result.program:result).assembledItemGraphs;
  assert.equal(receipt.length,1);const ids=receipt[0].nodeIds;assert.equal(ids.length,2);
  const inspect=async(file,sha256)=>parse(await call('showkontrol_inspect_program_item_graph',{file,sha256,index:0}));
  const added=await inspect(destination,result.sha256);assert.deepEqual(added.graph.nodes.map(n=>n.id),ids);assert.equal(added.graph.connections.length,1);assert.equal(added.graph.connections[0].fromNode,ids[0]);assert.equal(added.graph.connections[0].toNode,ids[1]);
  const removedPath=f(`${prefix}-removed.skshow`),remove={...add,operation:'remove',from:{nodeId:ids[0]},to:{nodeId:ids[1]}};
  const removed=parse(await call(name,{source:destination,sha256:result.sha256,destination:removedPath,...(full?{program:{operations:[remove]}}:{operations:[remove]})}));
  const inspected=await inspect(removedPath,removed.sha256);assert.deepEqual(inspected.graph.nodes.map(n=>n.id),ids);assert.equal(inspected.graph.connections.length,0);
  const failed=f(`${prefix}-failed.skshow`);
  for(const invalid of [
   [...operations,{...add,from:endpoint(9)}],
   [{...operations[0]}, {...add,from:{nodeId:'n1',nodeIndex:0}}],
  ]){
   const failure=await call(name,{...base,destination:failed,...extra(invalid)});assert.equal(failure.isError,true,JSON.stringify(failure));await assert.rejects(readFile(failed),{code:'ENOENT'});
  }
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),input);assert.equal(await readFile(f('cue.skshow'),'utf8'),cue);assert.equal(await readFile(f('donor.skf'),'utf8'),donor);assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
});
