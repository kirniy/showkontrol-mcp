import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readShowPart} from './xml-copy.js';

const hash=(kind,s)=>createHash(kind).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
const parse=response=>{assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};

test('MCP Program and full composers copy, edit and remove item nodes with receipts and rollback',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'item-node-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const program='<skprogram version="1"><item start="0" name="A" notes=""><graph><node id="n5000" type="action"/></graph></item></skprogram>';
 const patch='<showkontrol version="2"><graph><node id="n30" type="groupin"><settings><setting key="custom">old</setting></settings></node></graph><appSettings/></showkontrol>';
 const source=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch)}${part('content/References.skcp','<references target="n5000"/>')}</skshow>`;
 const timeline='<sktimeline version="1"><cue id="src"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>';
 const donor=`<skshow>${part('content/Donor.sktl',timeline)}</skshow>`;
 const patchDonor='<showkontrol version="2"><graph><node id="n2" type="action"/></graph></showkontrol>';
 await Promise.all([writeFile(f('source.skshow'),source),writeFile(f('donor.skshow'),donor),writeFile(f('donor.skf'),patchDonor)]);
 const copy={action:'copy_item_graph_node',index:0,donorType:'cue',donor:f('donor.skshow'),donorSha256:hash('sha256',donor),donorName:'content/Donor.sktl',donorCueId:'src',donorNodeId:'n1'};
 const copyPatch={action:'copy_item_graph_node',index:0,donorType:'patch',donor:f('donor.skf'),donorSha256:hash('sha256',patchDonor),donorFormat:'skf',donorNodeId:'n2'};
 const edit={action:'edit_copied_item_node_setting',index:0,nodeFromOperation:0,key:'trigger.path',value:'edited'};
 const remove={action:'remove_item_graph_node',index:0,nodeId:'n5002'};
 const client=new Client({name:'item-node-integration',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools;
 for(const name of ['showkontrol_compose_program_edits_copy','showkontrol_compose_full_show_copy']){
  const tool=tools.find(t=>t.name===name);assert.ok(tool);for(const action of ['copy_item_graph_node','remove_item_graph_node','edit_copied_item_node_setting'])assert.match(JSON.stringify(tool.inputSchema),new RegExp(action));
 }
 const call=(name,args)=>client.callTool({name,arguments:args});
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy',prefix=full?'full':'program';
  const extra=operations=>full?{patchOperations:[{kind:'setting',nodeId:'n30',key:'custom',value:'new'}],program:{operations}}:{operations};
  const base={source:f('source.skshow'),sha256:hash('sha256',source)};
  const destination=f(`${prefix}.skshow`),result=parse(await call(name,{...base,destination,...extra([copy,copyPatch,edit,remove])}));
  const receipts=(full?result.program:result).copiedItemNodes;
  assert.deepEqual(receipts,[{operationIndex:0,nodeId:'n5001'},{operationIndex:1,nodeId:'n5002'}]);
  const output=(await readShowPart({file:destination,name:'content/Program.skpr'})).text;
  assert.match(output,/<node id="n5001"/);assert.match(output,/>edited<\/setting>/);assert.doesNotMatch(output,/<node id="n5002"/);
  const failed=f(`${prefix}-failed.skshow`),failure=await call(name,{...base,destination:failed,...extra([copy,edit,{action:'remove_item_graph_node',index:0,nodeId:'n5000'}])});
  assert.equal(failure.isError,true,JSON.stringify(failure));assert.match(JSON.stringify(failure),/surviving XML references/);await assert.rejects(readFile(failed),{code:'ENOENT'});
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),source);assert.equal(await readFile(f('donor.skshow'),'utf8'),donor);assert.equal(await readFile(f('donor.skf'),'utf8'),patchDonor);
 assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
});
