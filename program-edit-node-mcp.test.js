import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
test('MCP composers copy, edit and remove cue nodes and roll back referenced removal',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-node-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const timeline='<sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old"><graph><node id="n3" type="action"/></graph></cue></sktimeline>';
 const program=`<skprogram version="1"><item start="0" name="A" notes=""><graph><node id="n5000" type="action"/></graph>${timeline}</item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 const cueShow=`<skshow>${part('content/Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>')}</skshow>`;
 const patch='<showkontrol version="2"><graph><node id="n2" type="action"/></graph></showkontrol>';
 await Promise.all([writeFile(f('source.skshow'),show),writeFile(f('cue.skshow'),cueShow),writeFile(f('donor.skf'),patch)]);
 const client=new Client({name:'program-node-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools,call=(name,args)=>client.callTool({name,arguments:args});
 const cue={action:'copy_timeline_cue_node',index:0,cueId:'c1',donorType:'cue',donor:f('cue.skshow'),donorSha256:hash('sha256',cueShow),donorName:'content/Donor.sktl',donorCueId:'d',donorNodeId:'n1'};
 const patchNode={action:'copy_timeline_cue_node',index:0,cueId:'c1',donorType:'patch',donor:f('donor.skf'),donorSha256:hash('sha256',patch),donorFormat:'skf',donorNodeId:'n2'};
 const edit={action:'edit_copied_timeline_node_setting',index:0,nodeFromOperation:0,key:'trigger.path',value:'new & safe'};
 const remove={action:'remove_timeline_cue_node',index:0,cueId:'c1',nodeId:'n3'};
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy';
  const schema=JSON.stringify(tools.find(tool=>tool.name===name)?.inputSchema);for(const action of [cue.action,edit.action,remove.action])assert.ok(schema.includes(action));
  const destination=f(`${full}.skshow`),base={source:f('source.skshow'),destination,sha256:hash('sha256',show)},wrap=operations=>full?{program:{operations}}:{operations};
  const response=await call(name,{...base,...wrap([cue,patchNode,edit,remove])});assert.notEqual(response.isError,true,JSON.stringify(response));
  const result=JSON.parse(response.content[0].text),out=full?result.program:result;
  assert.deepEqual(out.copiedCueNodes,[{operationIndex:0,cueId:'c1',nodeId:'n5001'},{operationIndex:1,cueId:'c1',nodeId:'n5002'}]);
  const extracted=f(`${full}.sktl`),readback=await call('showkontrol_extract_program_timeline_copy',{source:destination,destination:extracted,sha256:result.sha256,index:0});assert.notEqual(readback.isError,true,JSON.stringify(readback));
  const xml=await readFile(extracted,'utf8');assert.match(xml,/id="n5001"/);assert.match(xml,/id="n5002"/);assert.match(xml,/>new &amp; safe<\/setting>/);assert.doesNotMatch(xml,/id="n3"/);
  const failurePath=f(`${full}-failed.skshow`),wire={action:'edit_timeline_graph_wire',index:0,cueId:'c1',operation:'add',fromNode:'n5001',toNode:'n3'};
  const failure=await call(name,{...base,destination:failurePath,...wrap([cue,wire,remove])});assert.equal(failure.isError,true,JSON.stringify(failure));assert.match(failure.content[0].text,/reference/i);await assert.rejects(readFile(failurePath),{code:'ENOENT'});
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),show);assert.equal(await readFile(f('cue.skshow'),'utf8'),cueShow);assert.equal(await readFile(f('donor.skf'),'utf8'),patch);
 assert.ok(!(await readdir(dir)).some(name=>name.startsWith('.showkontrol-')));
});
