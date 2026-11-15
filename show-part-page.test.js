import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readShowPartPage} from './show-part-page.js';

test('show part pages preserve Unicode and reject changed sources',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'show-page-'));
 try {
  const file=path.join(dir,'show.skshow'), content='<x>A😀B</x>', bytes=Buffer.from(content);
  const show=`<skshow><part name="content/a.sktl" md5="${createHash('md5').update(bytes).digest('hex')}">${bytes.toString('base64')}</part></skshow>`;
  await writeFile(file,show);
  let offset=0, sha256, combined='';
  do { const page=await readShowPartPage({file,name:'content/a.sktl',offset,limit:4,sha256}); sha256=page.sha256; combined+=page.text; offset=page.nextOffset; } while(offset!==null);
  assert.equal(combined,content);
  await assert.rejects(readShowPartPage({file,name:'content/a.sktl',offset:5,limit:4}),/splits a Unicode character/);
  await writeFile(file,show.replace('<skshow>','<skshow version="1">'));
  await assert.rejects(readShowPartPage({file,name:'content/a.sktl',sha256}),/Source changed/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
