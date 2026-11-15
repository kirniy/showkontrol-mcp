import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {inspectShow,readShowPart,editShowPart} from './xml-copy.js';

test('show parts use actual name and md5 attributes when lookalikes exist',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-xml-parts-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const content='<root>old</root>',checksum=createHash('md5').update(content).digest('hex'),decoy='0'.repeat(32);
 const original=`<skshow><part data-name="wrong.xml" name="right.xml" data-md5="${decoy}" md5="${checksum}">${Buffer.from(content).toString('base64')}</part></skshow>`;
 await writeFile(source,original);const show=await inspectShow({file:source});
 assert.deepEqual(show.parts.map(p=>[p.name,p.valid]),[['right.xml',true]]);
 await editShowPart({source,destination,sha256:show.sha256,name:'right.xml',edits:[{find:'old',replace:'new'}]});
 assert.equal((await readShowPart({file:destination,name:'right.xml'})).text,'<root>new</root>');
 const output=await readFile(destination,'utf8');assert.ok(output.includes(`data-name="wrong.xml"`));assert.ok(output.includes(`data-md5="${decoy}"`));
 assert.equal(await readFile(source,'utf8'),original);
});

test('show part edits reject checksum text inside another attribute',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-xml-checksum-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const content='<root>old</root>',checksum=createHash('md5').update(content).digest('hex');
 await writeFile(source,`<skshow><part name="right.xml" note=" md5='${checksum}'" md5="${checksum}">${Buffer.from(content).toString('base64')}</part></skshow>`);
 const show=await inspectShow({file:source});
 await assert.rejects(editShowPart({source,destination,sha256:show.sha256,name:'right.xml',edits:[{find:'old',replace:'new'}]}),/checksum serialization/);
 await assert.rejects(readFile(destination),{code:'ENOENT'});
});

test('offline XML size limit defaults above 5 MiB and supports a configured cap',async t=>{
 const {inspectXml,editXmlCopy}=await import('./xml-copy.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-size-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const previous=process.env.SHOWKONTROL_OFFLINE_MAX_BYTES;t.after(()=>{if(previous===undefined)delete process.env.SHOWKONTROL_OFFLINE_MAX_BYTES;else process.env.SHOWKONTROL_OFFLINE_MAX_BYTES=previous});
 delete process.env.SHOWKONTROL_OFFLINE_MAX_BYTES;
 const large=path.join(dir,'large.xml');await writeFile(large,`<root>${' '.repeat(5*1024*1024)}</root>`);
 assert.equal((await inspectXml({file:large})).xml.length,5*1024*1024+13);
 process.env.SHOWKONTROL_OFFLINE_MAX_BYTES='64';await assert.rejects(inspectXml({file:large}),/size limit of 64 bytes/);
 const small=path.join(dir,'small.xml'),out=path.join(dir,'out.xml');await writeFile(small,'<root>x</root>');const info=await inspectXml({file:small});
 await assert.rejects(editXmlCopy({source:small,destination:out,sha256:info.sha256,edits:[{find:'x',replace:'x'.repeat(100)}]}),/XML output exceeds offline size limit/);
 await assert.rejects(readFile(out),{code:'ENOENT'});
 process.env.SHOWKONTROL_OFFLINE_MAX_BYTES='invalid';await assert.rejects(inspectXml({file:small}),/Invalid SHOWKONTROL_OFFLINE_MAX_BYTES/);
});

test('offline XML reads reject non-regular files and enforce the exact byte limit',async t=>{
 const {inspectXml}=await import('./xml-copy.js');
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-bounded-read-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const previous=process.env.SHOWKONTROL_OFFLINE_MAX_BYTES;t.after(()=>{if(previous===undefined)delete process.env.SHOWKONTROL_OFFLINE_MAX_BYTES;else process.env.SHOWKONTROL_OFFLINE_MAX_BYTES=previous});
 process.env.SHOWKONTROL_OFFLINE_MAX_BYTES='14';
 const file=path.join(dir,'exact.xml');await writeFile(file,'<root>x</root>');assert.equal((await inspectXml({file})).xml,'<root>x</root>');
 await writeFile(file,'<root>xx</root>');await assert.rejects(inspectXml({file}),/size limit/);
 await assert.rejects(inspectXml({file:'/dev/zero'}),/regular file/);
 const fifo=path.join(dir,'pipe');await promisify(execFile)('mkfifo',[fifo]);await assert.rejects(inspectXml({file:fifo}),/regular file/);
});
