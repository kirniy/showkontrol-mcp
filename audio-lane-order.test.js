import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,access,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {addTimelineAudioLaneCopy,addTimelineAudioClipCopy,renameTimelineAudioLaneCopy,moveTimelineAudioLaneCopy,renameAudioLaneXml,moveAudioLaneXml,laneOrderReference,parseTimeline,inspectShowTimeline} from './timeline.js';
import {composeShowCopy} from './compose-show.js';
import {composeFullShowCopy} from './compose-full-show.js';
import {composeProgramEditsCopy} from './program-edit-compose.js';
import {composeSessionMediaCopy} from './session-media-copy.js';
import {inspectProgramTimeline} from './program.js';
import {readShowSnapshot,readSnapshotPart,readShowPart} from './xml-copy.js';

// Byte-exact R27 27.0.11 app-saved empty track: the only app-saved lane evidence (one lane, name and follow).
const APP_EMPTY_TRACK='<?xml version="1.0" encoding="UTF-8"?><sktimeline version="1" name="Track 2" fps="25" fpsdef="1" offsetMs="0" smpteMs="0" media="" mediaWave="" mediaGrid="" mediaPps="75" mediaStructS="" mediaStructE="" mediaStructL=""><titles/><layers><layer name="Layer 1"/><layer name="Layer 2"/><layer name="Layer 3"/><layer name="Layer 4"/></layers><audio name="Audio 1" follow="0"/></sktimeline>';
const sha=value=>createHash('sha256').update(value).digest('hex');
const md5=value=>createHash('md5').update(value).digest('hex');
const part=(name,value)=>`<part name="${name}" md5="${md5(value)}">${Buffer.from(value).toString('base64')}</part>`;
const clip={name:'Vox take',file:'/music/vox.wav',wave:'',grid:'',pps:'315',offsetMs:'0',trimStartMs:'0',trimEndMs:'1000',fadeInMs:'0',fadeOutMs:'0'};
const clipXml='<clip name="Vox take" file="/music/vox.wav" wave="" grid="" pps="315" offsetMs="0" trimStartMs="0" trimEndMs="1000" fadeInMs="0" fadeOutMs="0"/>';
const head=APP_EMPTY_TRACK.slice(0,APP_EMPTY_TRACK.indexOf('<audio'));
const laneA='<audio name="Audio 1" follow="0"/>',laneV=`<audio name="Vox" follow="1">${clipXml}</audio>`,laneC='<audio name="Click" follow="0"/>';
// Three lanes as the existing add tools write them into the app-saved track.
const THREE=`${head}${laneA}${laneV}${laneC}</sktimeline>`;
const patch='<showkontrol version="2" name="Show"><graph/><appSettings/></showkontrol>';

async function tempDir(t){const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-lane-order-')));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function timelineFile(dir,xml,name='source.sktl'){const file=path.join(dir,name);await writeFile(file,xml);return {file,sha256:sha(xml)};}
async function showFile(dir,parts,name='in.skshow'){const xml=`<skshow>${parts.map(([n,v])=>part(n,v)).join('')}</skshow>`,file=path.join(dir,name);await writeFile(file,xml);return {file,xml,sha256:sha(xml)};}
const temps=async dir=>(await readdir(dir)).filter(n=>n.startsWith('.showkontrol'));
async function assertNoOutput(dir,destination){await assert.rejects(access(destination));assert.deepEqual(await temps(dir),[]);}
const lanes=xml=>parseTimeline(xml).audio.map(a=>a.name);
const clipsAt=xml=>parseTimeline(xml).audioClips.map(c=>[c.audioIndex,c.attributes.name]);

test('the fixture is the app-saved track grown by the existing lane and clip tools',async t=>{
 assert.equal(sha(APP_EMPTY_TRACK),'8c61339015f5f5a339791639fbb384c68eb32e9e24f1b7d7685c8b7f2baf9065');
 const dir=await tempDir(t),src=await timelineFile(dir,APP_EMPTY_TRACK);
 const a=await addTimelineAudioLaneCopy({source:src.file,destination:path.join(dir,'1.sktl'),format:'sktl',sha256:src.sha256,laneName:'Vox',follow:true});
 const b=await addTimelineAudioClipCopy({source:path.join(dir,'1.sktl'),destination:path.join(dir,'2.sktl'),format:'sktl',sha256:a.sha256,audioIndex:1,clip});
 await addTimelineAudioLaneCopy({source:path.join(dir,'2.sktl'),destination:path.join(dir,'3.sktl'),format:'sktl',sha256:b.sha256,laneName:'Click',follow:false});
 assert.equal(await readFile(path.join(dir,'3.sktl'),'utf8'),THREE);
});

test('rename changes only the lane name value and keeps the source and every other byte',async t=>{
 const dir=await tempDir(t),src=await timelineFile(dir,THREE),destination=path.join(dir,'out.sktl');
 const r=await renameTimelineAudioLaneCopy({source:src.file,destination,format:'sktl',sha256:src.sha256,audioIndex:2,laneName:'Click',newName:'Click & "count" <in>'});
 const out=await readFile(destination,'utf8');
 assert.equal(out,THREE.replace('<audio name="Click"','<audio name="Click &amp; &quot;count&quot; &lt;in&gt;"'));
 assert.equal(r.sha256,sha(out));assert.equal(r.previousName,'Click');assert.equal(r.laneName,'Click & "count" <in>');assert.deepEqual(r.lane,{name:'Click & "count" <in>',follow:'0'});
 assert.match(r.note,/REAPER import finds lanes by name/);
 assert.equal(await readFile(src.file,'utf8'),THREE);
 // Single-quoted names stay single-quoted; whitespace and unrelated attributes are untouched.
 const quoted=`${head}${laneA}\n  <audio  follow="1"   name='Vox'>${clipXml}</audio></sktimeline>`;
 assert.equal(renameAudioLaneXml(quoted,{audioIndex:1,laneName:'Vox',newName:`Lead's "vox"`}).modified,quoted.replace(`name='Vox'`,`name='Lead&apos;s "vox"'`));
 // A rename is reversible to the original bytes.
 const back=await renameTimelineAudioLaneCopy({source:destination,destination:path.join(dir,'back.sktl'),format:'sktl',sha256:r.sha256,audioIndex:2,laneName:'Click & "count" <in>',newName:'Click'});
 assert.equal(await readFile(back.destination,'utf8'),THREE);
 await assert.rejects(renameTimelineAudioLaneCopy({source:src.file,destination,format:'sktl',sha256:src.sha256,audioIndex:2,laneName:'Click',newName:'Other'}));
});

test('rename refuses imprecise selectors, the default song lane and ambiguous or referenced names',async t=>{
 const dir=await tempDir(t),destination=path.join(dir,'out.sktl');
 const cue=label=>`<cue id="c1" layer="0" startMs="0" lenMs="40" label="${label}"/>`;
 for(const [xml,args,pattern] of [
  [THREE,{audioIndex:1,laneName:'Click',newName:'X'},/is named "Vox", not "Click"/],
  [THREE,{audioIndex:3,laneName:'Click',newName:'X'},/does not exist/],
  [THREE,{audioIndex:0,laneName:'Audio 1',newName:'Song'},/to or from "Audio 1"/],
  [THREE,{audioIndex:2,laneName:'Click',newName:'Audio 1'},/to or from "Audio 1"/],
  [THREE,{audioIndex:2,laneName:'Click',newName:'Vox'},/already exists/],
  [THREE,{audioIndex:2,laneName:'Click',newName:'Click'},/must differ/],
  [THREE,{audioIndex:2,laneName:'Click',newName:' '},/nonempty single-line/],
  [THREE,{audioIndex:2,laneName:'Click',newName:'a\nb'},/nonempty single-line/],
  [THREE.replace('<audio name="Click" follow="0"/>','<audio name="Vox" follow="0"/>'),{audioIndex:2,laneName:'Vox',newName:'X'},/Several audio lanes are named "Vox"/],
  [THREE.replace('<audio name="Click" follow="0"/>','<audio name="Click" follow="0" device="2"/>'),{audioIndex:2,laneName:'Click',newName:'X'},/outside the observed name and follow \(device\)/],
  [THREE.replace('<audio name="Click" follow="0"/>','<audio name="Click" follow="0"><region/></audio>'),{audioIndex:2,laneName:'Click',newName:'X'},/unsupported content/],
  [THREE.replace('<audio name="Click" follow="0"/>','<audio name="Click" follow="0">x</audio>'),{audioIndex:2,laneName:'Click',newName:'X'},/unsupported text/],
  [THREE.replace('</sktimeline>',`${cue('Click')}</sktimeline>`),{audioIndex:2,laneName:'Click',newName:'X'},/"Click" appears literally/],
  [THREE.replace('</sktimeline>',`${cue('Count')}</sktimeline>`),{audioIndex:2,laneName:'Click',newName:'Count'},/"Count" appears literally/],
 ]){
  const src=await timelineFile(dir,xml);
  await assert.rejects(renameTimelineAudioLaneCopy({source:src.file,destination,format:'sktl',sha256:src.sha256,...args}),pattern);
  await assertNoOutput(dir,destination);
 }
 const src=await timelineFile(dir,THREE);
 await assert.rejects(renameTimelineAudioLaneCopy({source:src.file,destination,format:'sktl',sha256:'0'.repeat(64),audioIndex:2,laneName:'Click',newName:'X'}),/changed since inspection/);
 await assertNoOutput(dir,destination);
});

test('move permutes lane elements, keeps slot whitespace and reports the index map',async t=>{
 const dir=await tempDir(t);
 const four=`${head}${laneA}\n ${laneV}\n  ${laneC}\n   <audio name="Pad" follow="0"/></sktimeline>`,src=await timelineFile(dir,four),destination=path.join(dir,'out.sktl');
 const r=await moveTimelineAudioLaneCopy({source:src.file,destination,format:'sktl',sha256:src.sha256,audioIndex:1,laneName:'Vox',toIndex:3});
 const out=await readFile(destination,'utf8');
 // Expected bytes written out by hand: Vox (with its clip) goes last; the whitespace between slots stays where it was.
 assert.equal(out,`${head}${laneA}\n ${laneC}\n  <audio name="Pad" follow="0"/>\n   ${laneV}</sktimeline>`);
 assert.deepEqual(r.indexMap,[{from:1,to:3},{from:2,to:1},{from:3,to:2}]);
 assert.equal(r.audioIndex,3);assert.equal(r.fromIndex,1);assert.deepEqual(r.lanes.map(l=>l.name),['Audio 1','Click','Pad','Vox']);
 assert.deepEqual(clipsAt(out),[[3,'Vox take']]);
 assert.match(r.note,/order beyond the first lane/);
 assert.equal(await readFile(src.file,'utf8'),four);
 // Moving back restores the original bytes.
 const back=await moveTimelineAudioLaneCopy({source:destination,destination:path.join(dir,'back.sktl'),format:'sktl',sha256:r.sha256,audioIndex:3,laneName:'Vox',toIndex:1});
 assert.equal(await readFile(back.destination,'utf8'),four);
 // Adjacent swap, and a timeline with a deck after the lanes.
 assert.equal(moveAudioLaneXml(THREE,{audioIndex:2,laneName:'Click',toIndex:1}).modified,`${head}${laneA}${laneC}${laneV}</sktimeline>`);
 const decked=THREE.replace('</sktimeline>','<deck/><cue id="c" layer="0" startMs="0" lenMs="1" label="x"/></sktimeline>');
 assert.equal(moveAudioLaneXml(decked,{audioIndex:1,laneName:'Vox',toIndex:2}).modified,decked.replace(laneV+laneC,laneC+laneV));
});

test('move refuses the first position, imprecise selectors and every ambiguous structure',async t=>{
 const dir=await tempDir(t),destination=path.join(dir,'out.sktl');
 const setting=key=>`<cue id="c1" layer="0" startMs="0" lenMs="40" label="Go"><graph><node id="n1" type="trigger"><settings><setting key="${key}">2</setting></settings></node></graph></cue>`;
 for(const [xml,args,pattern] of [
  [THREE,{audioIndex:1,laneName:'Vox',toIndex:0},/into or out of the first position/],
  [THREE,{audioIndex:0,laneName:'Audio 1',toIndex:2},/into or out of the first position/],
  [THREE,{audioIndex:1,laneName:'Vox',toIndex:1},/must differ/],
  [THREE,{audioIndex:1,laneName:'Vox',toIndex:3},/existing lane position/],
  [THREE,{audioIndex:2,laneName:'Vox',toIndex:1},/is named "Click", not "Vox"/],
  [THREE.replace(laneC,`<cue id="c" layer="0" startMs="0" lenMs="1" label="x"/>${laneC}`),{audioIndex:1,laneName:'Vox',toIndex:2},/not one uninterrupted run/],
  [THREE.replace(laneC,`<!-- c -->${laneC}`),{audioIndex:1,laneName:'Vox',toIndex:2},/not one uninterrupted run/],
  [THREE.replace(laneC,`<video name="Video 1"/>${laneC}`),{audioIndex:1,laneName:'Vox',toIndex:2},/not one uninterrupted run/],
  [THREE.replace(laneA,'<audio name="Audio 1" follow="0" out="3-4"/>'),{audioIndex:1,laneName:'Vox',toIndex:2},/Audio lane 0 has attributes outside the observed name and follow \(out\)/],
  [THREE.replace('trimEndMs="1000"','trimEndMs="1000" link="2"'),{audioIndex:1,laneName:'Vox',toIndex:2},/clip 1\/0 has attributes outside the observed clip fields \(link\)/],
  [THREE.replace(clipXml,clipXml.replace('/>','><file>x</file></clip>')),{audioIndex:1,laneName:'Vox',toIndex:2},/clip 1\/0 has content/],
  [THREE.replace(laneC,'<audio name="Vox" follow="0"/>').replace(laneV,'<audio name="Vox2" follow="1"/>').replace('<audio name="Vox2"','<audio name="Vox"'),{audioIndex:1,laneName:'Vox',toIndex:2},/not unique/],
  [THREE.replace(laneC,'<audio follow="0"/>'),{audioIndex:1,laneName:'Vox',toIndex:2},/no usable name/],
  [THREE.replace('</sktimeline>','<deck><map lane="1"/></deck></sktimeline>'),{audioIndex:1,laneName:'Vox',toIndex:2},/deck element with content/],
  [THREE.replace('</sktimeline>','<deck id="d"/></sktimeline>'),{audioIndex:1,laneName:'Vox',toIndex:2},/deck element with content/],
  [THREE.replace('</sktimeline>',`${setting('player.audio.lane')}</sktimeline>`),{audioIndex:1,laneName:'Vox',toIndex:2},/key="player\.audio\.lane"/],
  [THREE.replace('</sktimeline>','<cue id="c1" layer="0" startMs="0" lenMs="40" label="Go" laneIndex="2"/></sktimeline>'),{audioIndex:1,laneName:'Vox',toIndex:2},/attribute laneIndex/],
  [THREE.replace('<titles/>','<titles><audioRef/></titles>'),{audioIndex:1,laneName:'Vox',toIndex:2},/element sktimeline\/titles\/audioRef/],
 ]){
  const src=await timelineFile(dir,xml);
  await assert.rejects(moveTimelineAudioLaneCopy({source:src.file,destination,format:'sktl',sha256:src.sha256,...args}),pattern);
  await assertNoOutput(dir,destination);
 }
 // Settings that only mention unrelated words do not block a move.
 assert.equal(laneOrderReference(`<x>${setting('trigger.path')}</x>`),null);
});

test('show copies scan the other parts, Program and Transitions plans for lane references',async t=>{
 const dir=await tempDir(t),destination=path.join(dir,'out.skshow');
 const other='<sktimeline version="1" name="B"><audio name="Click" follow="0"><clip name="o" lane="9"/></audio><video name="Video 1" layer="2"/></sktimeline>';
 const program=notes=>`<skprogram version="1"><item start="0" name="Doors" notes="${notes}"/></skprogram>`;
 const base=[['content/A.sktl',THREE],['content/B.sktl',other],['patch.skf',patch],['content/Program.skpr',program('')]];
 const show=await showFile(dir,base);
 // Other tracks' lane and video definitions, including a lane of the same name, do not block either operation.
 const moved=await moveTimelineAudioLaneCopy({source:show.file,destination,format:'skshow',sha256:show.sha256,name:'content/A.sktl',audioIndex:2,laneName:'Click',toIndex:1});
 const snapshot=await readShowSnapshot({file:destination});assert.ok(snapshot.parts.every(p=>p.valid));
 for(const [name,value] of base)assert.equal(readSnapshotPart({snapshot,name}).text,name==='content/A.sktl'?`${head}${laneA}${laneC}${laneV}</sktimeline>`:value);
 assert.deepEqual((await inspectShowTimeline({file:destination,name:'content/A.sktl'})).audio.map(a=>a.name),['Audio 1','Click','Vox']);
 assert.equal(moved.md5,md5(`${head}${laneA}${laneC}${laneV}</sktimeline>`));
 await renameTimelineAudioLaneCopy({source:show.file,destination:path.join(dir,'renamed.skshow'),format:'skshow',sha256:show.sha256,name:'content/A.sktl',audioIndex:2,laneName:'Click',newName:'Metronome'});
 for(const [parts,op,pattern] of [
  [[...base.slice(0,3),['content/Program.skpr',program('Click')]],'rename',/"Click" appears literally in content\/Program\.skpr/],
  [[...base.slice(0,3),['content/Program.skpr',program('Metronome')]],'rename',/"Metronome" appears literally in content\/Program\.skpr/],
  [[...base,['patch2.skf','<showkontrol version="2"><graph><node id="n" type="x" audioLane="2"/></graph></showkontrol>']],'move',/patch2\.skf has attribute audioLane/],
  [[...base,['TIMELINE/Transitions.sktr','<sktransitions><plan a="A" laneRef="audio 2"/></sktransitions>']],'move',/Transitions\.sktr has attribute laneRef/],
  [[...base,['TIMELINE/Transitions.sktr','not xml']],'move',/Transitions\.sktr could not be scanned/],
  [[...base,['TIMELINE/Transitions.sktr','not xml']],'rename',/Transitions\.sktr could not be scanned/],
 ]){
  const f=await showFile(dir,parts,'case.skshow');
  const call=op==='rename'?renameTimelineAudioLaneCopy({source:f.file,destination,format:'skshow',sha256:f.sha256,name:'content/A.sktl',audioIndex:2,laneName:'Click',newName:'Metronome'}):moveTimelineAudioLaneCopy({source:f.file,destination:path.join(dir,'never.skshow'),format:'skshow',sha256:f.sha256,name:'content/A.sktl',audioIndex:2,laneName:'Click',toIndex:1});
  await assert.rejects(call,pattern);
  await assertNoOutput(dir,path.join(dir,'never.skshow'));
 }
});

test('track composition runs ordered lane operations after the other audio operations',async t=>{
 const dir=await tempDir(t);
 const timeline=THREE.replace('</sktimeline>','<audio name="Spare" follow="0"/></sktimeline>');
 const show=await showFile(dir,[['content/A.sktl',timeline],['patch.skf',patch]]),destination=path.join(dir,'out.skshow');
 const r=await composeShowCopy({source:show.file,destination,sha256:show.sha256,existingPartName:'content/A.sktl',
  audioLanes:[{laneName:'Pad',follow:false}],
  audioClips:[{laneName:'Pad',clip:{...clip,name:'Pad take',file:'/music/pad.wav'}}],
  audioLaneRemovals:[{audioIndex:3}],
  // After the audio stage: Audio 1, Vox, Click, Pad. Each step addresses the previous step's result.
  audioLaneOperations:[
   {operation:'move',audioIndex:3,laneName:'Pad',toIndex:1},
   {operation:'rename',audioIndex:3,laneName:'Click',newName:'Metronome'},
   {operation:'move',audioIndex:2,laneName:'Vox',toIndex:3},
  ]});
 const out=readSnapshotPart({snapshot:await readShowSnapshot({file:destination}),name:'content/A.sktl'}).text;
 assert.deepEqual(lanes(out),['Audio 1','Pad','Metronome','Vox']);
 assert.deepEqual(clipsAt(out),[[1,'Pad take'],[3,'Vox take']]);
 assert.deepEqual(r.audioLanes,[{laneName:'Pad',audioIndex:1}]);
 assert.deepEqual(r.audioLaneOperations,[
  {operationIndex:0,operation:'move',fromIndex:3,audioIndex:1,laneName:'Pad',indexMap:[{from:1,to:2},{from:2,to:3},{from:3,to:1}]},
  {operationIndex:1,operation:'rename',audioIndex:3,previousName:'Click',laneName:'Metronome'},
  {operationIndex:2,operation:'move',fromIndex:2,audioIndex:3,laneName:'Vox',indexMap:[{from:2,to:3},{from:3,to:2}]},
 ]);
 assert.deepEqual(r.audioRemovals.lanes.map(l=>l.attributes.name),['Spare']);
 // A lane operation alone is enough for an existing track; a renamed added lane reports its final name.
 const only=await composeShowCopy({source:show.file,destination:path.join(dir,'only.skshow'),sha256:show.sha256,existingPartName:'content/A.sktl',audioLanes:[{laneName:'Pad',follow:false}],audioLaneOperations:[{operation:'rename',audioIndex:4,laneName:'Pad',newName:'Keys'}]});
 assert.deepEqual(only.audioLanes,[{laneName:'Pad',audioIndex:4,finalLaneName:'Keys'}]);
 assert.equal(readSnapshotPart({snapshot:await readShowSnapshot({file:only.destination}),name:'content/A.sktl'}).text,timeline.replace('</sktimeline>','<audio name="Keys" follow="0"/></sktimeline>'));
});

test('a failing lane operation publishes nothing and leaves no staging files',async t=>{
 const dir=await tempDir(t),show=await showFile(dir,[['content/A.sktl',THREE],['patch.skf',patch]]),target=path.join(dir,'failed.skshow');
 for(const [ops,pattern] of [
  [[{operation:'move',audioIndex:2,laneName:'Click',toIndex:1},{operation:'move',audioIndex:2,laneName:'Click',toIndex:1}],/is named "Vox", not "Click"/],
  [[{operation:'rename',audioIndex:1,laneName:'Vox',newName:'Lead'},{operation:'move',audioIndex:1,laneName:'Lead',toIndex:0}],/first position/],
  [[{operation:'rename',audioIndex:1,laneName:'Vox',newName:'Lead',toIndex:1}],/Audio lane operations must be/],
  [[{operation:'swap',audioIndex:1,laneName:'Vox',toIndex:2}],/Audio lane operations must be/],
  [[{operation:'move',audioIndex:1,toIndex:2}],/Audio lane operations must be/],
 ]){
  await assert.rejects(composeShowCopy({source:show.file,destination:target,sha256:show.sha256,existingPartName:'content/A.sktl',audioLaneOperations:ops}),pattern);
  await assertNoOutput(dir,target);
 }
 assert.equal(await readFile(show.file,'utf8'),show.xml);
});

// Program item timelines: the app says no deck plays lane 1 there, but other first-lane uses are not stated, so the same rules apply.
const itemTimeline=`<sktimeline version="1" name="Doors timeline"><layers><layer name="L"/></layers>${laneA}\n ${laneV}\n ${laneC}</sktimeline>`;
const programXml=(a=itemTimeline,notes='Main act')=>`<skprogram version="1"><item start="0" name="Doors" notes="">${a}</item><item start="1000" name="Show" notes="${notes}"/></skprogram>`;
async function programShow(t,{program=programXml(),extra=[]}={}){
 const dir=await tempDir(t),show=await showFile(dir,[['content/Song.sktl','<sktimeline version="1" name="Song"><audio name="Click" follow="0"/></sktimeline>'],['patch.skf',patch],['content/Program.skpr',program],...extra]);
 return {dir,...show,destination:path.join(dir,'out.skshow')};
}
const programText=async file=>readSnapshotPart({snapshot:await readShowSnapshot({file}),name:'content/Program.skpr'}).text;

test('ordered Program operations add, move and rename lanes in an item timeline',async t=>{
 const f=await programShow(t);
 const r=await composeProgramEditsCopy({source:f.file,destination:f.destination,sha256:f.sha256,operations:[
  {action:'add_timeline_audio_lane',index:0,laneName:'Pad',follow:false},
  {action:'move_timeline_audio_lane',index:0,audioIndex:3,laneName:'Pad',toIndex:1},
  {action:'add_timeline_audio_clip',index:0,audioIndex:1,clip:{...clip,name:'Pad take'}},
  {action:'rename_timeline_audio_lane',index:0,audioIndex:3,laneName:'Click',newName:'Metronome'},
 ]});
 const padClip=clipXml.replace('Vox take','Pad take');
 // Hand-built: the added lane is appended after Click, then moves into slot 1; whitespace slots stay.
 const expected=`<sktimeline version="1" name="Doors timeline"><layers><layer name="L"/></layers>${laneA}\n <audio name="Pad" follow="0">${padClip}</audio>\n ${laneV}<audio name="Metronome" follow="0"/></sktimeline>`;
 assert.equal(await programText(f.destination),programXml(expected));
 assert.deepEqual(r.audioOperations.slice(1).map(({operationIndex,action,audioIndex,fromIndex,laneName,previousName,indexMap})=>({operationIndex,action,audioIndex,fromIndex,laneName,previousName,indexMap})),[
  {operationIndex:1,action:'move_timeline_audio_lane',audioIndex:1,fromIndex:3,laneName:'Pad',previousName:undefined,indexMap:[{from:1,to:2},{from:2,to:3},{from:3,to:1}]},
  {operationIndex:2,action:'add_timeline_audio_clip',audioIndex:1,fromIndex:undefined,laneName:undefined,previousName:undefined,indexMap:undefined},
  {operationIndex:3,action:'rename_timeline_audio_lane',audioIndex:3,fromIndex:undefined,laneName:'Metronome',previousName:'Click',indexMap:undefined},
 ]);
 const inspected=await inspectProgramTimeline({file:f.destination,sha256:r.sha256,index:0});
 assert.deepEqual(inspected.audioClips.map(c=>[c.audioIndex,c.clipIndex,c.attributes.name]),[[1,0,'Pad take'],[2,0,'Vox take']]);
 assert.equal(r.validation.diagnostics.filter(d=>d.severity==='error').length,0);
 assert.equal(await readFile(f.file,'utf8'),f.xml);
});

test('Program lane operations check the whole staged Program and the other show parts',async t=>{
 for(const [setup,operation,pattern] of [
  [{program:programXml(itemTimeline,'Click')},{action:'rename_timeline_audio_lane',index:0,audioIndex:2,laneName:'Click',newName:'Metronome'},/"Click" appears literally in content\/Program\.skpr/],
  [{program:programXml(itemTimeline,'Metronome')},{action:'rename_timeline_audio_lane',index:0,audioIndex:2,laneName:'Click',newName:'Metronome'},/"Metronome" appears literally in content\/Program\.skpr/],
  [{extra:[['content/Cue.sktl','<sktimeline version="1" name="C"><cue id="c" layer="0" startMs="0" lenMs="1" label="Metronome"/></sktimeline>']]},{action:'rename_timeline_audio_lane',index:0,audioIndex:2,laneName:'Click',newName:'Metronome'},/appears literally in content\/Cue\.sktl/],
  [{program:programXml(itemTimeline).replace('notes="Main act"/>','notes="Main act"><graph><node id="n9" type="trigger"><settings><setting key="audio.lane">1</setting></settings></node></graph></item>')},{action:'move_timeline_audio_lane',index:0,audioIndex:1,laneName:'Vox',toIndex:2},/content\/Program\.skpr has key="audio\.lane"/],
  [{extra:[['TIMELINE/Transitions.sktr','<t><x key="lane.order"/></t>']]},{action:'move_timeline_audio_lane',index:0,audioIndex:1,laneName:'Vox',toIndex:2},/Transitions\.sktr has key="lane\.order"/],
  [{},{action:'move_timeline_audio_lane',index:0,audioIndex:1,laneName:'Vox',toIndex:0},/first position/],
  [{},{action:'move_timeline_audio_lane',index:1,audioIndex:1,laneName:'Vox',toIndex:2},/timeline/i],
  [{},{action:'rename_timeline_audio_lane',index:0,audioIndex:1,laneName:'Vox',newName:'Lead',extra:true},/Unsupported edit composition input/],
 ]){
  const f=await programShow(t,setup);
  await assert.rejects(composeProgramEditsCopy({source:f.file,destination:f.destination,sha256:f.sha256,operations:[operation]}),pattern);
  await assert.rejects(access(f.destination));assert.deepEqual((await readdir(f.dir)).sort(),['in.skshow']);
 }
});

test('full-show composition passes track lane operations and Program lane operations through',async t=>{
 const f=await programShow(t,{extra:[['content/A.sktl',THREE]]});
 const r=await composeFullShowCopy({source:f.file,destination:f.destination,sha256:f.sha256,
  tracks:[{existingPartName:'content/A.sktl',audioLaneOperations:[{operation:'move',audioIndex:2,laneName:'Click',toIndex:1}]}],
  program:{operations:[{action:'rename_timeline_audio_lane',index:0,audioIndex:1,laneName:'Vox',newName:'Lead'}]}});
 const snapshot=await readShowSnapshot({file:f.destination});
 assert.equal(readSnapshotPart({snapshot,name:'content/A.sktl'}).text,`${head}${laneA}${laneC}${laneV}</sktimeline>`);
 assert.equal(readSnapshotPart({snapshot,name:'content/Program.skpr'}).text,programXml(itemTimeline.replace('<audio name="Vox"','<audio name="Lead"')));
 assert.deepEqual(r.tracks[0].audioLaneOperations.map(o=>o.operation),['move']);
 assert.deepEqual(r.program.audioOperations.map(o=>[o.action,o.previousName,o.laneName]),[['rename_timeline_audio_lane','Vox','Lead']]);
});

test('session composition moves and renames lanes and regenerates the TIMELINE extraction',async t=>{
 const dir=await tempDir(t),root=path.join(dir,'Session A');
 await mkdir(path.join(root,'MEDIA'),{recursive:true});await mkdir(path.join(root,'TIMELINE'));
 const timeline=THREE.replace('file="/music/vox.wav"','file="/orig/vox.wav"');
 const show=`<skshow>${part('media.map','/orig/vox.wav\tMEDIA/vox.wav\n')}${part('content/A.sktl',timeline)}</skshow>`;
 await writeFile(path.join(root,'session.skshow'),show);await writeFile(path.join(root,'TIMELINE','A.sktl'),timeline);await writeFile(path.join(root,'MEDIA','vox.wav'),'RIFF-v');
 const destination=path.join(dir,'Session B');
 const r=await composeSessionMediaCopy({source:root,destination,sha256:sha(show),tracks:[{existingPartName:'content/A.sktl',audioLaneOperations:[{operation:'move',audioIndex:1,laneName:'Vox',toIndex:2},{operation:'rename',audioIndex:1,laneName:'Click',newName:'Count-in'}]}]});
 const out=(await readShowPart({file:r.sessionFile,name:'content/A.sktl'})).text;
 assert.equal(out,timeline.replace(laneV.replace('/music/','/orig/')+laneC,'<audio name="Count-in" follow="0"/>'+laneV.replace('/music/','/orig/')));
 assert.deepEqual(r.workingFiles.entries.map(e=>[e.path,e.action]),[['TIMELINE/A.sktl','regenerated']]);
 assert.equal(await readFile(path.join(destination,'TIMELINE','A.sktl'),'utf8'),out);
 assert.equal((await readShowPart({file:r.sessionFile,name:'media.map'})).text,'/orig/vox.wav\tMEDIA/vox.wav\n');
 assert.deepEqual(r.tracks[0].audioLaneOperations.map(o=>[o.operation,o.audioIndex]),[['move',2],['rename',1]]);
 assert.equal(r.validation.diagnostics.filter(d=>d.severity==='error').length,0);
});
