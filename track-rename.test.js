import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {inspectShow,readShowPart} from './xml-copy.js';
import {renameShowTrackCopy} from './track-rename.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('renames timeline and exact entries across set lists while preserving other parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rename-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in'),destination=path.join(dir,'out');
 const timeline=`<sktimeline version='1' name='A &amp; B'><cue><graph><node id="n"/></graph></cue></sktimeline>`,set1=`<sksetlist version="2"><set><entry track='A &amp; B'/><entry track="Other"/></set></sksetlist>`,set2=`<sksetlist version="2"><set><entry track="A &amp; B"/></set></sksetlist>`,media=part('media.bin','media');
 const original=`<skshow>${part('a.sktl',timeline)}${part('one.skls',set1)}${part('two.SKLS',set2)}${media}</skshow>`;await writeFile(source,original);const sha256=(await inspectShow({file:source})).sha256;
 const result=await renameShowTrackCopy({source,destination,sha256,oldName:'A & B',newName:`C "D" & E's`});assert.equal(result.entries,2);assert.equal((await readShowPart({file:destination,name:'a.sktl'})).text,timeline.replace('A &amp; B','C &quot;D&quot; &amp; E&apos;s'));assert.match((await readShowPart({file:destination,name:'one.skls'})).text,/Other/);assert.ok((await readFile(destination,'utf8')).includes(media));assert.equal(await readFile(source,'utf8'),original);
 await assert.rejects(renameShowTrackCopy({source,destination,sha256,oldName:'A & B',newName:'New'}),/EEXIST/);assert.deepEqual((await readdir(dir)).sort(),['in','out']);
});
test('rejects collisions, invalid structures and checksums without output',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rename-fail-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in'),destination=path.join(dir,'out');
 for(const parts of [[part('a.sktl','<sktimeline version="1" name="A"/>'),part('b.sktl','<sktimeline version="1" name="B"/>')],[part('a.sktl','<sktimeline version="1" name="A"/>'),part('a.sktl','<sktimeline version="1" name="A"/>')],[part('a.sktl','<sktimeline version="1" name="A"/>'),part('b.sktl','<sktimeline version="1" name="A"/>')],[part('a.sktl','<sktimeline version="1" name="A"/>'),part('x.skls','<sksetlist version="3"/>')],[part('a.sktl','<sktimeline version="1" name="A"/>').replace(/md5="[^"]+"/,'md5="00000000000000000000000000000000"')]]){
  await writeFile(source,`<skshow>${parts.join('')}</skshow>`);const sha256=(await inspectShow({file:source})).sha256;await assert.rejects(renameShowTrackCopy({source,destination,sha256,oldName:'A',newName:'B'}));assert.deepEqual(await readdir(dir),['in']);
 }
});
test('MCP interface performs rename and removes intermediates after a later edit failure',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'rename-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in'),destination=path.join(dir,'out');
 const timeline=part('a.sktl','<sktimeline version="1" name="A"/>'),set=part('s.skls','<sksetlist version="2"><set><entry track="A"/></set></sksetlist>');
 const client=new Client({name:'rename-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=args=>client.callTool({name:'showkontrol_rename_show_track_copy',arguments:args});
 await writeFile(source,`<skshow>${timeline}${set}</skshow>`);let sha256=(await inspectShow({file:source})).sha256;const ok=await call({source,destination,sha256,oldName:'A',newName:'B'});assert.equal(ok.isError,undefined,JSON.stringify(ok));assert.equal(JSON.parse(ok.content[0].text).entries,1);
 const malformed=set.replace(/md5="(.)/,(_,c)=>`md5="&#x${c.charCodeAt(0).toString(16)};`);await writeFile(source,`<skshow>${timeline}${malformed}</skshow>`);sha256=(await inspectShow({file:source})).sha256;const failure=await call({source,destination:path.join(dir,'failed'),sha256,oldName:'A',newName:'B'});assert.equal(failure.isError,true);assert.deepEqual((await readdir(dir)).sort(),['in','out']);
});
test('rejects case-insensitive timeline collisions and permits a unique case-only rename',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rename-case-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in'),destination=path.join(dir,'out');
 const timeline=name=>part(`${name}.sktl`,`<sktimeline version="1" name="${name}"/>`);
 for(const other of ['alpha','BETA']){
  await writeFile(source,`<skshow>${timeline('Alpha')}${timeline(other)}</skshow>`);const sha256=(await inspectShow({file:source})).sha256;
  await assert.rejects(renameShowTrackCopy({source,destination,sha256,oldName:'Alpha',newName:'Beta'}),/conflicts|already exists/);assert.deepEqual(await readdir(dir),['in']);
 }
 await writeFile(source,`<skshow>${timeline('Alpha')}${part('s.skls','<sksetlist version="2"><set><entry track="Alpha"/></set></sksetlist>')}</skshow>`);const sha256=(await inspectShow({file:source})).sha256;
 await renameShowTrackCopy({source,destination,sha256,oldName:'Alpha',newName:'alpha'});assert.match((await readShowPart({file:destination,name:'Alpha.sktl'})).text,/name="alpha"/);assert.match((await readShowPart({file:destination,name:'s.skls'})).text,/track="alpha"/);
});
