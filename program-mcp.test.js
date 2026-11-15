import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP creates, inspects and edits standalone Program copies',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'program-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name:`showkontrol_${name}`,arguments:args});
 const a=path.join(dir,'Program.skpr'),b=path.join(dir,'copy.skpr');
 const created=await call('create_program_copy',{destination:a});assert.equal(created.isError,undefined);
 const inspected=await call('inspect_program',{file:a});const info=JSON.parse(inspected.content[0].text);assert.deepEqual(info.items,[]);
 const edited=await call('create_program_copy',{source:a,destination:b,sha256:info.sha256,operation:{action:'add',start:123,name:'Artist',notes:'Notes'}});assert.equal(edited.isError,undefined);
 const result=JSON.parse((await call('inspect_program',{file:b})).content[0].text);assert.equal(result.items[0].name,'Artist');
 const invalid=await call('create_program_copy',{source:a,destination:b,sha256:info.sha256,operation:{action:'add',start:-1,name:'',notes:''}});assert.equal(invalid.isError,true);
});

test('MCP creates ordered Programs atomically and rejects invalid batches',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-batch-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'program-batch-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 const call=args=>client.callTool({name:'showkontrol_create_program_copy',arguments:args});
 const destination=path.join(dir,'batch.skpr'),bad=path.join(dir,'bad.skpr');
 const items=[{start:900,name:'Later & first',notes:'A'}, {start:0,name:'Earlier',notes:'B'}];
 const created=await call({destination,items});assert.equal(created.isError,undefined);
 assert.deepEqual(JSON.parse(created.content[0].text).items.map(({start,name,notes})=>({start,name,notes})),items);
 const invalid=await call({destination:bad,items:[items[0],{start:-1,name:'bad',notes:''}]});assert.equal(invalid.isError,true);await assert.rejects(readFile(bad),{code:'ENOENT'});
 const sentinel=Buffer.from('existing');await writeFile(bad,sentinel);const conflict=await call({destination:bad,items});assert.equal(conflict.isError,true);assert.deepEqual(await readFile(bad),sentinel);
 assert.equal((await call({destination:bad,source:destination,items})).isError,true);
 assert.equal((await call({destination:bad,items,operation:{action:'add',...items[0]}})).isError,true);
 assert.equal((await call({destination:path.join(dir,'many.skpr'),items:Array(1001).fill(items[0])})).isError,true);
});

test('MCP exposes Program timeline embedding',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-embed-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'program-embed-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 const call=(name,args)=>client.callTool({name:`showkontrol_${name}`,arguments:args});
 const source=path.join(dir,'source.skpr'),donor=path.join(dir,'donor.sktl'),destination=path.join(dir,'out.skpr');
 await call('create_program_copy',{destination:source,items:[{start:0,name:'A',notes:''}]});await writeFile(donor,'<sktimeline version="1"/>');
 const program=JSON.parse((await call('inspect_program',{file:source})).content[0].text),timeline=JSON.parse((await call('inspect_timeline',{file:donor})).content[0].text);
 const result=await call('embed_program_timeline_copy',{source,destination,sha256:program.sha256,index:0,donor,donorSha256:timeline.sha256});assert.equal(result.isError,undefined);assert.equal(JSON.parse(result.content[0].text).items[0].hasTimeline,true);
});
