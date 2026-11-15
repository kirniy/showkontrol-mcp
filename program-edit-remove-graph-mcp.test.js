import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
test('MCP composers remove a graph, assemble and configure its replacement, and roll back references',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'remove-graph-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const program='<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old"><graph><node id="n3" type="action"/></graph></cue></sktimeline></item></skprogram>';
 const show=reference=>`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',`<showkontrol version="2"><graph>${reference?'<node id="n9" type="action" target="n3"/>':''}</graph><appSettings/></showkontrol>`)}</skshow>`;
 const donor=`<skshow>${part('content/Donor.sktl','<sktimeline version="1"><cue id="donor"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>')}</skshow>`;
 await Promise.all([writeFile(f('source.skshow'),show(false)),writeFile(f('referenced.skshow'),show(true)),writeFile(f('donor.skshow'),donor)]);
 const client=new Client({name:'remove-graph-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name,arguments:args}),tools=(await client.listTools()).tools;
 const operations=[{action:'remove',index:0},{action:'remove_timeline_cue_graph',index:0,cueId:'c1'},{action:'assemble_timeline_cue_graph',index:0,cueId:'c1',nodes:[{kind:'cue',template:f('donor.skshow'),templateSha256:hash('sha256',donor),templateName:'content/Donor.sktl',templateCueId:'donor',nodeId:'n1'}]},{action:'edit_assembled_timeline_graph_setting',index:0,graphFromOperation:2,nodeIndex:0,key:'trigger.path',value:'replacement'}];
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy',wrap=ops=>full?{program:{operations:ops}}:{operations:ops};
  assert.match(JSON.stringify(tools.find(tool=>tool.name===name)?.inputSchema),/remove_timeline_cue_graph/);
  const destination=f(`out-${full}.skshow`),base={source:f('source.skshow'),destination,sha256:hash('sha256',show(false))};
  const response=await call(name,{...base,...wrap(operations)});assert.notEqual(response.isError,true,JSON.stringify(response));
  const result=JSON.parse(response.content[0].text),mapping=(full?result.program:result).assembledCueGraphs[0];assert.equal(mapping.cueId,'c1');
  const timeline=f(`out-${full}.sktl`),extraction=await call('showkontrol_extract_program_timeline_copy',{source:destination,destination:timeline,sha256:result.sha256,index:0});assert.notEqual(extraction.isError,true,JSON.stringify(extraction));
  const xml=await readFile(timeline,'utf8');assert.match(xml,/<cue id="c1"/);assert.doesNotMatch(xml,/id="n3"/);assert.match(xml,/>replacement<\/setting>/);assert.match(xml,new RegExp(`id="${mapping.nodeIds[0]}"`));
  const failed=f(`failed-${full}.skshow`),failure=await call(name,{source:f('referenced.skshow'),destination:failed,sha256:hash('sha256',show(true)),...wrap(operations)});
  assert.equal(failure.isError,true,JSON.stringify(failure));assert.match(JSON.stringify(failure),/surviving XML references/);await assert.rejects(readFile(failed),{code:'ENOENT'});
  assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),show(false));assert.equal(await readFile(f('referenced.skshow'),'utf8'),show(true));
});
