import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {inspectXml,editXmlCopy,inspectShow,readShowPart,editShowPart,prepareShowProgram} from './xml-copy.js';

const hash=(algorithm,data)=>createHash(algorithm).update(data).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;

test('standalone XML preserves BOM and hashes the source bytes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'xml-bom-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.xml'),destination=path.join(dir,'out.xml');
 const xml='\ufeff<?xml version="1.0"?><root>old</root>',bytes=Buffer.from(xml);
 await writeFile(source,bytes);const inspected=await inspectXml({file:source});
 assert.equal(inspected.xml,xml);assert.equal(inspected.sha256,hash('sha256',bytes));
 await assert.rejects(editXmlCopy({source,destination,sha256:hash('sha256',xml.slice(1)),edits:[{find:'old',replace:'new'}]}),/changed/);
 const result=await editXmlCopy({source,destination,sha256:inspected.sha256,edits:[{find:'old',replace:'new'}]});
 const expected=Buffer.from(xml.replace('old','new'));assert.deepEqual(await readFile(destination),expected);assert.equal(result.sha256,hash('sha256',expected));assert.deepEqual(await readFile(source),bytes);
});

test('show wrapper and nested Program BOMs survive part edits',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'show-bom-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),name='content/Program.skpr';
 const program='\ufeff<?xml version="1.0"?><program><item name="old"/></program>',other=part('patch.skf','<showkontrol/>');
 const wrapper=`\ufeff<?xml version="1.0"?><skshow>${part(name,program)}${other}</skshow>`,bytes=Buffer.from(wrapper);
 await writeFile(source,bytes);const inspected=await inspectShow({file:source});assert.equal(inspected.sha256,hash('sha256',bytes));
 assert.equal((await readShowPart({file:source,name})).text,program);
 const prepared=await prepareShowProgram({file:source});assert.equal(prepared.sha256,hash('sha256',bytes));assert.deepEqual(prepared.bytes,Buffer.from(program));
 await assert.rejects(editShowPart({source,destination,sha256:hash('sha256',wrapper.slice(1)),name,edits:[{find:'old',replace:'new'}]}),/changed/);
 await editShowPart({source,destination,sha256:inspected.sha256,name,edits:[{find:'old',replace:'new'}]});
 const expected=wrapper.replace(part(name,program),part(name,program.replace('old','new')));assert.deepEqual(await readFile(destination),Buffer.from(expected));
 assert.equal((await readShowPart({file:destination,name})).text,program.replace('old','new'));assert.deepEqual(await readFile(source),bytes);
});
