import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {attachShowProgramCopy} from './program.js';

const digest=(algo,value)=>createHash(algo).update(value).digest('hex');
const part=(name,value,md5=digest('md5',value))=>`<part name="${name}" md5="${md5}">${Buffer.from(value).toString('base64')}</part>`;
const program=body=>`<skprogram version="1"><item start="0" name="A" notes="">${body}</item></skprogram>`;
const old=program('<graph><node id="n1"/><node id="n2"/></graph><sktimeline><cue id="cue1"/></sktimeline>');

test('Program replacement protects removed IDs and preserves unrelated parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'attach-ref-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),input=path.join(dir,'new.skpr'),destination=path.join(dir,'out.skshow');
 const media=part('media/data.bin',Buffer.from([0,255,1]));
 const writeShow=async reference=>{const show=`<skshow><!--keep-->${part('content/Program.skpr',old)}${part('patch.skf',reference)}${media}</skshow>`;await writeFile(source,show);return show;};
 const call=async(show,next,overrides={})=>{await writeFile(input,next);return attachShowProgramCopy({source,destination,sha256:digest('sha256',show),program:input,programSha256:digest('sha256',next),replaceExisting:true,...overrides});};
 const next=program('<graph><node id="n2"/></graph><sktimeline><cue id="cue1"/></sktimeline>');
 let show=await writeShow('<patch><setting key="target">n1</setting></patch>');
 await assert.rejects(call(show,next),/Removed Program ID/);await assert.rejects(readFile(destination),{code:'ENOENT'});
 show=await writeShow('<patch><setting key="target">cue1</setting></patch>');
 const noCue=program('<graph><node id="n1"/><node id="n2"/></graph>');
 await assert.rejects(call(show,noCue),/Removed Program ID/);await assert.rejects(readFile(destination),{code:'ENOENT'});
 show=await writeShow('<patch><setting key="target">n2</setting><setting key="cue">cue1</setting></patch>');
 await assert.rejects(call(show,next,{sha256:'0'.repeat(64)}),/Source changed/);
 await assert.rejects(call(show,next,{programSha256:'0'.repeat(64)}),/Program changed/);
 await call(show,next);const output=await readFile(destination,'utf8');assert.ok(output.includes(media));assert.ok(output.includes(part('patch.skf','<patch><setting key="target">n2</setting><setting key="cue">cue1</setting></patch>')));assert.ok(output.includes('<!--keep-->'));assert.equal(await readFile(source,'utf8'),show);
 assert.equal((await readdir(dir)).some(name=>name.endsWith('.tmp')),false);
});

test('Program replacement rejects ambiguous duplicate definitions and invalid part checksums',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'attach-duplicates-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),input=path.join(dir,'new.skpr'),destination=path.join(dir,'out.skshow');
 const next=program('<graph><node id="n1"/><node id="n1"/></graph>');await writeFile(input,next);
 let show=`<skshow>${part('content/Program.skpr',old)}${part('patch.skf','<patch/>')}</skshow>`;await writeFile(source,show);
 const call=()=>attachShowProgramCopy({source,destination,sha256:digest('sha256',show),program:input,programSha256:digest('sha256',next),replaceExisting:true});
 await assert.rejects(call(),/ambiguous duplicate/);
 show=`<skshow>${part('content/Program.skpr',old)}${part('patch.skf','<patch/>','0'.repeat(32))}</skshow>`;await writeFile(source,show);await assert.rejects(call(),/MD5/);await assert.rejects(readFile(destination),{code:'ENOENT'});
});

test('unchanged duplicate definitions remain valid but changes are ambiguous',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'attach-duplicate-stable-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),input=path.join(dir,'new.skpr'),destination=path.join(dir,'out.skshow');
 const duplicate=program('<graph><node id="n1"/></graph><sktimeline><cue id="c1"><graph><node id="n1"/></graph></cue></sktimeline>');
 const show=`<skshow>${part('content/Program.skpr',duplicate)}${part('patch.skf','<patch target="n1"/>')}</skshow>`;await writeFile(source,show);
 const call=async next=>{await writeFile(input,next);return attachShowProgramCopy({source,destination,sha256:digest('sha256',show),program:input,programSha256:digest('sha256',next),replaceExisting:true});};
 await assert.rejects(call(duplicate.replace('<node id="n1"/>','<node id="n1" type="changed"/>')),/ambiguous duplicate/);
 await assert.rejects(readFile(destination),{code:'ENOENT'});
 await call(duplicate.replace('name="A"','name="B"'));assert.ok((await readFile(destination,'utf8')).includes(part('patch.skf','<patch target="n1"/>')));
});

test('Program attachment checks removed IDs in setlist and control parts',async t=>{
 for(const ext of ['skls','skcp']){
  const dir=await mkdtemp(path.join(os.tmpdir(),'attach-extra-ref-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),input=path.join(dir,'in.skpr'),destination=path.join(dir,'out.skshow');
  const next=program('<graph><node id="n2"/></graph>'),make=ref=>`<skshow>${part('content/Program.skpr',old)}${part(`extra.${ext}`,`<root ref="${ref}"/>`)}</skshow>`;let show=make('n1');await Promise.all([writeFile(source,show),writeFile(input,next)]);
  const call=()=>attachShowProgramCopy({source,destination,sha256:digest('sha256',show),program:input,programSha256:digest('sha256',next),replaceExisting:true});
  await assert.rejects(call(),/Removed Program ID/);await assert.rejects(readFile(destination),{code:'ENOENT'});show=make('n2');await writeFile(source,show);await call();assert.ok((await readFile(destination,'utf8')).includes(part(`extra.${ext}`,'<root ref="n2"/>')));
 }
});
