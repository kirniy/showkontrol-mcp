import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';import {createHash} from 'node:crypto';import os from 'node:os';import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';import {readShowPart} from './xml-copy.js';
const hash=(a,s)=>createHash(a).update(s).digest('hex');const part=(n,s)=>`<part name="${n}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
test('MCP composers copy show patch setting and wire assembled graph receipts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-setting-wire-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=n=>path.join(dir,n);
 const program='<skprogram version="1"><item start="0" name="A" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="A"/></sktimeline></item></skprogram>';
 const patch=name=>`<showkontrol version="2"><appSettings/><graph><node id="n8" type="router"><settings><setting key="router.name">${name}</setting></settings></node></graph></showkontrol>`;
 const show=name=>`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch(name))}</skshow>`;
 const donor=`<skshow>${part('content/Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n10" type="groupin"/><node id="n11" type="trigger"/><node id="n12" type="action"><settings/></node></graph></cue></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph><node id="n20" type="action"><settings><setting key="route.router_target">A</setting></settings></node></graph></showkontrol>')}</skshow>`;
 await Promise.all([writeFile(file('source.skshow'),show('A')),writeFile(file('bad-router.skshow'),show('B')),writeFile(file('donor.skshow'),donor)]);
 const client=new Client({name:'setting-wire-mcp-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools,donorPath=file('donor.skshow'),donorSha256=hash('sha256',donor);
 const template={template:donorPath,templateSha256:donorSha256,templateName:'content/Donor.sktl',templateCueId:'d'};
 const assemble={action:'assemble_timeline_cue_graph',index:0,cueId:'c1',nodes:[{kind:'cue',...template,nodeId:'n10'}]};
 const copy=id=>({action:'copy_timeline_cue_node',index:0,cueId:'c1',donorType:'cue',donor:donorPath,donorSha256,donorName:'content/Donor.sktl',donorCueId:'d',donorNodeId:id});
 const setting={action:'copy_patch_setting_to_timeline_cue',index:0,cueId:'c1',nodeFromOperation:2,donor:donorPath,donorFormat:'skshow',donorSha256,donorNodeId:'n20',key:'route.router_target'};
 const wire=(from,to)=>({action:'edit_timeline_graph_wire_mapped',index:0,cueId:'c1',operation:'add',from,to});
 const operations=[assemble,copy('n11'),copy('n12'),setting,wire({graphFromOperation:0,nodeIndex:0},{nodeFromOperation:1}),wire({nodeFromOperation:1},{nodeFromOperation:2})];
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy',wrap=operations=>full?{program:{operations}}:{operations};
  const schema=JSON.stringify(tools.find(tool=>tool.name===name)?.inputSchema);assert.match(schema,/copy_patch_setting_to_timeline_cue/);assert.match(schema,/graphFromOperation/);
  const base={source:file('source.skshow'),destination:file(`${full}.skshow`),sha256:hash('sha256',show('A'))};
  const response=await client.callTool({name,arguments:{...base,...wrap(operations)}});assert.notEqual(response.isError,true,JSON.stringify(response));
  const parsed=JSON.parse(response.content[0].text),result=full?parsed.program:parsed,[group]=result.assembledCueGraphs[0].nodeIds,[trigger,action]=result.copiedCueNodes.map(n=>n.nodeId);
  const xml=(await readShowPart({file:base.destination,name:'content/Program.skpr'})).text;
  assert.ok(xml.includes(`fromNode="${group}" fromPin="0" toNode="${trigger}" toPin="0"`));assert.ok(xml.includes(`fromNode="${trigger}" fromPin="0" toNode="${action}" toPin="0"`));assert.match(xml,/<setting key="route.router_target">A<\/setting>/);
  for(const failure of ['router','stale']){
   const destination=file(`${full}-${failure}.skshow`),badBase=failure==='router'?{...base,source:file('bad-router.skshow'),sha256:hash('sha256',show('B')),destination}:{...base,destination};
   const badOps=failure==='stale'?operations.map((op,i)=>i===3?{...op,donorSha256:'0'.repeat(64)}:op):operations;
   const failed=await client.callTool({name,arguments:{...badBase,...wrap(badOps)}});assert.equal(failed.isError,true,JSON.stringify(failed));assert.match(JSON.stringify(failed),failure==='router'?/router target/i:/changed since inspection/i);await assert.rejects(readFile(destination),{code:'ENOENT'});
  }
 }
 assert.equal(await readFile(file('source.skshow'),'utf8'),show('A'));assert.deepEqual((await readdir(dir)).sort(),['bad-router.skshow','donor.skshow','false.skshow','source.skshow','true.skshow']);
});
