import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {inspectShowOverview} from './overview.js';

const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('overview summarizes one show snapshot without returning XML or settings',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-overview-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow');
 const xml=`<skshow>${part('patch.skf','<showkontrol version="2" name="Show"><graph><node id="n1" type="trigger" title="Start"><settings><setting key="secret">hidden</setting></settings></node></graph><appSettings/></showkontrol>')}${part('Track.sktl','<sktimeline version="1" name="Track"><layers><layer/></layers><cue id="c1"/><cue id="c2"/></sktimeline>')}${part('Set.skls','<sksetlist version="2"><set name="Set 1"><entry track="Track"/></set></sksetlist>')}${part('notes.txt','private content')}</skshow>`;
 await writeFile(file,xml);const result=await inspectShowOverview({file});
 assert.equal(result.sha256,createHash('sha256').update(xml).digest('hex'));assert.equal(result.parts.length,4);
 assert.deepEqual(result.timelines,[{part:'Track.sktl',name:'Track',cueCount:2,layerCount:1}]);
 assert.deepEqual(result.setlists,[{part:'Set.skls',sets:[{name:'Set 1',tracks:['Track']}]}]);
 assert.deepEqual(result.patch.nodes.map(({id,type,title})=>({id,type,title})),[{id:'n1',type:'trigger',title:'Start'}]);
 assert.doesNotMatch(JSON.stringify(result),/hidden|private content|<showkontrol/);
});
test('overview rejects corrupted parts and unsupported native part content',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-overview-invalid-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 await writeFile(file,`<skshow>${part('Track.sktl','<wrong/>')}</skshow>`);
 await assert.rejects(inspectShowOverview({file}),/Cannot summarize Track.sktl/);
 await writeFile(file,`<skshow>${part('Track.sktl','<sktimeline version="1"/>').replace(/md5="[a-f0-9]{32}"/,'md5="00000000000000000000000000000000"')}</skshow>`);
 await assert.rejects(inspectShowOverview({file}),/MD5/);
});
