import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {extractShowProgramCopy} from './program.js';
const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
async function fixture(t,extra=''){
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-edit-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const content='<graph><node id="n1"/></graph><sktimeline version="1"><layers/><cue id="c1"/></sktimeline>';
 const program=`<skprogram version="1"><item start="0" name="A" notes="">${content}</item><item start="1" name="B" notes=""/></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${extra}</skshow>`;await writeFile(f('in.skshow'),show);
 return {dir,f,show,content,args:{source:f('in.skshow'),destination:f('out.skshow'),sha256:hash('sha256',show),operations:[]}};
}
test('edits sequential current indices and preserves existing content',async t=>{
 const {f,args,content}=await fixture(t);
 const result=await compose({...args,operations:[{action:'remove',index:1},{action:'add',start:2,name:'C',notes:''},{action:'edit',index:1,name:'D'},{action:'edit',index:0,notes:'kept'}]});
 assert.deepEqual(result.items.map(i=>i.name),['A','D']);assert.equal(result.items[0].notes,'kept');
 await extractShowProgramCopy({source:args.destination,destination:f('out.skpr'),sha256:result.sha256});assert.ok((await readFile(f('out.skpr'),'utf8')).includes(content));
});
test('content removal is explicit and cross-part references are protected',async t=>{
 const {args,dir}=await fixture(t,part('patch.skf','<patch target="n1"/>'));
 await assert.rejects(compose({...args,operations:[{action:'remove',index:0}]}),/allowContentRemoval/);
 await assert.rejects(compose({...args,operations:[{action:'remove',index:0,allowContentRemoval:true}]}),/Removed Program ID/);
 await assert.rejects(readFile(args.destination),{code:'ENOENT'});assert.deepEqual(await readdir(dir),['in.skshow']);
});
test('later failure, stale source and existing destination do not publish',async t=>{
 const {args,dir,show}=await fixture(t);
 await assert.rejects(compose({...args,operations:[{action:'edit',index:0,name:'changed'},{action:'remove',index:99}]}),/index out of range/);
 await assert.rejects(compose({...args,sha256:'0'.repeat(64)}),/Source changed/);
 await assert.rejects(readFile(args.destination),{code:'ENOENT'});assert.deepEqual(await readdir(dir),['in.skshow']);assert.equal(await readFile(args.source,'utf8'),show);
 await writeFile(args.destination,'keep');await assert.rejects(compose(args),{code:'EEXIST'});assert.equal(await readFile(args.destination,'utf8'),'keep');
});
test('rejects references and ambiguous nested definitions in remaining Program',async t=>{
 const {args,dir}=await fixture(t);
 const make=body=>`<skshow>${part('content/Program.skpr',`<skprogram version="1"><item start="0" name="A" notes=""><graph><extension><node id="n.1"/></extension></graph></item><item start="1" name="B" notes="">${body}</item></skprogram>`)}</skshow>`;
 for(const body of ['<graph><node id="n2"><settings><setting key="target">n.1</setting></settings></node></graph>','<graph><extension><node id="n.1"/></extension></graph>']){
  const show=make(body);await writeFile(args.source,show);
  await assert.rejects(compose({...args,sha256:hash('sha256',show),operations:[{action:'remove',index:0,allowContentRemoval:true}]}),/referenced in remaining Program|ambiguous/);
  await assert.rejects(readFile(args.destination),{code:'ENOENT'});assert.deepEqual(await readdir(dir),['in.skshow']);
 }
});
test('reports the published path for pre-publication validation',async t=>{
 const {args}=await fixture(t);const result=await compose(args);
 assert.equal(result.validation.file,args.destination);assert.match(result.validation.note,/before publication/);
});
