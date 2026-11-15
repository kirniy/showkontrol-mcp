import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {inspectShow} from './xml-copy.js';
import {inspectShowSetlist} from './setlist.js';
import {composeMultiTrackShowCopy} from './compose-multi-show.js';

const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('creates a set list before ordered edits and rolls back invalid compositions',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-create-compose-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),destination=path.join(dir,'out.skshow');
 const input=`<skshow>${part('One.sktl','<sktimeline version="1" name="One"><layers><layer/></layers></sktimeline>')}${part('Two.sktl','<sktimeline version="1" name="Two"><layers><layer/></layers></sktimeline>')}</skshow>`;
 await writeFile(source,input);const {sha256}=await inspectShow({file:source});
 const create={operation:'create_setlist',name:'content/Set.skls',setName:'Main',tracks:['One']};
 const operations=[create,{operation:'create_set',name:create.name,newSetName:'Other'},{operation:'append_track',name:create.name,setName:'Other',trackName:'Two'}];
 const result=await composeMultiTrackShowCopy({source,destination,sha256,tracks:[],setlistOperations:operations});
 assert.deepEqual(result.setlistOperations,operations);assert.equal(result.sha256,(await inspectShow({file:destination})).sha256);assert.notEqual(result.sha256,sha256);
 assert.deepEqual((await inspectShowSetlist({file:destination,name:create.name})).sets,[{name:'Main',tracks:['One']},{name:'Other',tracks:['Two']}]);
 const failures=[
  [create,create],
  [create,{operation:'append_track',name:create.name,setName:'Other',trackName:'Two'}],
  [{...create,tracks:['One','One']}],
  [{...create,tracks:'One'}],
  [{...create,extra:true}],
  [{...create,tracks:['Missing']}],
 ];
 for(let i=0;i<failures.length;i++){const target=path.join(dir,`failed-${i}`);await assert.rejects(composeMultiTrackShowCopy({source,destination:target,sha256,tracks:[],setlistOperations:failures[i]}));await assert.rejects(readFile(target),{code:'ENOENT'});}
 const stale=path.join(dir,'stale');await assert.rejects(composeMultiTrackShowCopy({source,destination:stale,sha256:'0'.repeat(64),tracks:[],setlistOperations:[create]}),/changed/);await assert.rejects(readFile(stale),{code:'ENOENT'});
 const empty=path.join(dir,'empty');await composeMultiTrackShowCopy({source,destination:empty,sha256,tracks:[],setlistOperations:[{operation:'create_setlist',name:create.name,setName:'Empty'}]});assert.deepEqual((await inspectShowSetlist({file:empty,name:create.name})).sets,[{name:'Empty',tracks:[]}]);
 assert.equal(await readFile(source,'utf8'),input);assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.showkontrol-')),[]);
});
