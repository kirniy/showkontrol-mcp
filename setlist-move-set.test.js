import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {inspectShow,readShowPart} from './xml-copy.js';
import {editShowSetlistCopy,inspectShowSetlist} from './setlist.js';
import {composeMultiTrackShowCopy} from './compose-multi-show.js';
import {composeFullShowCopy} from './compose-full-show.js';
import {composeSessionMediaCopy} from './session-media-copy.js';

const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const temp=async(t,prefix)=>{const dir=await mkdtemp(path.join(os.tmpdir(),prefix));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
// The fixture root also carries a decoy " active='0' " inside another attribute value.
const activeOf=text=>Number(/ active = '(\d+)' extra=/.exec(text)[1]);

// Pretty-printed, CRLF, BOM, declaration, decoy attribute text, unknown attributes, comments inside and between sets.
const sets=[
 '<set name="Doors" colour=\'red\'>\r\n    <!--opening-->\r\n    <entry track="Intro"/>\r\n    <entry track="Walk &amp; Talk" fade="1"/>\r\n  </set>',
 '<set name="Main"/>',
 '<set name="Encore" x-id="7"><entry track="Finale"/></set>',
 '<set name="After &lt;hours&gt;" ></set >',
];
const between=['\r\n  ','\r\n  <!--between-->\r\n  ','\r\n  ','\r\n  ','\r\n'];
const head='﻿<?xml version="1.0" encoding="UTF-8"?>\r\n<sksetlist version="2" note=" active=\'0\' " active = \'1\' extra="keep">';
const listing=(order,active)=>head.replace("active = '1'",`active = '${active}'`)+order.map((i,slot)=>between[slot]+sets[i]).join('')+between[4]+'</sksetlist>\r\n';
const names=['Doors','Main','Encore','After <hours>'];

async function show(t,xml,prefix='sk-move-set-'){
 const dir=await temp(t,prefix),source=path.join(dir,'source.skshow'),name='content/Setlist.skls';
 const others=part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')+part('content/Intro.sktl','<sktimeline version="1" name="Intro"/>');
 const original=`<skshow>\n${part(name,xml)}\n${others}\n</skshow>\n`;await writeFile(source,original);
 return {dir,source,name,original,others,sha256:(await inspectShow({file:source})).sha256};
}

test('move_set reorders whole set elements byte for byte and keeps the same set active',async t=>{
 const xml=listing([0,1,2,3],1),{dir,source,name,original,others,sha256}=await show(t,xml);
 const destination=path.join(dir,'first-to-last.skshow');
 const result=await editShowSetlistCopy({source,destination,sha256,name,operation:'move_set',setName:'Doors',toIndex:3});
 // Main was active at 1; after Doors leaves the front it is at 0.
 assert.equal((await readShowPart({file:destination,name})).text,listing([1,2,3,0],0));
 assert.deepEqual(result.move,{setName:'Doors',fromIndex:0,toIndex:3,active:{before:1,after:0}});
 const output=await readFile(destination,'utf8');assert.ok(output.includes(others));assert.ok((await inspectShow({file:destination})).parts.every(p=>p.valid));
 assert.equal(output.replace(/<part name="content\/Setlist\.skls"[^>]*>[^<]*<\/part>/,''),original.replace(/<part name="content\/Setlist\.skls"[^>]*>[^<]*<\/part>/,''));
 const inspected=await inspectShowSetlist({file:destination,name});
 assert.deepEqual(inspected.sets.map(s=>s.name),['Main','Encore','After <hours>','Doors']);
 assert.deepEqual(inspected.sets[3].tracks,['Intro','Walk & Talk']);
 assert.equal(await readFile(source,'utf8'),original);
});

test('active follows its set for every source, destination and active position',async t=>{
 const count=4;
 for(let active=0;active<count;active++){
  const xml=listing([0,1,2,3],active),{dir,source,name,sha256}=await show(t,xml,`sk-move-matrix-${active}-`);
  for(let from=0;from<count;from++)for(let to=0;to<count;to++){
   const destination=path.join(dir,`${from}-${to}.skshow`),call=editShowSetlistCopy({source,destination,sha256,name,operation:'move_set',setName:names[from],toIndex:to});
   if(from===to){await assert.rejects(call,/already at the destination/);await assert.rejects(readFile(destination),{code:'ENOENT'});continue;}
   await call;
   // Independent oracle: reorder names, then find where the active name went.
   const expected=[...names];expected.splice(to,0,...expected.splice(from,1));
   const text=(await readShowPart({file:destination,name})).text;
   assert.deepEqual((await inspectShowSetlist({file:destination,name})).sets.map(s=>s.name),expected);
   assert.equal(activeOf(text),expected.indexOf(names[active]),`active ${active}, ${from}->${to}`);
   assert.equal(text,listing(expected.map(n=>names.indexOf(n)),expected.indexOf(names[active])));
  }
 }
});

test('active index can change digit count without shifting other bytes',async t=>{
 const many=Array.from({length:11},(_,i)=>`<set name="S${i}"><entry track="T${i}"/></set>`);
 const xml=active=>`<sksetlist version="2" active="${active}">\n${many.join('\n')}\n</sksetlist>`;
 const {dir,source,name,sha256}=await show(t,xml(10));
 await editShowSetlistCopy({source,destination:path.join(dir,'shrink.skshow'),sha256,name,operation:'move_set',setName:'S10',toIndex:0});
 assert.equal((await readShowPart({file:path.join(dir,'shrink.skshow'),name})).text,`<sksetlist version="2" active="0">\n${[many[10],...many.slice(0,10)].join('\n')}\n</sksetlist>`);
 const grow=await show(t,xml(9));
 await editShowSetlistCopy({source:grow.source,destination:path.join(grow.dir,'grow.skshow'),sha256:grow.sha256,name,operation:'move_set',setName:'S10',toIndex:0});
 assert.equal((await readShowPart({file:path.join(grow.dir,'grow.skshow'),name})).text,`<sksetlist version="2" active="10">\n${[many[10],...many.slice(0,10)].join('\n')}\n</sksetlist>`);
});

test('move_set rejects unsafe or ambiguous input and publishes nothing',async t=>{
 const base='<sksetlist version="2" active="0"><set name="A"/><set name="B"/><set name="C"/></sksetlist>';
 const cases=[
  [base,{setName:'A',toIndex:0},/already at the destination/],
  [base,{setName:'A',toIndex:3},/outside the set list/],
  [base,{setName:'A',toIndex:-1},/outside the set list/],
  [base,{setName:'A',toIndex:1.5},/outside the set list/],
  [base,{setName:'A'},/outside the set list/],
  [base,{setName:'Z',toIndex:1},/exactly once/],
  [base,{setName:'',toIndex:1},/exactly once/],
  [base,{setName:'A',toIndex:1,index:0},/setName and toIndex only/],
  [base,{setName:'A',toIndex:1,newSetName:'X'},/setName and toIndex only/],
  [base,{setName:'A',toIndex:1,allowContentRemoval:true},/setName and toIndex only/],
  ['<sksetlist version="2" active="0"><set name="A"/><set name="A"/><set name="B"/></sksetlist>',{setName:'A',toIndex:2},/exactly once/],
  ['<sksetlist version="2" active="0"><set name="A"/></sksetlist>',{setName:'A',toIndex:0},/already at the destination/],
  ...['',' active="-1"',' active="3"',' active="01"',' active="&#49;"',' active=""',' active="1.0"'].map(active=>[`<sksetlist version="2"${active}><set name="A"/><set name="B"/><set name="C"/></sksetlist>`,{setName:'A',toIndex:1},/active-set/]),
  // Elements other than set and entry are not reordered, because their position could carry meaning.
  ['<sksetlist version="2" active="0"><set name="A"><note/></set><set name="B"/></sksetlist>',{setName:'A',toIndex:1},/Unsupported set list structure/],
  ['<sksetlist version="2" active="0"><set name="A"/><meta/><set name="B"/></sksetlist>',{setName:'A',toIndex:1},/Unsupported set list structure/],
  ['<sksetlist version="2" active="0"><set name="A"/>text<set name="B"/></sksetlist>',{setName:'A',toIndex:1},/Unsupported set list text/],
  ['<sksetlist version="1" active="0"><set name="A"/><set name="B"/></sksetlist>',{setName:'A',toIndex:1},/version 2/],
 ];
 for(const [xml,args,error] of cases){
  const {dir,source,name,original,sha256}=await show(t,xml,'sk-move-bad-'),destination=path.join(dir,'out.skshow');
  await assert.rejects(editShowSetlistCopy({source,destination,sha256,name,operation:'move_set',...args}),error,JSON.stringify(args)+xml);
  await assert.rejects(readFile(destination),{code:'ENOENT'});assert.equal(await readFile(source,'utf8'),original);
 }
 const {dir,source,name}=await show(t,base,'sk-move-stale-');
 await assert.rejects(editShowSetlistCopy({source,destination:path.join(dir,'out.skshow'),sha256:'0'.repeat(64),name,operation:'move_set',setName:'A',toIndex:1}),/changed/);
 await assert.rejects(editShowSetlistCopy({source,destination:path.join(dir,'out.skshow'),sha256:'0'.repeat(64),name:'patch.skf',operation:'move_set',setName:'A',toIndex:1}),/\.skls/);
});

test('multi-track composition orders move_set with other set operations and rolls back',async t=>{
 const xml='<sksetlist version="2" active="2"><set name="A"><entry track="Intro"/></set><set name="B"/><set name="C"/></sksetlist>';
 const {dir,source,name,original,sha256}=await show(t,xml,'sk-move-compose-');
 const operations=[
  {operation:'create_set',name,newSetName:'New'},
  {operation:'move_set',name,setName:'New',toIndex:0},
  {operation:'move_set',name,setName:'C',toIndex:1},
  {operation:'remove_set',name,setName:'B'},
  {operation:'append_track',name,setName:'New',trackName:'Intro'},
 ];
 const destination=path.join(dir,'out.skshow');
 const result=await composeMultiTrackShowCopy({source,destination,sha256,tracks:[],setlistOperations:operations});
 assert.deepEqual(result.setlistOperations,operations);
 // C was active throughout: index 2, then 3 after New moved to the front, then 1, and still 1 after B (index 3) was removed.
 assert.equal((await readShowPart({file:destination,name})).text,'<sksetlist version="2" active="1"><set name="New"><entry track="Intro"/></set><set name="C"/><set name="A"><entry track="Intro"/></set></sksetlist>');
 for(const [i,ops] of [
  [...operations,{operation:'move_set',name,setName:'A',toIndex:2}],
  [operations[0],{operation:'move_set',name,setName:'New',toIndex:4}],
  [{operation:'move_set',name,setName:'A',toIndex:1,index:0}],
  [{operation:'move_set',name,setName:'A'}],
  [{operation:'move_set',name,setName:'A',toIndex:'1'}],
 ].entries()){
  const target=path.join(dir,`bad${i}.skshow`);
  await assert.rejects(composeMultiTrackShowCopy({source,destination:target,sha256,tracks:[],setlistOperations:ops}));
  await assert.rejects(readFile(target),{code:'ENOENT'});
 }
 assert.equal(await readFile(source,'utf8'),original);assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
});

test('full-show composition moves a set next to a new track and keeps Program-free shows valid',async t=>{
 const xml='<sksetlist version="2" active="0"><set name="Main"><entry track="Intro"/></set><set name="Late"/></sksetlist>';
 const dir=await temp(t,'sk-move-full-'),source=path.join(dir,'source.skshow'),name='Set.skls';
 const input=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer/></layers></sktimeline>')}${part('content/Intro.sktl','<sktimeline version="1" name="Intro"><layers><layer/></layers></sktimeline>')}${part(name,xml)}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 await writeFile(source,input);
 const tracks=[{templateName:'Empty.sktl',trackName:'Opener',partName:'content/Opener.sktl',cues:[{layer:0,startMs:0,lengthMs:100,label:'Go'}],set:{name,setName:'Late'}}];
 const destination=path.join(dir,'out.skshow');
 const result=await composeFullShowCopy({source,destination,sha256:sha(input),tracks,setlistOperations:[{operation:'move_set',name,setName:'Late',toIndex:0}]});
 assert.deepEqual(result.validation.diagnostics,[]);
 assert.equal((await readShowPart({file:destination,name})).text,'<sksetlist version="2" active="1"><set name="Late"><entry track="Opener"/></set><set name="Main"><entry track="Intro"/></set></sksetlist>');
 const failed=path.join(dir,'failed.skshow');
 await assert.rejects(composeFullShowCopy({source,destination:failed,sha256:sha(input),tracks,setlistOperations:[{operation:'move_set',name,setName:'Late',toIndex:0},{operation:'move_set',name,setName:'Late',toIndex:0}]}),/already at the destination/);
 await assert.rejects(readFile(failed),{code:'ENOENT'});assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
});

test('session composition moves a set and publishes no session when a move fails',async t=>{
 const dir=await realpath(await temp(t,'sk-move-session-')),session=path.join(dir,'Session A');
 await mkdir(path.join(session,'MEDIA'),{recursive:true});
 const name='Set.skls',xml='<sksetlist version="2" active="1"><set name="Main"/><set name="Encore"/><set name="Spare"/></sksetlist>';
 const patch='<showkontrol version="2" name="Show"><graph/><appSettings/></showkontrol>';
 const showXml=`<skshow>${part(name,xml)}${part('patch.skf',patch)}</skshow>`;
 await writeFile(path.join(session,'session.skshow'),showXml);await writeFile(path.join(session,'session.skf'),patch.replace('name="Show"','name="Session A"'));
 const destination=path.join(dir,'Session B'),args={source:session,destination,sha256:sha(showXml)};
 const result=await composeSessionMediaCopy({...args,setlistOperations:[{operation:'move_set',name,setName:'Spare',toIndex:0}]});
 assert.deepEqual(result.setlistOperations,[{operation:'move_set',name,setName:'Spare',toIndex:0}]);
 assert.equal((await readShowPart({file:path.join(destination,'session.skshow'),name})).text,'<sksetlist version="2" active="2"><set name="Spare"/><set name="Main"/><set name="Encore"/></sksetlist>');
 const failed=path.join(dir,'Session C');
 await assert.rejects(composeSessionMediaCopy({...args,destination:failed,setlistOperations:[{operation:'move_set',name,setName:'Spare',toIndex:0},{operation:'move_set',name,setName:'Gone',toIndex:0}]}),/exactly once/);
 await assert.rejects(readdir(failed),{code:'ENOENT'});
 assert.deepEqual((await readdir(dir)).sort(),['Session A','Session B']);
 assert.equal(await readFile(path.join(session,'session.skshow'),'utf8'),showXml);
});
