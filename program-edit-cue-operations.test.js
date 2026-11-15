import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';
const hash=(algorithm,data)=>createHash(algorithm).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
const cue='<cue id="c1" layer="0" startMs="0" lenMs="100" label="Old"><graph><node id="n2" type="trigger"/></graph></cue>';
async function fixture(t,{extra='',remaining=''}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-cue-edit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const program=`<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers>${cue}</sktimeline>${remaining}</item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${extra}</skshow>`;await writeFile(source,show);
 return {dir,source,destination,sha256:hash('sha256',show),show};
}
const run=(args,operations,sha256=args.sha256)=>compose({source:args.source,destination:args.destination,sha256,operations});
const remove={action:'delete_timeline_cue',index:0,cueId:'c1',deleteGraph:true};
const add={action:'add_timeline_cue',index:0,layer:0,startMs:200,lengthMs:50,label:'New'};
test('adds and deletes cues using current item indexes',async t=>{
 const args=await fixture(t);const result=await run(args,[{action:'remove',index:0},remove,add]);
 const program=(await readShowPart({file:args.destination,name:'content/Program.skpr'})).text;
 assert.ok(!program.includes('id="c1"'));assert.ok(program.includes(`id="${result.createdCues[0].id}"`));assert.ok(program.includes('label="New"'));
 assert.deepEqual(result.createdCues.map(({operationIndex,index})=>({operationIndex,index})),[{operationIndex:2,index:0}]);
 assert.equal(await readFile(args.source,'utf8'),args.show);assert.deepEqual((await readdir(args.dir)).sort(),['in.skshow','out.skshow']);
});
test('rejects references, ambiguous IDs and unreadable show parts with rollback',async t=>{
 for(const config of [
  {remaining:'<graph><node id="n3" ref="c&#49;"/></graph>'},
  {remaining:'<graph><node id="n3" ref="n2"/></graph>'},
  {remaining:'<graph><node id="n2"/></graph>'},
  {extra:part('content/other.skcp','<root ref="n2"/>')},
  {extra:part('content/other.sktl','<sktimeline')}
 ]){
  const args=await fixture(t,config);
  await assert.rejects(run(args,[{action:'remove',index:0},remove]),/references|scanned/);
  await assert.rejects(readFile(args.destination),{code:'ENOENT'});assert.deepEqual(await readdir(args.dir),['in.skshow']);assert.equal(await readFile(args.source,'utf8'),args.show);
 }
});
test('requires graph guard, checksum, and valid operations without leaving output',async t=>{
 const args=await fixture(t);
 for(const [operations,sha256] of [
  [[{action:'remove',index:0},{...remove,deleteGraph:false}],args.sha256],
  [[{action:'remove',index:0},add,{...remove,cueId:'missing'}],args.sha256],
  [[{action:'remove',index:0},remove],'0'.repeat(64)],
  [[{...remove,deleteGraph:'true'}],args.sha256]
 ]){
  await assert.rejects(run(args,operations,sha256));await assert.rejects(readFile(args.destination),{code:'ENOENT'});assert.deepEqual(await readdir(args.dir),['in.skshow']);
 }
});
test('rejects a generated cue ID already present elsewhere',async t=>{
 const oldNow=Date.now,oldRandomInt=crypto.randomInt;
 Date.now=()=>1700000000000;crypto.randomInt=()=>123;syncBuiltinESMExports();
 try{
  for(const config of [
   {remaining:'<graph><node id="n3" ref="c1700000000000_123"/></graph>'},
   {extra:part('content/other.skcp','<root ref="c1700000000000_123"/>')},
   {extra:part('content/other.skcp','<root')}
  ]){
   const args=await fixture(t,config);
   await assert.rejects(run(args,[{action:'remove',index:0},add]),/references|scanned/);
   await assert.rejects(readFile(args.destination),{code:'ENOENT'});
   assert.deepEqual(await readdir(args.dir),['in.skshow']);
  }
 }finally{Date.now=oldNow;crypto.randomInt=oldRandomInt;syncBuiltinESMExports();}
});
test('copies a donor graph to a newly created cue after an item index shift',async t=>{
 const args=await fixture(t,{extra:part('patch.skf','<showkontrol version="2"><appSettings/><graph><node id="n900" type="router"/></graph></showkontrol>'),remaining:'<graph><node id="n800"/></graph>'});
 const donor=path.join(args.dir,'donor.sktl');const xml='<sktimeline version="1"><layers/><cue id="donor"><graph><node id="n1" type="groupin"/><node id="n2" type="action"/><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/></graph></cue></sktimeline>';await writeFile(donor,xml);
 const op={action:'copy_timeline_cue_graph',index:0,cueFromOperation:0,donor,donorSha256:hash('sha256',xml),donorCueId:'donor'};
 const result=await run(args,[{...add,index:1},{action:'remove',index:0},op]);
 assert.deepEqual(result.copiedCueGraphs[0].idMap,{n1:'n901',n2:'n902'});
 const program=(await readShowPart({file:args.destination,name:'content/Program.skpr'})).text;
 assert.match(program,/id="n900"|id="n800"/);assert.match(program,/fromNode="n901"/);assert.match(program,/toNode="n902"/);
});
test('rejects stale donors, unsupported references, wrong item and later failure atomically',async t=>{
 for(const variant of ['stale','reference','router','wrong','later']){
  const args=await fixture(t);const donor=path.join(args.dir,'donor.sktl');
  const setting=variant==='reference'?'<settings><setting key="other">n77</setting></settings>':variant==='router'?'<settings><setting key="route.router_target">n77</setting></settings>':'';
  const xml=`<sktimeline version="1"><layers/><cue id="donor"><graph><node id="n1" type="action">${setting}</node></graph></cue></sktimeline>`;await writeFile(donor,xml);
  const op={action:'copy_timeline_cue_graph',index:variant==='wrong'?0:1,cueFromOperation:0,donor,donorSha256:variant==='stale'?'0'.repeat(64):hash('sha256',xml),donorCueId:'donor'};
  const operations=[{...add,index:1},op,...(variant==='later'?[{action:'edit',index:99,name:'x'}]:[])];
  await assert.rejects(run(args,operations));await assert.rejects(readFile(args.destination),{code:'ENOENT'});assert.equal(await readFile(args.source,'utf8'),args.show);
 }
});
test('copies a graph from an exact show part and rejects invalid donor archives atomically',async t=>{
 const xml='<sktimeline version="1"><layers/><cue id="donor"><graph><node id="n1" type="groupin"/><node id="n2" type="action"/><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/></graph></cue></sktimeline>';
 for(const variant of ['valid','missing','duplicate','checksum','stale','later','router']){
  const args=await fixture(t,{extra:part('patch.skf','<showkontrol version="2"><appSettings/><graph><node id="n900" type="router"/></graph></showkontrol>')});
  const donor=path.join(args.dir,'donor.skshow');
  const timeline=variant==='router'?xml.replace('<node id="n2" type="action"/>','<node id="n2" type="action"><settings><setting key="route.router_target">n77</setting></settings></node>'):xml;
  let show=`<skshow>${part('content/Program.skpr','<skprogram version="1"/>')}${part('content/Timeline.sktl',timeline)}${part('content/Other.skcp','<root/>')}${variant==='duplicate'?part('CONTENT/timeline.sktl',timeline):''}</skshow>`;
  if(variant==='checksum')show=show.replace(hash('md5','<root/>'),'0'.repeat(32));
  await writeFile(donor,show);
  const op={action:'copy_timeline_cue_graph',index:1,cueFromOperation:0,donor,donorName:variant==='missing'?'content/missing.sktl':'content/Timeline.sktl',donorSha256:variant==='stale'?'0'.repeat(64):hash('sha256',show),donorCueId:'donor'};
  const operations=[{...add,index:1},op,...(variant==='later'?[{action:'edit',index:99,name:'x'}]:[])];
  if(variant==='valid'){
   const result=await run(args,operations);assert.deepEqual(result.copiedCueGraphs[0].idMap,{n1:'n901',n2:'n902'});
   const program=(await readShowPart({file:args.destination,name:'content/Program.skpr'})).text;
   assert.match(program,/fromNode="n901"/);assert.match(program,/toNode="n902"/);
  }else{
   await assert.rejects(run(args,operations));await assert.rejects(readFile(args.destination),{code:'ENOENT'});
  }
  assert.equal(await readFile(args.source,'utf8'),args.show);assert.equal(await readFile(donor,'utf8'),show);
 }
});
test('validates copied router targets against the target show and rolls back failures',async t=>{
 const router=(id,name)=>`<node id="${id}" type="router"><settings><setting key="router.name">${name}</setting></settings></node>`;
 const donorXml='<sktimeline version="1"><layers/><cue id="donor"><graph><node id="n1" type="action"><settings><setting key="route.router_target">A</setting></settings></node></graph></cue></sktimeline>';
 for(const variant of ['valid','missing','ambiguous','later']){
  const routers=variant==='missing'?'':router('n20','A')+(variant==='ambiguous'?router('n21','A'):'');
  const args=await fixture(t,{extra:part('patch.skf',`<showkontrol version="2"><appSettings/><graph>${routers}</graph></showkontrol>`)});
  const donor=path.join(args.dir,'donor.sktl');await writeFile(donor,donorXml);
  const op={action:'copy_timeline_cue_graph',index:1,cueFromOperation:0,donor,donorSha256:hash('sha256',donorXml),donorCueId:'donor'};
  const operations=[{...add,index:1},op,...(variant==='later'?[{action:'edit',index:99,name:'x'}]:[])];
  if(variant==='valid'){
   const result=await run(args,operations);assert.equal(result.copiedCueGraphs[0].idMap.n1,'n21');
   const program=(await readShowPart({file:args.destination,name:'content/Program.skpr'})).text;
   assert.match(program,/<setting key="route.router_target">A<\/setting>/);
  }else{
   await assert.rejects(run(args,operations));await assert.rejects(readFile(args.destination),{code:'ENOENT'});
  }
  assert.equal(await readFile(args.source,'utf8'),args.show);assert.equal(await readFile(donor,'utf8'),donorXml);
 }
});
