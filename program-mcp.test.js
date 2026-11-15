import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
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
