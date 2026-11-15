import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {inspectShow} from './xml-copy.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;

test('MCP requires explicit content removal and protects referenced tracks',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'track-remove-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),destination=path.join(dir,'output.skshow');
 const timeline=part('content/alpha.sktl','<sktimeline version="1" name="Alpha"><cue id="c1"/></sktimeline>'),patch=part('patch.skf','<patch/>');
 const client=new Client({name:'track-remove-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=args=>client.callTool({name:'showkontrol_remove_show_track_copy',arguments:args});
 await writeFile(source,`<skshow>${timeline}${patch}</skshow>`);
 let sha256=(await inspectShow({file:source})).sha256;const args={source,destination,sha256,name:'content/alpha.sktl'};
 const missing=await call(args);assert.equal(missing.isError,true);assert.deepEqual(await readdir(dir),['source.skshow']);
 const denied=await call({...args,allowContentRemoval:false});assert.equal(denied.isError,true);assert.deepEqual(await readdir(dir),['source.skshow']);
 const removed=await call({...args,allowContentRemoval:true});assert.equal(removed.isError,undefined,JSON.stringify(removed));assert.equal(JSON.parse(removed.content[0].text).part,'content/alpha.sktl');
 assert.equal(await readFile(destination,'utf8'),`<skshow>${patch}</skshow>`);assert.deepEqual((await inspectShow({file:destination})).parts.map(p=>p.name),['patch.skf']);
 const referenced=path.join(dir,'referenced.skshow'),failed=path.join(dir,'failed.skshow');await writeFile(referenced,`<skshow>${timeline}${patch}${part('set.skls','<sksetlist version="2"><set><entry track="Alpha"/></set></sksetlist>')}</skshow>`);sha256=(await inspectShow({file:referenced})).sha256;
 const rejected=await call({source:referenced,destination:failed,sha256,name:'content/alpha.sktl',allowContentRemoval:true});assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected),/reference/i);assert.deepEqual((await readdir(dir)).sort(),['output.skshow','referenced.skshow','source.skshow']);
});
