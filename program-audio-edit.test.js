import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeProgramEditsCopy} from './program-edit-compose.js';
import {composeFullShowCopy} from './compose-full-show.js';
import {inspectShowProgram,inspectProgramTimeline} from './program.js';
import {readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {validateShow} from './validate-show.js';

const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
const clip={name:'Kick',file:'/media/kick.wav',wave:'',grid:'',pps:'315',offsetMs:'1000',trimStartMs:'0',trimEndMs:'2000',fadeInMs:'0',fadeOutMs:'250'};
// Item timelines in the app-saved lane shape, with unknown attributes and elements that must survive.
const clipA='<clip name="Intro" file="/orig/intro.wav" wave="w1" grid="g1" pps="315" offsetMs="0" vol="1" trimStartMs="0" trimEndMs="4000" fadeInMs="0" fadeOutMs="0" extra="keep"/>';
const clipB='<clip name="Loop" file="/orig/loop.wav" wave="" grid="" pps="315" offsetMs="4000" vol="0.5" trimStartMs="0" trimEndMs="8000" fadeInMs="10" fadeOutMs="10"/>';
const head='<sktimeline version="1" name="Doors timeline"><layers><layer name="L"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Go"/>';
const laneMain=`<audio name="Main" follow="1">\n ${clipA}\n ${clipB}\n</audio>`;
const tail='<marker unknown="kept">text</marker><deck id="d" foo="1"/></sktimeline>';
const doors=head+laneMain+tail;
const other='<sktimeline version="1" name="Show timeline"><audio name="Main" follow="0"><clip name="Other" file="/orig/other.wav" wave="" grid="" pps="1" offsetMs="0" vol="1" trimStartMs="0" trimEndMs="1" fadeInMs="0" fadeOutMs="0"/></audio><deck/></sktimeline>';
const graph='<graph><node id="n7" type="trigger"><settings><setting key="trigger.path">item.active</setting></settings></node></graph>';
const program=(a=doors,b=other)=>`<skprogram version="1"><item start="0" name="Doors" notes="">${a}</item><item start="1000" name="Show" notes="Main act">${graph}${b}</item><item start="2000" name="Close" notes=""/></skprogram>`;
const patch='<showkontrol version="2"><graph><node id="n1" type="x"/></graph><appSettings/></showkontrol>';

async function fixture(t,{programXml=program(),track='<sktimeline version="1" name="Song"><audio name="Song lane" follow="1"/><deck/></sktimeline>'}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-audio-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const show=`<skshow>${part('content/Song.sktl',track)}${part('patch.skf',patch)}${part('content/Program.skpr',programXml)}</skshow>`;
 const source=path.join(dir,'in.skshow');await writeFile(source,show);
 return {dir,source,show,sha256:hash('sha256',show),destination:path.join(dir,'out.skshow')};
}
const programText=async file=>{const snapshot=await readShowSnapshot({file});return readSnapshotPart({snapshot,name:'content/Program.skpr'}).text;};
async function assertNothingPublished(f){
 await assert.rejects(readFile(f.destination),{code:'ENOENT'});
 assert.deepEqual((await readdir(f.dir)).sort(),['in.skshow']);
 assert.equal(await readFile(f.source,'utf8'),f.show);
}

test('ordered Program audio edits add, edit and remove lanes and clips with only the selected bytes changed',async t=>{
 const f=await fixture(t);
 const operations=[
  {action:'add_timeline_audio_lane',index:0,laneName:'Stems',follow:false},
  {action:'add_timeline_audio_clip',index:0,audioIndex:1,clip},
  {action:'edit_timeline_audio_clip',index:0,audioIndex:0,clipIndex:0,attributes:{file:'/new/intro.wav',wave:'',grid:'',vol:'0.8'}},
  {action:'remove_timeline_audio_clip',index:0,audioIndex:0,clipIndex:1},
  {action:'edit_timeline_audio_clip',index:1,audioIndex:0,clipIndex:0,attributes:{name:'Renamed'}}
 ];
 const before=await inspectProgramTimeline({file:f.source,sha256:f.sha256,index:0});
 assert.deepEqual(before.audioClips.map(c=>[c.audioIndex,c.clipIndex,c.attributes.name]),[[0,0,'Intro'],[0,1,'Loop']]);
 const r=await composeProgramEditsCopy({source:f.source,destination:f.destination,sha256:f.sha256,operations});
 assert.equal(await readFile(f.source,'utf8'),f.show);
 // Expected bytes built independently of the tools: the new lane goes before the deck, the clip is appended,
 // three attributes change in place, and the removed clip's surrounding whitespace stays.
 const newClip='<clip name="Kick" file="/media/kick.wav" wave="" grid="" pps="315" offsetMs="1000" trimStartMs="0" trimEndMs="2000" fadeInMs="0" fadeOutMs="250"/>';
 const editedA=clipA.replace('file="/orig/intro.wav" wave="w1" grid="g1"','file="/new/intro.wav" wave="" grid=""').replace('vol="1"','vol="0.8"');
 const doorsAfter=head+`<audio name="Main" follow="1">\n ${editedA}\n \n</audio>`+'<marker unknown="kept">text</marker>'+`<audio name="Stems" follow="0">${newClip}</audio>`+'<deck id="d" foo="1"/></sktimeline>';
 assert.equal(await programText(f.destination),program(doorsAfter,other.replace('name="Other"','name="Renamed"')));
 // Independent read-back through the inspection tools.
 const inspected=await inspectProgramTimeline({file:f.destination,sha256:r.sha256,index:0});
 assert.deepEqual(inspected.audio,[{name:'Main',follow:'1'},{name:'Stems',follow:'0'}]);
 assert.deepEqual(inspected.audioClips.map(c=>[c.audioIndex,c.clipIndex,c.attributes.name,c.attributes.file]),[[0,0,'Intro','/new/intro.wav'],[1,0,'Kick','/media/kick.wav']]);
 assert.deepEqual((await validateShow({file:f.destination})).diagnostics.filter(d=>d.severity==='error'),[]);
 assert.deepEqual(r.audioOperations.map(o=>[o.operationIndex,o.action,o.itemIndex,o.audioIndex,o.clipIndex]),[[0,'add_timeline_audio_lane',0,1,undefined],[1,'add_timeline_audio_clip',0,1,0],[2,'edit_timeline_audio_clip',0,0,0],[3,'remove_timeline_audio_clip',0,0,1],[4,'edit_timeline_audio_clip',1,0,0]]);
 assert.equal(r.audioOperations[0].position,'before_deck');
 assert.deepEqual(r.audioOperations[2].previous,{file:'/orig/intro.wav',wave:'w1',grid:'g1',vol:'1'});
 assert.equal(r.audioOperations[3].removed.name,'Loop');
 assert.equal(r.validation.file,f.destination);
 assert.ok(r.warnings.some(w=>typeof w==='string'&&/media\.map rows are not checked/.test(w)));
 assert.deepEqual((await readdir(f.dir)).sort(),['in.skshow','out.skshow']);
});

test('Program audio indices follow earlier item operations',async t=>{
 const f=await fixture(t);
 // Removing item 0 makes the former item 1 the target of index 0.
 const r=await composeProgramEditsCopy({source:f.source,destination:f.destination,sha256:f.sha256,operations:[{action:'remove',index:0,allowContentRemoval:true},{action:'remove_timeline_audio_clip',index:0,audioIndex:0,clipIndex:0}]});
 assert.deepEqual((await inspectShowProgram({file:f.destination})).items.map(i=>i.name),['Show','Close']);
 assert.deepEqual((await inspectProgramTimeline({file:f.destination,sha256:r.sha256,index:0})).audioClips,[]);
 assert.equal(r.audioOperations[0].removed.name,'Other');
});

test('lane removal requires removeClips and checks literal lane-name references across the Program and show',async t=>{
 let f=await fixture(t);
 await assert.rejects(composeProgramEditsCopy({source:f.source,destination:f.destination,sha256:f.sha256,operations:[{action:'remove_timeline_audio_lane',index:0,audioIndex:0}]}),/set removeClips to true/);
 await assertNothingPublished(f);
 // A lane with the same name in another item's timeline is a definition, not a reference.
 const r=await composeProgramEditsCopy({source:f.source,destination:f.destination,sha256:f.sha256,operations:[{action:'remove_timeline_audio_lane',index:0,audioIndex:0,removeClips:true}]});
 assert.equal(await programText(f.destination),program(head+tail,other));
 assert.deepEqual(r.audioOperations[0].removedClips.map(c=>c.name),['Intro','Loop']);
 // The lane name as Program text (another item's graph setting or notes) or in a track part blocks removal.
 const referenced=[
  {programXml:program(doors,other).replace('item.active','Main'),message:/appears literally in content\/Program\.skpr/},
  {programXml:program(doors,other).replace('notes="Main act"','notes="Main"'),message:/appears literally in content\/Program\.skpr/},
  {programXml:program(doors,other).replace('name="Show"','name="Main"'),message:/appears literally in content\/Program\.skpr/},
  {track:'<sktimeline version="1" name="Song"><cue id="s1" layer="0" startMs="0" lenMs="1" label="Main"/></sktimeline>',message:/appears literally in content\/Song\.sktl/}
 ];
 for(const options of referenced){
  f=await fixture(t,options);
  await assert.rejects(composeProgramEditsCopy({source:f.source,destination:f.destination,sha256:f.sha256,operations:[{action:'remove_timeline_audio_lane',index:0,audioIndex:0,removeClips:true}]}),options.message);
  await assertNothingPublished(f);
 }
 // A reference inside the selected item timeline is found by the timeline tool itself.
 f=await fixture(t,{programXml:program(doors.replace('label="Go"','label="Main"'),other)});
 await assert.rejects(composeProgramEditsCopy({source:f.source,destination:f.destination,sha256:f.sha256,operations:[{action:'remove_timeline_audio_lane',index:0,audioIndex:0,removeClips:true}]}),/appears literally/);
 await assertNothingPublished(f);
});

test('unsafe, ambiguous or unsupported Program audio operations publish nothing',async t=>{
 const ided=program(doors.replace('<clip name="Loop"','<clip id="x1" name="Loop"'),other);
 const noDeck=program(doors.replace('<deck id="d" foo="1"/>',''),other);
 const cases=[
  [{},[{action:'add_timeline_audio_lane',index:0,laneName:'Main',follow:true}],/lane name already exists/],
  // Without a deck only the app-saved empty-track shape is accepted; here a cue precedes and a marker follows the lane.
  [{programXml:noDeck},[{action:'add_timeline_audio_lane',index:0,laneName:'New',follow:true}],/directly after layers at the end/],
  [{},[{action:'add_timeline_audio_clip',index:2,audioIndex:0,clip}],/no embedded timeline/],
  [{},[{action:'add_timeline_audio_clip',index:0,audioIndex:5,clip}],/Audio lane does not exist/],
  [{},[{action:'add_timeline_audio_clip',index:0,audioIndex:0,clip:{...clip,trimEndMs:'0'}}],/trimEndMs must exceed/],
  [{},[{action:'add_timeline_audio_clip',index:0,laneName:'Main',clip}],/Unsupported edit composition input/],
  [{},[{action:'edit_timeline_audio_clip',index:0,audioIndex:0,clipIndex:0,attributes:{file:'/new.wav'}}],/requires an explicit wave/],
  [{},[{action:'edit_timeline_audio_clip',index:0,audioIndex:0,clipIndex:9,attributes:{name:'X'}}],/outside the existing direct clips/],
  [{},[{action:'edit_timeline_audio_clip',index:0,audioIndex:0,clipIndex:0,attributes:{missing:'1'}}],/supported attributes/],
  [{programXml:ided},[{action:'remove_timeline_audio_clip',index:0,audioIndex:0,clipIndex:1}],/carries an id attribute/],
  [{programXml:ided},[{action:'remove_timeline_audio_lane',index:0,audioIndex:0,removeClips:true}],/carries an id attribute/],
  [{},[{action:'remove_timeline_audio_lane',index:0,audioIndex:0,removeClips:'yes'}],/removeClips must be a boolean/],
  // A valid edit followed by a failing removal leaves nothing behind.
  [{},[{action:'edit_timeline_audio_clip',index:0,audioIndex:0,clipIndex:0,attributes:{name:'X'}},{action:'remove_timeline_audio_clip',index:0,audioIndex:0,clipIndex:2}],/outside the existing direct clips/]
 ];
 for(const [options,operations,message] of cases){
  const f=await fixture(t,options);
  await assert.rejects(composeProgramEditsCopy({source:f.source,destination:f.destination,sha256:f.sha256,operations}),message,JSON.stringify(operations));
  await assertNothingPublished(f);
 }
});

test('the full-show composer applies Program audio operations and returns their receipts',async t=>{
 const f=await fixture(t);
 const r=await composeFullShowCopy({source:f.source,destination:f.destination,sha256:f.sha256,program:{operations:[{action:'add_timeline_audio_clip',index:1,audioIndex:0,clip}]}});
 assert.deepEqual(r.program.audioOperations.map(o=>[o.itemIndex,o.audioIndex,o.clipIndex]),[[1,0,1]]);
 assert.deepEqual((await inspectProgramTimeline({file:f.destination,sha256:r.sha256,index:1})).audioClips.map(c=>c.attributes.name),['Other','Kick']);
 assert.equal(r.validation.file,f.destination);
});
