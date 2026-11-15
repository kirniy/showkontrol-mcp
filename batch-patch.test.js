import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {inspectPatch} from './patch.js';

test('MCP batch patch edits are ordered, atomic and checksum guarded',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-batch-patch-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skf'),template=path.join(dir,'donor.skf'),destination=path.join(dir,'out.skf');
 const xml='<showkontrol version="2"><graph><node id="n1" type="x" title="Original"><settings><setting key="level">old</setting></settings></node></graph><appSettings/></showkontrol>';
 await writeFile(source,xml);await writeFile(template,xml);
 const sha256=(await inspectPatch({file:source,format:'skf'})).sha256,templateSha256=(await inspectPatch({file:template,format:'skf'})).sha256;
 const client=new Client({name:'test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 const tool='showkontrol_edit_patch_batch_copy';assert.ok((await client.listTools()).tools.some(x=>x.name===tool));
 const args={source,destination,format:'skf',sha256,operations:[{kind:'copy_node',template,templateFormat:'skf',templateSha256,nodeId:'n1',newNodeId:'n2'},{kind:'setting',nodeId:'n2',key:'level',value:'new & value'},{kind:'graph',operation:'add_connection',connection:{fromNode:'n1',fromPin:0,toNode:'n2',toPin:1}}]};
 const result=await client.callTool({name:tool,arguments:args});assert.notEqual(result.isError,true);
 const patch=await inspectPatch({file:destination,format:'skf'});assert.equal(patch.nodes[1].settings[0].value,'new & value');assert.equal(patch.connections.length,1);assert.equal(await readFile(source,'utf8'),xml);
 assert.equal((await client.callTool({name:tool,arguments:args})).isError,true);
 const bad=path.join(dir,'bad.skf');const failure=await client.callTool({name:tool,arguments:{...args,destination:bad,operations:[args.operations[0],{...args.operations[1],key:'missing'}]}});assert.equal(failure.isError,true);await assert.rejects(readFile(bad),{code:'ENOENT'});
 const stale=await client.callTool({name:tool,arguments:{...args,destination:bad,operations:[{kind:'setting',nodeId:'n1',key:'level',value:'first'},{...args.operations[0],templateSha256:'0'.repeat(64)}]}});assert.equal(stale.isError,true);await assert.rejects(readFile(bad),{code:'ENOENT'});
 assert.equal((await client.callTool({name:tool,arguments:{...args,destination:bad,sha256:'0'.repeat(64)}})).isError,true);
 assert.equal((await client.callTool({name:tool,arguments:{...args,destination:bad,operations:[]}})).isError,true);
 assert.equal((await readdir(dir)).filter(x=>x.startsWith('.showkontrol-patch-')).length,0);
});
