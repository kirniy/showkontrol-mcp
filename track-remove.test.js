import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {inspectShow} from './xml-copy.js';
import {removeShowTrackCopy} from './track-remove.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
const target=part('content/a.sktl','<sktimeline version="1" name="Alpha"><cue id="c12"><graph><node id="n44"/></graph></cue></sktimeline>');
test('removes selected part while preserving the wrapper and unrelated parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'track-remove-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const other=part('patch.skf','<patch/>'),input=`<skshow>\n${target}\n${other}\n</skshow>`;await writeFile(source,input);const sha256=(await inspectShow({file:source})).sha256;
 await assert.rejects(removeShowTrackCopy({source,destination,sha256,name:'content/a.sktl',allowContentRemoval:false}),/contains content/);
 const result=await removeShowTrackCopy({source,destination,sha256,name:'content/a.sktl',allowContentRemoval:true});assert.equal(result.trackName,'Alpha');assert.equal(await readFile(destination,'utf8'),input.replace(target,''));assert.equal(await readFile(source,'utf8'),input);
 await assert.rejects(removeShowTrackCopy({source,destination,sha256,name:'content/a.sktl',allowContentRemoval:true}),/EEXIST/);assert.deepEqual((await readdir(dir)).sort(),['in.skshow','out.skshow']);
});
test('rejects surviving references, malformed parts and stale hashes without output',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'track-remove-fail-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 for(const extra of [part('list.skls','<sksetlist version="2"><set><entry track="Alpha"/></set></sksetlist>'),part('content/Program.skpr','<skprogram version="1"><item start="0" name="x" notes=""><graph><node id="n44"/></graph></item></skprogram>'),part('patch.skf','<patch ref="c12"/>'),part('cross.skcp','<cross ref="Alpha"/>'),part('cross.skcp','<cross ref="n44"/>'),part('broken.skls','<sksetlist version="3"/>'),part('bad.sktl','<sktimeline'),target]){
  await writeFile(source,`<skshow>${target}${extra}</skshow>`);const sha256=(await inspectShow({file:source})).sha256;
  await assert.rejects(removeShowTrackCopy({source,destination,sha256,name:'content/a.sktl',allowContentRemoval:true}));assert.deepEqual(await readdir(dir),['in.skshow']);
 }
 await writeFile(source,`<skshow>${target}${part('patch.skf','<patch/>')}</skshow>`);await assert.rejects(removeShowTrackCopy({source,destination,sha256:'0'.repeat(64),name:'content/a.sktl',allowContentRemoval:true}),/changed/);assert.deepEqual(await readdir(dir),['in.skshow']);
});
test('permits an empty timeline and rejects invalid checksums and unreadable supported parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'track-remove-empty-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const empty=part('empty.sktl','<sktimeline version="1" name="Empty"/>'),patch=part('patch.skf','<patch/>');
 for(const invalid of [patch.replace(/md5="[^"]+"/,'md5="00000000000000000000000000000000"'),part('bad.skpr',Buffer.from([255])),part('bad.skcp',Buffer.from([255])),part('bad.skcp','<cross')]){
  await writeFile(source,`<skshow>${empty}${invalid}</skshow>`);const sha256=(await inspectShow({file:source})).sha256;await assert.rejects(removeShowTrackCopy({source,destination,sha256,name:'empty.sktl',allowContentRemoval:false}));assert.deepEqual(await readdir(dir),['in.skshow']);
 }
 await writeFile(source,`<skshow>${empty}${patch}</skshow>`);const sha256=(await inspectShow({file:source})).sha256;await removeShowTrackCopy({source,destination,sha256,name:'empty.sktl',allowContentRemoval:false});assert.equal((await inspectShow({file:destination})).parts.length,1);
});
