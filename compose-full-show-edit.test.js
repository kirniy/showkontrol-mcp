import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeFullShowCopy as compose} from './compose-full-show.js';
import {inspectShowProgram} from './program.js';
import {inspectShow} from './xml-copy.js';
const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'full-show-edit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const show=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}${part('content/Program.skpr','<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""/></skprogram>')}</skshow>`;
 await writeFile(source,show);
 return {dir,show,args:{source,destination,sha256:hash('sha256',show),tracks:[{templateName:'Empty.sktl',trackName:'First',partName:'content/First.sktl',cues:[{layer:0,startMs:0,lengthMs:100,label:'Go'}]}],program:{operations:[{action:'remove',index:0},{action:'add',start:2,name:'C',notes:''},{action:'edit',index:1,name:'D'}]}}};
}
test('stages tracks and edits the existing Program using sequential indices',async t=>{
 const {args}=await fixture(t);const result=await compose(args);
 assert.equal(result.tracks.length,1);assert.equal(result.sha256,(await inspectShow({file:args.destination})).sha256);
 const program=await inspectShowProgram({file:args.destination});assert.deepEqual(program.items.map(item=>item.name),['B','D']);assert.equal(result.program.programSha256,program.programSha256);
});
test('rolls back staged tracks when a later Program edit fails',async t=>{
 const {args,dir,show}=await fixture(t);args.program.operations.push({action:'remove',index:99});
 await assert.rejects(compose(args),/index out of range/);await assert.rejects(readFile(args.destination),{code:'ENOENT'});
 assert.deepEqual(await readdir(dir),['in.skshow']);assert.equal(await readFile(args.source,'utf8'),show);
});
test('rejects mixed Program creation and editing inputs',async t=>{
 const {args,dir}=await fixture(t);
 for(const program of [{operations:[],items:[]},{operations:[],replaceExisting:true},{operations:[],extra:true},{operations:'bad'}]){
  await assert.rejects(compose({...args,program}),/Invalid Program composition/);await assert.rejects(readFile(args.destination),{code:'ENOENT'});
 }
 assert.deepEqual(await readdir(dir),['in.skshow']);
});
