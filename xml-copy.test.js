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
