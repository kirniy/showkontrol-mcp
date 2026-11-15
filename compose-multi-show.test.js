import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import os from 'node:os';
import {inspectShow} from './xml-copy.js';import {inspectShowTimeline,inspectCueGraph} from './timeline.js';import {inspectShowSetlist} from './setlist.js';import {composeMultiTrackShowCopy} from './compose-multi-show.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('compose multiple tracks with independent donors, cues and set entries',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-multitrack-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),donorFile=path.join(dir,'donor.skshow'),destination=path.join(dir,'out.skshow');
 const input=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer/></layers></sktimeline>')}${part('Set.skls','<sksetlist version="2"><set name="Main"/></sksetlist>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;
 const donor=`<skshow>${part('Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>')}</skshow>`;
 await writeFile(source,input);await writeFile(donorFile,donor);const sha256=(await inspectShow({file:source})).sha256;
 const cue={layer:0,startMs:0,lengthMs:100,label:'Go'},set={name:'Set.skls',setName:'Main'};
 const tracks=[{templateName:'Empty.sktl',trackName:'First',partName:'content/First.sktl',cues:[{...cue,settings:[{nodeId:'n1',key:'trigger.path',value:'new'}]}],set,donor:{file:donorFile,sha256:(await inspectShow({file:donorFile})).sha256,name:'Donor.sktl',cueId:'d'}},{templateName:'Empty.sktl',trackName:'Second',partName:'content/Second.sktl',cues:[{...cue,label:'Next'}],set}];
 const result=await composeMultiTrackShowCopy({source,destination,sha256,tracks});assert.equal(result.tracks.length,2);assert.equal(result.sha256,(await inspectShow({file:destination})).sha256);
 for(const track of result.tracks){const timeline=await inspectShowTimeline({file:destination,name:track.partName});assert.equal(timeline.cueElements[0].attributes.id,track.cues[0].id);}
 assert.equal((await inspectCueGraph({file:destination,format:'skshow',name:'content/First.sktl',cueId:result.tracks[0].cues[0].id})).graph.nodes[0].settings[0].value,'new');assert.equal((await inspectCueGraph({file:destination,format:'skshow',name:'content/Second.sktl',cueId:result.tracks[1].cues[0].id})).graph,null);
 assert.deepEqual((await inspectShowSetlist({file:destination,name:'Set.skls'})).sets,[{name:'Main',tracks:['First','Second']}]);
 assert.equal(await readFile(source,'utf8'),input);assert.equal(await readFile(donorFile,'utf8'),donor);
 await assert.rejects(composeMultiTrackShowCopy({source,destination,sha256,tracks}),{code:'EEXIST'});
 const badDestination=path.join(dir,'bad.skshow'); const badTrack={...tracks[0],trackName:'Bad',partName:'content/Bad.sktl',cues:[{...tracks[0].cues[0],settings:[{nodeId:'n1',key:'missing',value:'x'}]}]};
 await assert.rejects(composeMultiTrackShowCopy({source,destination:badDestination,sha256,tracks:[tracks[0],badTrack]}),/exactly once/);
 assert.deepEqual((await readdir(dir)).sort(),['donor.skshow','out.skshow','source.skshow']);
});
test('failed later track leaves no output and removes intermediates',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-multitrack-fail-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'source.skshow'),destination=path.join(dir,'out.skshow');
 const input=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;await writeFile(source,input);const sha256=(await inspectShow({file:source})).sha256;
 const track={templateName:'Empty.sktl',trackName:'First',partName:'content/First.sktl',cues:[{layer:0,startMs:0,lengthMs:100,label:'Go'}]};
 await assert.rejects(composeMultiTrackShowCopy({source,destination,sha256,tracks:[track,{...track,trackName:'Second',partName:'content/Second.sktl',cues:[{...track.cues[0],layer:9}]}]}),/outside/);
 await assert.rejects(composeMultiTrackShowCopy({source,destination,sha256:'0'.repeat(64),tracks:[track]}),/changed/);
 await assert.rejects(composeMultiTrackShowCopy({source,destination,sha256,tracks:[]}),/between 1 and 20/);
 assert.equal(await readFile(source,'utf8'),input);assert.deepEqual(await readdir(dir),['source.skshow']);
});

test('applies independent ordered layer operations to both tracks and cleans a later failure',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-multitrack-layers-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),destination=path.join(dir,'out.skshow');
 const input=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="Base"/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/></showkontrol>')}</skshow>`;await writeFile(source,input);
 const sha256=(await inspectShow({file:source})).sha256;
 const track=(name)=>({templateName:'Empty.sktl',trackName:name,partName:`content/${name}.sktl`,layerOperations:[{operation:'append',layerName:'Base',newName:'Copy'},{operation:'rename',layerName:'Copy',newName:name}],cues:[{layer:1,startMs:0,lengthMs:40,label:'Cue'}]});
 const tracks=[track('First'),track('Second')];
 await composeMultiTrackShowCopy({source,destination,sha256,tracks});
 for(const entry of tracks){const timeline=await inspectShowTimeline({file:destination,name:entry.partName});assert.deepEqual(timeline.layers.map(layer=>layer.name),['Base',entry.trackName]);assert.equal(timeline.cueElements[0].attributes.layer,'1');}
 const bad=path.join(dir,'bad.skshow');
 await assert.rejects(composeMultiTrackShowCopy({source,destination:bad,sha256,tracks:[tracks[0],{...tracks[1],layerOperations:[...tracks[1].layerOperations,{operation:'rename',layerName:'Missing',newName:'Bad'}]}]}),/exactly one/);
 assert.equal(await readFile(source,'utf8'),input);assert.deepEqual((await readdir(dir)).sort(),['out.skshow','source.skshow']);
});
