import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectProgram,createProgramCopy} from './program.js';

test('standalone Program creation, ordered edits and guarded content removal',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-'));try{
  const file=n=>path.join(dir,`${n}.skpr`);let r=await createProgramCopy({destination:file('a')});
  r=await createProgramCopy({source:file('a'),destination:file('b'),sha256:r.sha256,operation:{action:'add',start:86399999,name:'A & "B"',notes:'line\nnext'}});
  assert.deepEqual((await inspectProgram({file:file('b')})).items.map(i=>[i.start,i.name,i.notes]),[[86399999,'A & "B"','line\nnext']]);
  await assert.rejects(createProgramCopy({source:file('a'),destination:file('b'),sha256:(await inspectProgram({file:file('a')})).sha256,operation:{action:'add',start:0,name:'',notes:''}}),/EEXIST/);
  const rich='<skprogram version="1"><item start="1.25" name="a" notes="b"><graph><node id="x"/></graph><sktimeline /></item><item start="0.0" name="z" notes=""/></skprogram>';
  await writeFile(file('rich'),rich);const before=await inspectProgram({file:file('rich')});
  r=await createProgramCopy({source:file('rich'),destination:file('edit'),sha256:before.sha256,operation:{action:'edit',index:0,name:'new & name'}});
  assert.match(await readFile(file('edit'),'utf8'),/<graph><node id="x"\/><\/graph><sktimeline \/>/);
  assert.deepEqual(r.items.map(i=>i.start),[1.25,0]);assert.match(await readFile(file('edit'),'utf8'),/start="1.25"/);
  await assert.rejects(createProgramCopy({source:file('edit'),destination:file('remove'),sha256:r.sha256,operation:{action:'remove',index:0}}),/allowContentRemoval/);
  const removed=await createProgramCopy({source:file('edit'),destination:file('remove'),sha256:r.sha256,operation:{action:'remove',index:0,allowContentRemoval:true}});assert.equal(removed.items.length,1);
  await assert.rejects(createProgramCopy({source:file('edit'),destination:file('bad'),sha256:'0'.repeat(64),operation:{action:'remove',index:1}}),/changed/);
  await assert.rejects(createProgramCopy({source:file('a'),destination:file('bad'),sha256:(await inspectProgram({file:file('a')})).sha256,operation:{action:'add',start:86400000,name:'',notes:''}}),/start/);
  await writeFile(file('unknown'),'<skprogram version="1"><item start="0" name="x" notes=""><unknown/></item></skprogram>');await assert.rejects(inspectProgram({file:file('unknown')}),/Unsupported/);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('rejects an edit that would exceed the Program size limit',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-limit-'));try{
  const source=path.join(dir,'source.skpr'),destination=path.join(dir,'copy.skpr');
  const prefix='<skprogram version="1"><item start="0" name="x" notes=""><graph><data>';const suffix='</data></graph></item></skprogram>';
  await writeFile(source,prefix+'a'.repeat(10*1024*1024-Buffer.byteLength(prefix+suffix))+suffix);
  const inspected=await inspectProgram({file:source});
  await assert.rejects(createProgramCopy({source,destination,sha256:inspected.sha256,operation:{action:'edit',index:0,name:'longer'}}),/exceeds 10 MiB/);
  await assert.rejects(readFile(destination),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
