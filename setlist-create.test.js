import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {createShowSetlistCopy} from './setlist-create.js';
import {inspectShow,readShowPart} from './xml-copy.js';
import {parseSetlist} from './setlist.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('create a fixture-shaped set list with existing tracks, preserving source and other parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-create-set-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),destination=path.join(dir,'out.skshow');const timeline=part('content/A.sktl','<sktimeline version="1" name="A &amp; B"/>');
 const original=`<?xml version="1.0"?><skshow><!-- keep -->${timeline}${part('patch.skf','<showkontrol/>')}</skshow>`;await writeFile(source,original);
 const {sha256}=await inspectShow({file:source});const args={source,destination,sha256,name:'content/Setlist.skls',setName:'Set & 1',tracks:['A & B']};
 await createShowSetlistCopy(args);const xml=(await readShowPart({file:destination,name:args.name})).text;
 assert.deepEqual(parseSetlist(xml),[{name:'Set & 1',tracks:['A & B']}]);assert.match(xml,/<sksetlist version="2" active="0">/);assert.ok((await readFile(destination,'utf8')).includes(timeline));assert.equal(await readFile(source,'utf8'),original);
 const published=await readFile(destination,'utf8');await assert.rejects(createShowSetlistCopy(args),/EEXIST/);assert.equal(await readFile(destination,'utf8'),published);assert.ok(!(await (await import('node:fs/promises')).readdir(dir)).some(name=>name.startsWith('.sk-setlist-')));
 const empty=path.join(dir,'empty.skshow');await createShowSetlistCopy({...args,destination:empty,tracks:undefined});assert.deepEqual(parseSetlist((await readShowPart({file:empty,name:args.name})).text),[{name:'Set & 1',tracks:[]}]);
 for(const [suffix,changes,match] of [['stale',{sha256:'0'.repeat(64)},/changed/],['missing',{tracks:['Missing']},/exactly one timeline/],['duplicate',{tracks:['A & B','A & B']},/unique/],['invalid',{setName:'\u0000'},/valid set/]]){
  const dest=path.join(dir,`${suffix}.skshow`);await assert.rejects(createShowSetlistCopy({...args,destination:dest,...changes}),match);await assert.rejects(access(dest));
 }
});
test('reject an existing set list and duplicate part names',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-create-conflict-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'source.skshow'),destination=path.join(dir,'out.skshow');
 for(const [body,match] of [[part('other.SKLS','<sksetlist version="2"/>'),/already has/],[part('A','<a/>')+part('a','<a/>'),/Duplicate/],[part('content/Setlist.skls','<sksetlist version="2"/>'),/already exists/]]){
  await writeFile(source,`<skshow>${body}</skshow>`);const {sha256}=await inspectShow({file:source});await assert.rejects(createShowSetlistCopy({source,destination,sha256,name:'content/Setlist.skls',setName:'Set'}),match);await assert.rejects(access(destination));
 }
});
test('source changes before publication leave no destination or temporary files',async t=>{
 const fs=await import('node:fs');const {syncBuiltinESMExports}=await import('node:module');
 const {readdir}=await import('node:fs/promises');const dir=await mkdtemp(path.join(os.tmpdir(),'sk-create-race-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),destination=path.join(dir,'out.skshow');
 await writeFile(source,`<skshow>${part('patch.skf','<showkontrol/>')}</skshow>`);const {sha256}=await inspectShow({file:source});
 const originalOpen=fs.default.promises.open;let changed=false;
 fs.default.promises.open=async (...args)=>{const handle=await originalOpen(...args);if(String(args[0]).includes('.sk-setlist-')&&args[1]==='wx'){
  const close=handle.close.bind(handle);handle.close=async()=>{await close();if(!changed){changed=true;await writeFile(source,`<skshow>${part('patch.skf','<changed/>')}</skshow>`);}};
 }return handle;};syncBuiltinESMExports();
 try{await assert.rejects(createShowSetlistCopy({source,destination,sha256,name:'content/List.skls',setName:'Set'}),/changed/);}
 finally{fs.default.promises.open=originalOpen;syncBuiltinESMExports();}
 await assert.rejects(access(destination));assert.deepEqual(await readdir(dir),['source.skshow']);
});
test('reject unsafe names and non-show paths before creating output',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-create-path-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),destination=path.join(dir,'out.skshow');await writeFile(source,`<skshow>${part('patch.skf','<showkontrol/>')}</skshow>`);
 const {sha256}=await inspectShow({file:source});const args={source,destination,sha256,name:'content/List.skls',setName:'Set'};
 await assert.rejects(createShowSetlistCopy({...args,name:'content/../List.skls'}),/safe/);
 await assert.rejects(createShowSetlistCopy({...args,destination:path.join(dir,'out.xml')}),/\.skshow/);
 await assert.rejects(access(destination));
});
