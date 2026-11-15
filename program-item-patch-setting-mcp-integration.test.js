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

test('MCP composers copy patch settings into an assembled item graph and roll back invalid operations',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'item-setting-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const program='<skprogram version="1"><item start="0" name="A" notes=""/></skprogram>';
 const patch='<showkontrol version="2"><graph><node id="n8" type="router"><settings><setting key="router.name">A</setting></settings></node></graph><appSettings/></showkontrol>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch)}</skshow>`;
 const timeline='<sktimeline version="1"><cue id="src"><graph><node id="n1" type="action"><settings/></node></graph></cue></sktimeline>';
 const cue=`<skshow>${part('content/Donor.sktl',timeline)}</skshow>`;
 const donor='<showkontrol version="2"><graph><node id="n2" type="action"><settings><setting key="route.router_target">A</setting><setting key="notify.message">Inserted</setting></settings></node></graph><appSettings/></showkontrol>';
 const badRouter=donor.replace('>A</setting>','>Missing</setting>');
 await Promise.all([writeFile(f('source.skshow'),show),writeFile(f('cue.skshow'),cue),writeFile(f('donor.skf'),donor),writeFile(f('bad-router.skf'),badRouter)]);
 const nodes=[{kind:'cue',template:f('cue.skshow'),templateSha256:hash('sha256',cue),templateName:'content/Donor.sktl',templateCueId:'src',nodeId:'n1'}];
 const setting={action:'copy_patch_setting_to_item_graph',index:0,graphFromOperation:0,nodeIndex:0,donor:f('donor.skf'),donorFormat:'skf',donorSha256:hash('sha256',donor),donorNodeId:'n2',key:'route.router_target'};
 const operations=[{action:'assemble_item_graph',index:0,nodes},setting,{...setting,key:'notify.message'}];
 const client=new Client({name:'item-setting-integration',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools;const call=(name,args)=>client.callTool({name,arguments:args});
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy';const schema=JSON.stringify(tools.find(tool=>tool.name===name)?.inputSchema);assert.match(schema,/copy_patch_setting_to_item_graph/);
  const destination=f(full?'full.skshow':'program.skshow'),base={source:f('source.skshow'),sha256:hash('sha256',show)};
  const input=ops=>full?{program:{operations:ops}}:{operations:ops};
  const result=parse(await call(name,{...base,destination,...input(operations)}));const receipt=(full?result.program:result).assembledItemGraphs[0];
  const inspected=parse(await call('showkontrol_inspect_program_item_graph',{file:destination,sha256:result.sha256,index:0}));assert.equal(inspected.graph.nodes[0].id,receipt.nodeIds[0]);
  const settings=inspected.graph.nodes[0].settings;assert.equal(settings.find(s=>s.key==='route.router_target').value,'A');assert.equal(settings.find(s=>s.key==='notify.message').value,'Inserted');
  for(const bad of [{...setting,nodeIndex:9},{...setting,donorSha256:'0'.repeat(64)},{...setting,key:'node.stopped'},{...setting,nodeId:receipt.nodeIds[0]},{...setting,donor:f('bad-router.skf'),donorSha256:hash('sha256',badRouter)}]){
   const failed=f(full?'failed-full.skshow':'failed-program.skshow');const response=await call(name,{...base,destination:failed,...input([operations[0],bad])});assert.equal(response.isError,true,JSON.stringify(response));await assert.rejects(readFile(failed),{code:'ENOENT'});
  }
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),show);assert.equal(await readFile(f('donor.skf'),'utf8'),donor);assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
});
