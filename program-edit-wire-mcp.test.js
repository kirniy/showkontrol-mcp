import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readShowPart} from './xml-copy.js';

const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
test('MCP Program and full composers apply ordered wire edits and roll back later failures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'wire-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=name=>path.join(dir,name);
 const untouched='<graph><node id="n8" type="groupin"/><node id="n9" type="trigger"/><connection fromNode="n8" fromPin="0" toNode="n9" toPin="0"/></graph>';
 const program=`<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="A"><graph><node id="n1" type="groupin"/><node id="n2" type="trigger"/><node id="n4" type="trigger"/><node id="n3" type="action"/><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/><connection fromNode="n2" fromPin="0" toNode="n3" toPin="0"/></graph></cue><cue id="c2" layer="0" startMs="100" lenMs="100" label="B">${untouched}</cue></sktimeline></item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><appSettings/><graph/></showkontrol>')}</skshow>`;
 await writeFile(f('source.skshow'),show);
 const client=new Client({name:'wire-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools;
 const edit=(operation,fromNode)=>({action:'edit_timeline_graph_wire',index:0,cueId:'c1',operation,fromNode,toNode:'n3'});
 const operations=[{action:'remove',index:0},edit('remove','n2'),edit('add','n4')];
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy',wrap=ops=>full?{program:{operations:ops}}:{operations:ops};
  assert.match(JSON.stringify(tools.find(tool=>tool.name===name)?.inputSchema),/edit_timeline_graph_wire/);
  const destination=f(`out-${full}.skshow`),base={source:f('source.skshow'),destination,sha256:hash('sha256',show)};
  const response=await client.callTool({name,arguments:{...base,...wrap(operations)}});assert.notEqual(response.isError,true,JSON.stringify(response));
  const result=JSON.parse(response.content[0].text),xml=(await readShowPart({file:destination,name:'content/Program.skpr'})).text;
  assert.ok(xml.includes(untouched));assert.ok(!xml.includes('fromNode="n2" fromPin="0" toNode="n3"'));assert.ok(xml.includes('fromNode="n4" fromPin="0" toNode="n3"'));
  assert.ok((full?result.program:result).warnings.some(w=>w.includes('fixture-supported pin 0 connection')));
  const failed=f(`failed-${full}.skshow`),failure=await client.callTool({name,arguments:{...base,destination:failed,...wrap([...operations,{action:'edit',index:99,name:'bad'}])}});
  assert.equal(failure.isError,true,JSON.stringify(failure));assert.match(JSON.stringify(failure),/Item index out of range/);await assert.rejects(readFile(failed),{code:'ENOENT'});
  assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),show);
});
