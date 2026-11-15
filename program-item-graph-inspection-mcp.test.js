import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const digest=(alg,s)=>createHash(alg).update(s).digest('hex');
const part=(name,s,md5=digest('md5',s))=>`<part name="${name}" md5="${md5}">${Buffer.from(s).toString('base64')}</part>`;
const program=graph=>`<skprogram version="1"><item start="0" name="A" notes="">${graph}</item><item start="1" name="B" notes=""/></skprogram>`;
test('MCP inspects Program item graphs from checked snapshots',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-graph-inspect-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'graph-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 const file=path.join(dir,'a.skpr'),show=path.join(dir,'a.skshow');
 const graph='<graph><node id="n1" type="trigger" title="Start"><settings><setting key="trigger.path">item.active &amp; more</setting></settings></node><node id="n2" type="action"/><connection fromNode="n1" toNode="n2" fromPin="0" toPin="1"/></graph>';
 const p=program(graph),archive=`<skshow>${part('content/Program.skpr',p)}</skshow>`;await writeFile(file,p);await writeFile(show,archive);
 const call=(f,s,index=0)=>client.callTool({name:'showkontrol_inspect_program_item_graph',arguments:{file:f,sha256:digest('sha256',s),index}});
 for(const [f,s] of [[file,p],[show,archive]]){const r=await call(f,s);assert.equal(r.isError,undefined,JSON.stringify(r));const data=JSON.parse(r.content[0].text);assert.equal(data.graph.nodes[0].settings[0].value,'item.active & more');assert.equal(data.graph.nodes[1].type,'action');assert.equal(data.graph.connections[0].toPin,'1');assert.match(data.note,/unverified/);}
 assert.equal((await call(file,p,1)).isError,true);assert.equal((await call(file,p,2)).isError,true);assert.equal((await call(file,'wrong')).isError,true);
 for(const badGraph of [graph.replace('id="n2"','id="n1"'),graph.replace('toNode="n2"','toNode="missing"'),graph.replace('</settings>','<setting key="trigger.path">x</setting></settings>'),graph.replace('item.active &amp; more','<other/>'),graph.replace('</graph>','<unknown/></graph>'),graph+'<graph/>']){const bad=program(badGraph);await writeFile(file,bad);assert.equal((await call(file,bad)).isError,true);}
 for(const bad of [`<skshow>${part('x','ok')}</skshow>`,`<skshow>${part('content/Program.skpr',p,'0'.repeat(32))}</skshow>`,`<skshow>${part('content/Program.skpr',p)}${part('content/Program.skpr',p)}</skshow>`]){await writeFile(show,bad);assert.equal((await call(show,bad)).isError,true);}
 const big=program(`<graph><node id="n" type="action"><settings><setting key="k">${'x'.repeat(1100000)}</setting></settings></node></graph>`);await writeFile(file,big);const limited=await call(file,big);assert.equal(limited.isError,true);assert.match(limited.content[0].text,/1 MiB/);
});
