import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {inspectShow,readShowPart} from './xml-copy.js';
import {editShowSetlistCopy} from './setlist.js';
import {composeMultiTrackShowCopy} from './compose-multi-show.js';

const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('remove sets adjusts active and preserves surrounding XML and parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-remove-set-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source'),name='Set.skls',other=part('other.xml','<other/>');
 const xml=`<sksetlist version="2" note=" active='8' " active='1'><!--keep--><set name="A"/><set name="B"><entry track="T"/></set><set name="C"></set></sksetlist>`;
 const original=`<skshow>${part(name,xml)}${other}</skshow>`;await writeFile(source,original);const {sha256}=await inspectShow({file:source});
 for(const [setName,active] of [['A',0],['B',0],['C',1]]){
  const destination=path.join(dir,setName);await editShowSetlistCopy({source,destination,sha256,name,operation:'remove_set',setName,allowContentRemoval:true});
  const actual=(await readShowPart({file:destination,name})).text;
  assert.equal(actual,xml.replace("active='1'",`active='${active}'`).replace(setName==='A'?'<set name="A"/>':setName==='B'?'<set name="B"><entry track="T"/></set>':'<set name="C"></set>',''));
  assert.ok((await readFile(destination,'utf8')).includes(other));
 }
 await assert.rejects(editShowSetlistCopy({source,destination:path.join(dir,'guard'),sha256,name,operation:'remove_set',setName:'B'}),/allowContentRemoval/);
 assert.equal(await readFile(source,'utf8'),original);
});
test('rejects last set, ambiguous names and invalid active indices',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-remove-bad-'));t.after(()=>rm(dir,{recursive:true,force:true}));const name='Set.skls';
 const cases=[['<sksetlist version="2" active="0"><set name="A"/></sksetlist>',/last set/],['<sksetlist version="2" active="0"><set name="A"/><set name="A"/></sksetlist>',/exactly once/],...['',' active="-1"',' active="2"',' active="01"',' active="&#49;"'].map(active=>[`<sksetlist version="2"${active}><set name="A"/><set name="B"/></sksetlist>`,/active-set/])];
 for(let i=0;i<cases.length;i++){const source=path.join(dir,`s${i}`),destination=path.join(dir,`d${i}`);await writeFile(source,`<skshow>${part(name,cases[i][0])}</skshow>`);const {sha256}=await inspectShow({file:source});await assert.rejects(editShowSetlistCopy({source,destination,sha256,name,operation:'remove_set',setName:'A'}),cases[i][1]);await assert.rejects(readFile(destination),{code:'ENOENT'});}
});
test('composition applies ordered removals and rolls back later failures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-remove-compose-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'source'),destination=path.join(dir,'out'),name='Set.skls';
 const original=`<skshow>${part(name,'<sksetlist version="2" active="1"><set name="A"/><set name="B"><entry track="T"/></set><set name="C"/></sksetlist>')}</skshow>`;await writeFile(source,original);const {sha256}=await inspectShow({file:source});
 const removeA={operation:'remove_set',name,setName:'A'},removeB={operation:'remove_set',name,setName:'B',allowContentRemoval:true};
 await composeMultiTrackShowCopy({source,destination,sha256,tracks:[],setlistOperations:[removeA,removeB]});assert.equal((await readShowPart({file:destination,name})).text,'<sksetlist version="2" active="0"><set name="C"/></sksetlist>');
 for(const [i,ops] of [[removeA,{...removeB,allowContentRemoval:false}],[removeA,removeB,{operation:'remove_set',name,setName:'C'}],[{...removeA,allowContentRemoval:'yes'}]].entries()){const target=path.join(dir,`bad${i}`);await assert.rejects(composeMultiTrackShowCopy({source,destination:target,sha256,tracks:[],setlistOperations:ops}));await assert.rejects(readFile(target),{code:'ENOENT'});}
 assert.equal(await readFile(source,'utf8'),original);assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol-')),[]);
});
test('rejects literal references and unreadable supported parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-set-refs-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const name='Set.skls',list='<sksetlist version="2" active="0"><set name="A+B"/><set name="Other"/></sksetlist>';
 const cases=[
  ['ref.skf','<show><action value="select a+b"/></show>',/reference in ref\.skf/],
  ['ref.sktl','<timeline><setting>A&#43;B</setting></timeline>',/reference in ref\.sktl/],
  ['bad.skpr','<program>',/unclosed|unexpected|end/i],
  ['bad.sksc',Buffer.from([0xff]),/UTF-8/],
 ];
 for(let i=0;i<cases.length;i++){
  const [other,content,error]=cases[i],source=path.join(dir,`s${i}`),destination=path.join(dir,`d${i}`);
  await writeFile(source,`<skshow>${part(name,list)}${part(other,content)}</skshow>`);const {sha256}=await inspectShow({file:source});
  await assert.rejects(editShowSetlistCopy({source,destination,sha256,name,operation:'remove_set',setName:'A+B'}),error);
  await assert.rejects(readFile(destination),{code:'ENOENT'});
 }
});
