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

test('MCP Program and full composers assemble and edit a direct item graph with rollback',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'item-assembly-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const program='<skprogram version="1"><item start="0" name="A" notes=""/></skprogram>';
 const patch='<showkontrol version="2"><graph><node id="n30" type="groupin"><settings><setting key="custom">old</setting></settings></node></graph><appSettings/></showkontrol>';
 const input=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch)}${part('media/untouched.wav','media')}</skshow>`;
 const timeline='<sktimeline version="1"><cue id="src"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">cue.active</setting><setting key="trigger.on">State On</setting></settings></node></graph></cue></sktimeline>';
 const cue=`<skshow>${part('content/Donor.sktl',timeline)}</skshow>`;
 const donor='<showkontrol version="2"><graph><node id="n228" type="action" x="2603.152" y="120" title="FeedbackNotify" layer="-1" kind=""><settings><setting key="action.category">Application</setting><setting key="action.t7">Feedback/Notify</setting><setting key="notify.title">Test</setting><setting key="notify.message">Message</setting><setting key="notify.web">true</setting><setting key="notify.push">false</setting></settings></node></graph><appSettings/></showkontrol>';
 await Promise.all([writeFile(f('source.skshow'),input),writeFile(f('cue.skshow'),cue),writeFile(f('donor.skf'),donor)]);
 const nodes=[{kind:'cue',template:f('cue.skshow'),templateSha256:hash('sha256',cue),templateName:'content/Donor.sktl',templateCueId:'src',nodeId:'n1'},{kind:'patch',template:f('donor.skf'),templateSha256:hash('sha256',donor),templateFormat:'skf',nodeId:'n228'}];
 const operations=[{action:'assemble_item_graph',index:0,nodes,wires:[{from:0,to:1}]},{action:'edit_assembled_item_graph_setting',index:0,graphFromOperation:0,nodeIndex:1,key:'notify.message',value:'Updated'}];
 const client=new Client({name:'item-assembly-integration',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools;for(const name of ['showkontrol_compose_program_edits_copy','showkontrol_compose_full_show_copy']){const tool=tools.find(t=>t.name===name);assert.ok(tool);const schema=JSON.stringify(tool.inputSchema);assert.match(schema,/assemble_item_graph/);assert.match(schema,/edit_assembled_item_graph_setting/);assert.match(schema,/graphFromOperation/);}
 const call=(name,args)=>client.callTool({name,arguments:args});const base={source:f('source.skshow'),sha256:hash('sha256',input)};
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy',destination=f(full?'full.skshow':'program.skshow');
  const extra=full?{patchOperations:[{kind:'setting',nodeId:'n30',key:'custom',value:'new'}],program:{operations}}:{operations};
  const result=parse(await call(name,{...base,destination,...extra})),receipt=(full?result.program:result).assembledItemGraphs;
  assert.equal(receipt.length,1);assert.equal(receipt[0].operationIndex,0);assert.equal(receipt[0].nodeIds.length,2);assert.ok(receipt[0].nodeIds.every(id=>Number(id.slice(1))>30));
  const inspected=parse(await call('showkontrol_inspect_program_item_graph',{file:destination,sha256:result.sha256,index:0}));assert.deepEqual(inspected.graph.nodes.map(n=>n.id),receipt[0].nodeIds);assert.equal(inspected.graph.nodes[1].settings.find(s=>s.key==='notify.message').value,'Updated');assert.equal(inspected.graph.connections[0].fromNode,receipt[0].nodeIds[0]);assert.equal(inspected.graph.connections[0].toNode,receipt[0].nodeIds[1]);
  const failed=f(full?'failed-full.skshow':'failed-program.skshow'),bad=[...operations,{...operations[1],nodeIndex:9}];const badExtra=full?{...extra,program:{operations:bad}}:{operations:bad};
  const failure=await call(name,{...base,destination:failed,...badExtra});assert.equal(failure.isError,true,JSON.stringify(failure));await assert.rejects(readFile(failed),{code:'ENOENT'});
  const invalid=full?{...extra,program:{operations:[{...operations[0],unexpected:true}]}}:{operations:[{...operations[0],unexpected:true}]};const rejected=await call(name,{...base,destination:failed,...invalid});assert.equal(rejected.isError,true);await assert.rejects(readFile(failed),{code:'ENOENT'});
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),input);assert.equal(await readFile(f('cue.skshow'),'utf8'),cue);assert.equal(await readFile(f('donor.skf'),'utf8'),donor);assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
});
