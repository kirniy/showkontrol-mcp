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
 assert.equal(await text('showkontrol_inspect_show_timeline',{file,name:'Main Set'}),'Select a .sktl part. name: "Main Set" is the track name of "content/Main.sktl"; pass the part name.');
 assert.equal(await text('showkontrol_inspect_show_timeline',{file,name:'content/intro.sktl'}),'Part name must match exactly one part. name: part names are case-sensitive: "content/Intro.sktl".');
 assert.equal(await text('showkontrol_add_show_timeline_cue_copy',{source:file,destination:path.join(dir,'out.skshow'),sha256:hash('sha256',xml),name:'Outro',layer:0,startMs:0,lengthMs:1,label:'x'}),
  'Select a .sktl part. name: timeline parts are "content/Intro.sktl", "content/Main.sktl".');
 assert.match(await text('showkontrol_inspect_show_timeline',{file:many,name:'content/X.sktl'}),/name: timeline parts are "content\/T0\.sktl", .*"content\/T9\.sktl" and 2 more\.$/);
 assert.equal(await text('showkontrol_inspect_show_timeline',{file:dup,name:'content/A.sktl'}),'Part name must match exactly one part. name: the show has 2 parts named "content/A.sktl".');
 // Donor and template part names are checked against their own files.
 const sha=hash('sha256',xml),out=path.join(dir,'o.skshow');
 assert.equal(await text('showkontrol_copy_cue_graph_show_copy',{source:file,destination:out,sha256:sha,name:'content/Main.sktl',sourceName:'Intro',template:file,templateSha256:sha,sourceCueId:'a',targetCueId:'b'}),
  'Select .sktl parts. sourceName: "Intro" is the track name of "content/Intro.sktl"; pass the part name.');
 assert.equal(await text('showkontrol_copy_cue_graph_node_show_copy',{source:file,destination:out,sha256:sha,name:'Intro',cueId:'a',template:many,templateSha256:'0'.repeat(64),templateName:'T3',templateCueId:'b',nodeId:'n1'}),
  'Select timeline parts. name: "Intro" is the track name of "content/Intro.sktl"; pass the part name. templateName: "T3" is the track name of "content/T3.sktl"; pass the part name.');
 assert.equal(await text('showkontrol_copy_patch_node_to_cue_show_copy',{source:file,destination:out,sha256:sha,name:'Main Set',cueId:'a',template:file,templateFormat:'skshow',templateSha256:sha,nodeId:'n1'}),
  'Select a .sktl part. name: "Main Set" is the track name of "content/Main.sktl"; pass the part name.');
 const program=path.join(dir,'p.skpr'),programXml='<skprogram version="1"><item start="0" name="I" notes=""/></skprogram>';await writeFile(program,programXml);
 assert.equal(await text('showkontrol_embed_program_timeline_copy',{source:program,destination:path.join(dir,'o.skpr'),sha256:hash('sha256',programXml),index:0,donor:file,donorSha256:sha,donorName:'Main Set'}),
  'A .sktl donor part name is required. donorName: "Main Set" is the track name of "content/Main.sktl"; pass the part name.');
 // A show that cannot be read keeps the original message.
 assert.equal(await text('showkontrol_inspect_show_timeline',{file:path.join(dir,'absent.skshow'),name:'Intro'}),'Select a .sktl part');
});
