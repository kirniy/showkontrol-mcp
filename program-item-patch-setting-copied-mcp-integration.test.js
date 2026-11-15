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

test('MCP composers copy patch settings to a copied item node and roll back invalid selectors',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'item-setting-copied-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const program='<skprogram version="1"><item start="0" name="A" notes=""><graph><node id="n1" type="trigger"><settings/></node></graph></item></skprogram>';
 const patch='<showkontrol version="2"><graph><node id="n8" type="router"><settings><setting key="router.name">A</setting></settings></node></graph><appSettings/></showkontrol>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch)}</skshow>`;
 const donor='<showkontrol version="2"><graph><node id="n228" type="action" title="FeedbackNotify"><settings><setting key="action.category">Application</setting><setting key="action.t7">Feedback/Notify</setting><setting key="notify.message">Old</setting><setting key="notify.web">true</setting><setting key="notify.push">false</setting></settings></node><node id="n229" type="action"><settings><setting key="route.router_target">A</setting><setting key="notify.title">Inserted</setting></settings></node></graph><appSettings/></showkontrol>';
 await Promise.all([writeFile(f('source.skshow'),show),writeFile(f('donor.skf'),donor)]);
 const copy={action:'copy_item_graph_node',index:0,donorType:'patch',donor:f('donor.skf'),donorSha256:hash('sha256',donor),donorFormat:'skf',donorNodeId:'n228'};
 const setting={action:'copy_patch_setting_to_item_graph',index:0,nodeFromOperation:0,donor:f('donor.skf'),donorFormat:'skf',donorSha256:hash('sha256',donor),donorNodeId:'n229',key:'route.router_target'};
 const client=new Client({name:'item-setting-copied-integration',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools;const call=(name,args)=>client.callTool({name,arguments:args});
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy',prefix=full?'full':'program';
  const schema=tools.find(tool=>tool.name===name)?.inputSchema;assert.ok(schema);const itemSetting=JSON.stringify(schema);assert.match(itemSetting,/copy_patch_setting_to_item_graph.{0,500}nodeFromOperation/);
  const base={source:f('source.skshow'),sha256:hash('sha256',show)},input=operations=>full?{program:{operations}}:{operations};
  const destination=f(`${prefix}.skshow`),result=parse(await call(name,{...base,destination,...input([copy,setting,{...setting,key:'notify.title'}])}));
  const receipt=(full?result.program:result).copiedItemNodes[0];
  const inspected=parse(await call('showkontrol_inspect_program_item_graph',{file:destination,sha256:result.sha256,index:0}));
  const node=inspected.graph.nodes.find(n=>n.id===receipt.nodeId);assert.ok(node);assert.equal(node.settings.find(s=>s.key==='route.router_target').value,'A');assert.equal(node.settings.find(s=>s.key==='notify.title').value,'Inserted');
  for(const bad of [{...setting,nodeFromOperation:1},{...setting,nodeId:'n1'},{...setting,graphFromOperation:0,nodeIndex:0}]){
   const failed=f(`${prefix}-failed.skshow`),response=await call(name,{...base,destination:failed,...input([copy,bad])});assert.equal(response.isError,true,JSON.stringify(response));await assert.rejects(readFile(failed),{code:'ENOENT'});
  }
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),show);assert.equal(await readFile(f('donor.skf'),'utf8'),donor);assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
});
