import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const part=(name,text,md5=createHash('md5').update(text).digest('hex'))=>`<part name="${name}" md5="${md5}">${Buffer.from(text).toString('base64')}</part>`;

test('MCP cue reference inspection reports bounded, incomplete results and rejects bad checksums',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cue-reference-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow'),name='content/track.sktl';
 const timeline='<sktimeline><cue id="cue1"><graph><node id="n1"/></graph></cue></sktimeline>';
 const parts=[part(name,timeline),...Array.from({length:501},(_,i)=>part(`other${i}.skcp`,'<x ref="cue1">n&#49;</x>'))];
 const show=`<skshow>${parts.join('')}</skshow>`;await writeFile(file,show);
 const client=new Client({name:'cue-reference-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const args={file,name,cueId:'cue1',sha256:createHash('sha256').update(show).digest('hex')};
 const result=await client.callTool({name:'showkontrol_inspect_cue_references',arguments:args});
 assert.equal(result.isError,undefined,JSON.stringify(result));
 const data=JSON.parse(result.content[0].text);
 assert.equal(data.complete,false);assert.equal(data.references.length,500);assert.equal(data.referencesTotal,1002);assert.equal(data.referencesTruncated,true);
 assert.deepEqual(data.references.slice(0,2),[{part:'other0.skcp',type:'cue',id:'cue1'},{part:'other0.skcp',type:'node',id:'n1'}]);
 await writeFile(file,`<skshow>${part(name,timeline,'0'.repeat(32))}</skshow>`);
 const bad=await client.callTool({name:'showkontrol_inspect_cue_references',arguments:{file,name,cueId:'cue1'}});
 assert.equal(bad.isError,true);assert.match(bad.content[0].text,/MD5/i);
});
