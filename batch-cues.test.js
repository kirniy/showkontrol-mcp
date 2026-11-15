import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import os from 'node:os';
import {inspectShowTimeline} from './timeline.js';import {addShowTimelineCuesCopy} from './batch-cues.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('batch adds cues across timelines in one exclusive copy',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-batch-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const timeline='<sktimeline version="1"><layers><layer name="One"/></layers></sktimeline>';
 const input=`<skshow>${part('a.sktl',timeline)}${part('b.sktl',timeline)}</skshow>`;await writeFile(source,input);
 const {sha256}=await inspectShowTimeline({file:source,name:'a.sktl'});
 const cues=[{name:'a.sktl',layer:0,startMs:100,lengthMs:200,label:'First'},{name:'b.sktl',layer:0,startMs:300,lengthMs:400,label:'Second'}];
 const result=await addShowTimelineCuesCopy({source,destination,sha256,cues});
 for(let i=0;i<cues.length;i++){const inspected=await inspectShowTimeline({file:destination,name:cues[i].name});assert.equal(inspected.sha256,result.sha256);assert.equal(inspected.cueElements[0].attributes.id,result.cues[i].id);assert.equal(inspected.cueElements[0].attributes.label,cues[i].label);}
 assert.equal(await readFile(source,'utf8'),input);assert.deepEqual((await readdir(dir)).sort(),['in.skshow','out.skshow']);
 await assert.rejects(addShowTimelineCuesCopy({source,destination,sha256,cues}),{code:'EEXIST'});
});
test('batch errors preserve source and clean intermediate copies',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-batch-fail-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const input=`<skshow>${part('a.sktl','<sktimeline version="1"><layers><layer/></layers></sktimeline>')}</skshow>`;await writeFile(source,input);
 const {sha256}=await inspectShowTimeline({file:source,name:'a.sktl'});const cue={name:'a.sktl',layer:0,startMs:0,lengthMs:100,label:'First'};
 await assert.rejects(addShowTimelineCuesCopy({source,destination,sha256,cues:[cue,{...cue,layer:9}]}),/outside/);
 await assert.rejects(addShowTimelineCuesCopy({source,destination,sha256:'0'.repeat(64),cues:[cue]}),/changed/);
 await assert.rejects(addShowTimelineCuesCopy({source,destination,sha256,cues:[]}),/between 1 and 100/);
 assert.equal(await readFile(source,'utf8'),input);assert.deepEqual(await readdir(dir),['in.skshow']);
});
test('batch keeps at most two intermediate show files during processing',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-batch-space-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const timeline='<sktimeline version="1"><layers><layer/></layers></sktimeline>';
 await writeFile(source,`<skshow>${part('a.sktl',timeline)}${part('filler.bin','x'.repeat(1024*1024))}</skshow>`);
 const {sha256}=await inspectShowTimeline({file:source,name:'a.sktl'});
 const cues=Array.from({length:8},(_,i)=>({name:'a.sktl',layer:0,startMs:i*100,lengthMs:50,label:`Cue ${i}`}));
 let done=false,maxFiles=0;const task=addShowTimelineCuesCopy({source,destination,sha256,cues}).finally(()=>{done=true});
 while(!done){
  for(const name of await readdir(dir))if(name.startsWith('.showkontrol-cues-')){
   try{maxFiles=Math.max(maxFiles,(await readdir(path.join(dir,name))).filter(n=>n.endsWith('.skshow')).length)}catch(e){if(e.code!=='ENOENT')throw e;}
  }
 }
 const result=await task;assert.equal(result.cues.length,8);assert.ok(maxFiles>0);assert.ok(maxFiles<=2,`observed ${maxFiles} intermediate files`);
 assert.deepEqual((await readdir(dir)).sort(),['in.skshow','out.skshow']);
});
