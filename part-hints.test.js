import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const hash=(algorithm,text)=>createHash(algorithm).update(text).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;
const timeline=name=>`<sktimeline version="1" name="${name}"><layers><layer/></layers></sktimeline>`;

test('a wrong timeline part name is answered with the parts that match',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-part-hints-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow'),many=path.join(dir,'many.skshow'),dup=path.join(dir,'dup.skshow');
 const patch=part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>');
 const xml=`<skshow>${part('content/Intro.sktl',timeline('Intro'))}${part('content/Main.sktl',timeline('Main Set'))}${patch}</skshow>`;await writeFile(file,xml);
 await writeFile(many,`<skshow>${Array.from({length:12},(_,i)=>part(`content/T${i}.sktl`,timeline(`T${i}`))).join('')}${patch}</skshow>`);
 await writeFile(dup,`<skshow>${part('content/A.sktl',timeline('A'))}${part('content/A.sktl',timeline('A'))}${patch}</skshow>`);
 const client=new Client({name:'part-hints-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const text=async(tool,args)=>{const response=await client.callTool({name:tool,arguments:args});assert.equal(response.isError,true,JSON.stringify(response));return response.content[0].text;};
 assert.equal(await text('showkontrol_inspect_show_timeline',{file,name:'Main Set'}),'Select a .sktl part. "Main Set" is the track name of "content/Main.sktl"; pass the part name.');
 assert.equal(await text('showkontrol_inspect_show_timeline',{file,name:'content/intro.sktl'}),'Part name must match exactly one part. Part names are case-sensitive: "content/Intro.sktl".');
 assert.equal(await text('showkontrol_add_show_timeline_cue_copy',{source:file,destination:path.join(dir,'out.skshow'),sha256:hash('sha256',xml),name:'Outro',layer:0,startMs:0,lengthMs:1,label:'x'}),
  'Select a .sktl part. Timeline parts: "content/Intro.sktl", "content/Main.sktl".');
 assert.match(await text('showkontrol_inspect_show_timeline',{file:many,name:'content/X.sktl'}),/Timeline parts: "content\/T0\.sktl", .*"content\/T9\.sktl" and 2 more\.$/);
 assert.equal(await text('showkontrol_inspect_show_timeline',{file:dup,name:'content/A.sktl'}),'Part name must match exactly one part. The show has 2 parts named "content/A.sktl".');
 // A show that cannot be read keeps the original message.
 assert.equal(await text('showkontrol_inspect_show_timeline',{file:path.join(dir,'absent.skshow'),name:'Intro'}),'Select a .sktl part');
});
