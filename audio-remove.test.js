import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,access,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {removeTimelineAudioClipCopy,removeTimelineAudioLaneCopy,editTimelineAudioClipCopy,parseTimeline,inspectShowTimeline} from './timeline.js';
import {composeShowCopy} from './compose-show.js';
import {composeSessionMediaCopy} from './session-media-copy.js';
import {inspectSessionMedia} from './session-media.js';
import {inspectShowMedia} from './media-inventory.js';
import {readShowPart,readShowSnapshot} from './xml-copy.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const fields='pps="315" offsetMs="0" trimStartMs="0" trimEndMs="1000" fadeInMs="0" fadeOutMs="0"';
const clipA=`<clip name="A" file="/m/a.wav" wave="w-a" grid="" ${fields} extra="keep"/>`;
const clipB=`<clip name="B" file="/m/b.wav" wave="" grid="" ${fields}/>`;
const clipC=`<clip name="C" file="/m/c.wav" wave="" grid="" ${fields}/>`;
const laneMain=`<audio name="Main" follow="1">${clipA}\n${clipB}</audio>`,laneSong=`<audio name="Song" follow="0">${clipC}</audio>`,laneSpare='<audio name="Spare" follow="0"/>';
// Lane "Song" shares the track name; track, lane and clip names are definitions, not references.
const xml=`<sktimeline version="1" name="Song"><!-- keep --><layers><layer name="L"/></layers>${laneMain}${laneSong}${laneSpare}<deck/></sktimeline>`;
const newClip={name:'N',file:'/m/n.wav',wave:'',grid:'',pps:'315',offsetMs:'0',trimStartMs:'0',trimEndMs:'500',fadeInMs:'0',fadeOutMs:'0'};

async function scratch(t){const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-audio-remove-')));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function timelineFile(t,text=xml){const dir=await scratch(t),source=path.join(dir,'source.sktl');await writeFile(source,text);return {dir,source,sha256:sha(text)};}
async function showFile(t,parts){const dir=await scratch(t),source=path.join(dir,'in.skshow'),text=`<skshow>${parts.map(([n,v])=>part(n,v)).join('')}</skshow>`;await writeFile(source,text);return {dir,source,sha256:sha(text),text};}
const temps=async dir=>(await readdir(dir)).filter(n=>n.startsWith('.showkontrol'));
const names=text=>parseTimeline(text).audioClips.map(c=>[c.audioIndex,c.attributes.name]);

test('removes one clip and keeps every other byte, without overwriting',async t=>{
 const f=await timelineFile(t),destination=path.join(f.dir,'out.sktl');
 const r=await removeTimelineAudioClipCopy({source:f.source,destination,format:'sktl',sha256:f.sha256,audioIndex:0,clipIndex:0});
 const out=await readFile(destination,'utf8');
 assert.equal(out,xml.replace(clipA,''));
 assert.equal(r.removed.extra,'keep');assert.equal(r.removed.file,'/m/a.wav');assert.equal(r.remainingClips,1);assert.equal(r.sha256,sha(out));
 assert.deepEqual(names(out),[[0,'B'],[1,'C']]);
 assert.equal(await readFile(f.source,'utf8'),xml);
 await assert.rejects(removeTimelineAudioClipCopy({source:f.source,destination,format:'sktl',sha256:f.sha256,audioIndex:0,clipIndex:1}));
 assert.equal(await readFile(destination,'utf8'),out);
 const id=await timelineFile(t,xml.replace('name="B"','name="B" id="c1"'));
 for(const [args,pattern] of [[{sha256:'0'.repeat(64)},/changed/],[{clipIndex:2},/outside/],[{audioIndex:2,clipIndex:0},/outside/],[{clipIndex:-1},/non-negative/],[{format:'xml'},/Format/],[{source:id.source,sha256:id.sha256,clipIndex:1},/id attribute/]]){
  const target=path.join(f.dir,`failed-${Math.random()}.sktl`);
  await assert.rejects(removeTimelineAudioClipCopy({source:f.source,destination:target,format:'sktl',sha256:f.sha256,audioIndex:0,clipIndex:0,...args}),pattern);
  await assert.rejects(access(target));
 }
});

test('removes empty lanes, and lanes with clips only when asked',async t=>{
 const f=await timelineFile(t),out=n=>path.join(f.dir,`${n}.sktl`);
 const empty=await removeTimelineAudioLaneCopy({source:f.source,destination:out('spare'),format:'sktl',sha256:f.sha256,audioIndex:2});
 assert.equal(await readFile(out('spare'),'utf8'),xml.replace(laneSpare,''));
 assert.deepEqual(empty.removed,{name:'Spare',follow:'0'});assert.deepEqual(empty.removedClips,[]);
 await assert.rejects(removeTimelineAudioLaneCopy({source:f.source,destination:out('main-refused'),format:'sktl',sha256:f.sha256,audioIndex:0}),/removeClips/);
 await assert.rejects(access(out('main-refused')));
 const main=await removeTimelineAudioLaneCopy({source:f.source,destination:out('main'),format:'sktl',sha256:f.sha256,audioIndex:0,removeClips:true});
 const text=await readFile(out('main'),'utf8');
 assert.equal(text,xml.replace(laneMain,''));
 assert.deepEqual(main.removedClips.map(c=>c.name),['A','B']);
 assert.deepEqual(parseTimeline(text).audio.map(a=>a.name),['Song','Spare']);assert.deepEqual(names(text),[[0,'C']]);
 // The lane named like the track is not blocked by the track name.
 await removeTimelineAudioLaneCopy({source:f.source,destination:out('song'),format:'sktl',sha256:f.sha256,audioIndex:1,removeClips:true});
 assert.equal(await readFile(out('song'),'utf8'),xml.replace(laneSong,''));
 assert.equal(await readFile(f.source,'utf8'),xml);
 for(const [text,options,pattern] of [
  [xml.replace(laneSpare,'<audio name="Spare"><fx/></audio>'),{removeClips:true},/unsupported content/],
  [xml.replace(laneSpare,'<audio name="Spare">text</audio>'),{removeClips:true},/unsupported text/],
  [xml.replace(laneSpare,'<audio name="Spare" id="l1"/>'),{},/id attribute/],
  [xml.replace('<deck/>','<deck/><cue id="q"><graph><node id="n"><settings><setting key="lane">Spare</setting></settings></node></graph></cue>'),{},/appears literally/],
  [xml.replace('<deck/>','<deck target="Spare"/>'),{},/appears literally/],
  [xml,{removeClips:'yes'},/boolean/],
 ]){
  const g=await timelineFile(t,text),target=path.join(g.dir,'out.sktl');
  await assert.rejects(removeTimelineAudioLaneCopy({source:g.source,destination:target,format:'sktl',sha256:g.sha256,audioIndex:2,...options}),pattern);
  await assert.rejects(access(target));
 }
});

test('lane name references are checked across show parts, but other lane names are not references',async t=>{
 const a='<sktimeline version="1" name="A"><audio name="Audio" follow="0"/><deck/></sktimeline>',b='<sktimeline version="1" name="B"><audio name="Audio" follow="0"/><deck/></sktimeline>';
 const f=await showFile(t,[['content/A.sktl',a],['content/B.sktl',b],['blob.bin','\u0000opaque']]),destination=path.join(f.dir,'out.skshow');
 await removeTimelineAudioLaneCopy({source:f.source,destination,format:'skshow',sha256:f.sha256,name:'content/A.sktl',audioIndex:0});
 assert.equal((await inspectShowTimeline({file:destination,name:'content/A.sktl'})).audio.length,0);
 assert.equal((await readShowPart({file:destination,name:'content/B.sktl'})).text,b);
 assert.ok((await readShowSnapshot({file:destination})).parts.every(p=>p.valid));
 const g=await showFile(t,[['content/A.sktl',a],['content/Program.skpr','<skprogram><item><setting key="lane">Audio</setting></item></skprogram>']]),target=path.join(g.dir,'out.skshow');
 await assert.rejects(removeTimelineAudioLaneCopy({source:g.source,destination:target,format:'skshow',sha256:g.sha256,name:'content/A.sktl',audioIndex:0}),/content\/Program\.skpr/);
 await assert.rejects(access(target));
});

test('changing clip media requires restating a nonempty wave and preserves unknown attributes',async t=>{
 const f=await timelineFile(t),out=n=>path.join(f.dir,`${n}.sktl`),base={source:f.source,format:'sktl',sha256:f.sha256,audioIndex:0,clipIndex:0};
 await assert.rejects(editTimelineAudioClipCopy({...base,destination:out('refused'),attributes:{file:'/m/new.wav'}}),/explicit wave/);
 await assert.rejects(access(out('refused')));
 const r=await editTimelineAudioClipCopy({...base,destination:out('a'),attributes:{file:'/m/new & a.wav',wave:'',name:'A2'}});
 assert.equal(await readFile(out('a'),'utf8'),xml.replace('name="A" file="/m/a.wav" wave="w-a"','name="A2" file="/m/new &amp; a.wav" wave=""'));
 assert.deepEqual(r.previous,{file:'/m/a.wav',wave:'w-a',name:'A'});assert.match(r.note,/not opened/);
 // Clip B has an empty wave and grid, so only the file changes.
 await editTimelineAudioClipCopy({...base,clipIndex:1,destination:out('b'),attributes:{file:'/m/b2.wav'}});
 assert.equal(await readFile(out('b'),'utf8'),xml.replace('file="/m/b.wav"','file="/m/b2.wav"'));
 // Restating the same file needs no wave.
 await editTimelineAudioClipCopy({...base,destination:out('same'),attributes:{file:'/m/a.wav',name:'A3'}});
 assert.equal(await readFile(out('same'),'utf8'),xml.replace('name="A"','name="A3"'));
 await assert.rejects(editTimelineAudioClipCopy({...base,destination:out('ctl'),attributes:{file:'/m/\u0001.wav',wave:''}}),/control characters/);
 await assert.rejects(access(out('ctl')));
});

test('composition edits, removes and adds audio with stable indices and rolls back on failure',async t=>{
 const timeline=xml.replace('<!-- keep -->','');
 const f=await showFile(t,[['content/A.sktl',timeline],['blob.bin','\u0000opaque']]),destination=path.join(f.dir,'out.skshow');
 const r=await composeShowCopy({source:f.source,destination,sha256:f.sha256,existingPartName:'content/A.sktl',
  audioLanes:[{laneName:'New',follow:false}],audioClips:[{laneName:'New',clip:newClip}],
  audioClipEdits:[{audioIndex:0,clipIndex:1,attributes:{file:'/m/b2.wav',name:'B2'}}],
  audioClipRemovals:[{audioIndex:0,clipIndex:0}],audioLaneRemovals:[{audioIndex:1,removeClips:true}]});
 const info=await inspectShowTimeline({file:destination,name:'content/A.sktl'});
 assert.deepEqual(info.audio.map(a=>a.name),['Main','Spare','New']);
 assert.deepEqual(info.audioClips.map(c=>[c.audioIndex,c.attributes.name,c.attributes.file]),[[0,'B2','/m/b2.wav'],[2,'N','/m/n.wav']]);
 assert.deepEqual(r.audioLanes,[{laneName:'New',audioIndex:2}]);
 assert.deepEqual(r.audioClipEdits,[{audioIndex:0,clipIndex:1,attributes:{file:'/m/b2.wav',name:'B2'},previous:{file:'/m/b.wav',name:'B'}}]);
 assert.equal(r.audioRemovals.clips[0].attributes.name,'A');
 assert.deepEqual(r.audioRemovals.lanes.map(l=>[l.audioIndex,l.attributes.name,l.clips.map(c=>c.name)]),[[1,'Song',['C']]]);
 assert.equal((await readShowPart({file:destination,name:'blob.bin'})).text,'\u0000opaque');
 assert.equal(await readFile(f.source,'utf8'),f.text);
 // Removals are given in request order and applied from the end, so both select the original clips.
 const both=path.join(f.dir,'both.skshow');
 const two=await composeShowCopy({source:f.source,destination:both,sha256:f.sha256,existingPartName:'content/A.sktl',audioClipRemovals:[{audioIndex:0,clipIndex:0},{audioIndex:0,clipIndex:1}]});
 assert.deepEqual(two.audioRemovals.clips.map(c=>c.attributes.name),['A','B']);
 assert.deepEqual((await inspectShowTimeline({file:both,name:'content/A.sktl'})).audioClips.map(c=>c.attributes.name),['C']);
 for(const [changes,pattern] of [
  [{audioClipEdits:[{audioIndex:0,clipIndex:0,attributes:{name:'X'}}],audioClipRemovals:[{audioIndex:0,clipIndex:0}]},/both edited and removed/],
  [{audioClipRemovals:[{audioIndex:1,clipIndex:0}],audioLaneRemovals:[{audioIndex:1,removeClips:true}]},/removed lane/],
  [{audioLaneRemovals:[{audioIndex:2},{audioIndex:2}]},/twice/],
  [{audioClipRemovals:[{audioIndex:0,clipIndex:0},{audioIndex:0,clipIndex:0}]},/twice/],
  [{audioClipRemovals:[{audioIndex:0,clipIndex:2}]},/missing clip/],
  [{audioLaneRemovals:[{audioIndex:3}]},/missing lane/],
  [{audioClips:[{audioIndex:2,clip:newClip}],audioLaneRemovals:[{audioIndex:2}]},/removed lane 2/],
  [{audioClipRemovals:[{audioIndex:0,clipIndex:0,extra:true}]},/removals must be/],
  // Fails in the writer after earlier steps succeeded.
  [{audioClipEdits:[{audioIndex:0,clipIndex:1,attributes:{name:'X'}}],audioLaneRemovals:[{audioIndex:1}]},/removeClips/],
 ]){
  const target=path.join(f.dir,'failed.skshow');
  await assert.rejects(composeShowCopy({source:f.source,destination:target,sha256:f.sha256,existingPartName:'content/A.sktl',...changes}),pattern);
  await assert.rejects(access(target));assert.deepEqual(await temps(f.dir),[]);
 }
 assert.equal(await readFile(f.source,'utf8'),f.text);
});

// A session after an import: two mapped sidecars and a TIMELINE/ extraction of the track.
async function session(t,{map='/orig/a.wav\tMEDIA/a.wav\n/orig/b.wav\tMEDIA/b.wav\n'}={}){
 const dir=await scratch(t),root=path.join(dir,'Session A'),library=path.join(dir,'library');
 await mkdir(path.join(root,'MEDIA'),{recursive:true});await mkdir(path.join(root,'TIMELINE'));await mkdir(library);
 const timeline=`<sktimeline version="1" name="A"><layers><layer name="L"/></layers><audio name="Main" follow="1"><clip name="A" file="/orig/a.wav" wave="" grid="" ${fields}/><clip name="B" file="/orig/b.wav" wave="" grid="" ${fields}/></audio><audio name="Spare" follow="0"/><deck/></sktimeline>`;
 const show=`<skshow>${part('media.map',map)}${part('content/A.sktl',timeline)}</skshow>`;
 await writeFile(path.join(root,'session.skshow'),show);await writeFile(path.join(root,'TIMELINE','A.sktl'),timeline);
 await writeFile(path.join(root,'MEDIA','a.wav'),'RIFF-a');await writeFile(path.join(root,'MEDIA','b.wav'),'RIFF-b');
 const media=path.join(library,'new.wav');await writeFile(media,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(2048,5)]));
 return {dir,root,media,timeline,sha256:sha(show),destination:path.join(dir,'Session B')};
}
async function tree(root){
 const out={};
 for(const entry of await readdir(root,{withFileTypes:true,recursive:true})){const file=path.join(entry.parentPath??entry.path,entry.name);out[path.relative(root,file)]=entry.isFile()?sha(await readFile(file)):'dir';}
 return out;
}

test('session inspection lists lanes and clips with their mapped sidecars',async t=>{
 const s=await session(t),r=await inspectSessionMedia({directory:s.root});
 assert.equal(r.showSha256,s.sha256);
 assert.deepEqual(r.lanes,[{part:'content/A.sktl',audioIndex:0,attributes:{name:'Main',follow:'1'},clipCount:2},{part:'content/A.sktl',audioIndex:1,attributes:{name:'Spare',follow:'0'},clipCount:0}]);
 assert.deepEqual(r.clips.map(c=>[c.audioIndex,c.clipIndex,c.attributes.name,c.mapping]),[[0,0,'A',{line:1,archivePath:'MEDIA/a.wav',sidecar:'regular_file'}],[0,1,'B',{line:2,archivePath:'MEDIA/b.wav',sidecar:'regular_file'}]]);
 // Duplicate source rows are a diagnostic; no row is chosen for the clip.
 const dup=await session(t,{map:'/orig/a.wav\tMEDIA/a.wav\n/orig/a.wav\tMEDIA/b.wav\n'}),d=await inspectSessionMedia({directory:dup.root});
 assert.deepEqual(d.clips.map(c=>c.mapping),[{ambiguousLines:[1,2]},null]);
 assert.ok(d.diagnostics.some(x=>x.code==='duplicate_source'));
});

test('session composition changes clip media, removes a clip and keeps rows and sidecars',async t=>{
 const s=await session(t),before=await tree(s.root);
 const r=await composeSessionMediaCopy({source:s.root,destination:s.destination,sha256:s.sha256,media:[{source:s.media}],
  tracks:[{existingPartName:'content/A.sktl',audioClipEdits:[{audioIndex:0,clipIndex:0,mediaIndex:0,attributes:{name:'A new'}}],audioClipRemovals:[{audioIndex:0,clipIndex:1}],audioLaneRemovals:[{audioIndex:1}]}]});
 assert.deepEqual(await tree(s.root),before);
 const info=await inspectShowTimeline({file:r.sessionFile,name:'content/A.sktl'});
 assert.deepEqual(info.audioClips.map(c=>[c.audioIndex,c.attributes.name,c.attributes.file]),[[0,'A new',s.media]]);
 assert.deepEqual(info.audio.map(a=>a.name),['Main']);
 assert.deepEqual(r.clipLinks,[{trackIndex:0,clipEditIndex:0,file:s.media,mappingLine:3,archivePath:'MEDIA/new.wav',sidecar:'copied'}]);
 assert.deepEqual(r.warnings.map(w=>[w.code,w.line,w.archivePath]),[['mapping_no_longer_referenced',1,'MEDIA/a.wav'],['mapping_no_longer_referenced',2,'MEDIA/b.wav']]);
 assert.deepEqual(r.tracks[0].audioRemovals.clips.map(c=>c.attributes.file),['/orig/b.wav']);
 assert.deepEqual(r.tracks[0].audioClipEdits[0].previous,{name:'A',file:'/orig/a.wav'});
 assert.equal(r.validation.diagnostics.filter(d=>d.severity==='error').length,0);
 // Rows and sidecars of media no clip uses are kept.
 assert.equal((await readShowPart({file:r.sessionFile,name:'media.map'})).text,`/orig/a.wav\tMEDIA/a.wav\n/orig/b.wav\tMEDIA/b.wav\n${s.media}\tMEDIA/new.wav\n`);
 assert.deepEqual((await readdir(path.join(s.destination,'MEDIA'))).sort(),['a.wav','b.wav','new.wav']);
 assert.ok((await readFile(path.join(s.destination,'MEDIA','new.wav'))).equals(await readFile(s.media)));
 // The exact TIMELINE/ extraction is rewritten from the composed part.
 assert.deepEqual(r.workingFiles.entries.map(e=>[e.path,e.action]),[['TIMELINE/A.sktl','regenerated']]);
 assert.equal(await readFile(path.join(s.destination,'TIMELINE','A.sktl'),'utf8'),(await readShowPart({file:r.sessionFile,name:'content/A.sktl'})).text);
 const after=await inspectSessionMedia({directory:s.destination});
 assert.deepEqual(after.clips.map(c=>c.mapping),[{line:3,archivePath:'MEDIA/new.wav',sidecar:'regular_file'}]);
 assert.deepEqual((await inspectShowMedia({file:r.sessionFile})).diagnostics,[]);
});

test('session composition publishes nothing when an audio operation fails',async t=>{
 const s=await session(t),before=await tree(s.root);
 for(const [track,pattern] of [
  [{existingPartName:'content/A.sktl',audioClipEdits:[{audioIndex:0,clipIndex:0,mediaIndex:0,attributes:{name:'x'}}],audioLaneRemovals:[{audioIndex:0}]},/both edited and removed/],
  [{existingPartName:'content/A.sktl',audioClipEdits:[{audioIndex:0,clipIndex:0,mediaIndex:0,attributes:{file:'/x.wav'}}]},/omit file/],
  [{existingPartName:'content/A.sktl',audioClipEdits:[{audioIndex:0,clipIndex:1,mediaIndex:1,attributes:{}}]},/mediaIndex must select/],
  [{existingPartName:'content/A.sktl',audioClipRemovals:[{audioIndex:0,clipIndex:0}],audioLaneRemovals:[{audioIndex:0,removeClips:true}]},/clip 0\/0 is in a removed lane/],
  // Fails in the lane writer after a clip has been added to the other lane.
  [{existingPartName:'content/A.sktl',audioClips:[{audioIndex:1,mediaIndex:0,clip:Object.fromEntries(Object.entries(newClip).filter(([k])=>k!=='file'))}],audioLaneRemovals:[{audioIndex:0}]},/removeClips/],
 ]){
  await assert.rejects(composeSessionMediaCopy({source:s.root,destination:s.destination,sha256:s.sha256,media:[{source:s.media}],tracks:[track]}),pattern);
  await assert.rejects(access(s.destination));assert.deepEqual(await temps(s.dir),[]);
 }
 assert.deepEqual(await tree(s.root),before);
});

test('MCP removes clips and lanes, changes session clip media and rejects unknown fields',async t=>{
 const client=new Client({name:'audio-remove-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});return {error:r.isError===true,text:r.content[0].text,json:r.isError?undefined:JSON.parse(r.content[0].text)};};
 const f=await timelineFile(t);
 const clip=await call('showkontrol_remove_timeline_audio_clip_copy',{source:f.source,destination:path.join(f.dir,'clip.sktl'),format:'sktl',sha256:f.sha256,audioIndex:0,clipIndex:1});
 assert.equal(clip.error,false,clip.text);assert.equal(await readFile(path.join(f.dir,'clip.sktl'),'utf8'),xml.replace(`\n${clipB}`,'\n'));
 const show=await showFile(t,[['content/A.sktl',xml]]);
 const lane=await call('showkontrol_remove_timeline_audio_lane_copy',{source:show.source,destination:path.join(show.dir,'lane.skshow'),format:'skshow',sha256:show.sha256,name:'content/A.sktl',audioIndex:1,removeClips:true});
 assert.equal(lane.error,false,lane.text);assert.deepEqual(lane.json.removedClips.map(c=>c.name),['C']);
 const refused=await call('showkontrol_remove_timeline_audio_lane_copy',{source:show.source,destination:path.join(show.dir,'refused.skshow'),format:'skshow',sha256:show.sha256,name:'content/A.sktl',audioIndex:0});
 assert.equal(refused.error,true);assert.match(refused.text,/removeClips/);await assert.rejects(access(path.join(show.dir,'refused.skshow')));
 const s=await session(t);
 const inspected=await call('showkontrol_inspect_session_media',{directory:s.root});
 assert.equal(inspected.json.clips.length,2);assert.equal(inspected.json.lanes.length,2);
 const strict=await call('showkontrol_compose_session_media_copy',{source:s.root,destination:s.destination,sha256:inspected.json.showSha256,tracks:[{existingPartName:'content/A.sktl',audioClipRemovals:[{audioIndex:0,clipIndex:0,force:true}]}]});
 assert.equal(strict.error,true);await assert.rejects(access(s.destination));
 const composed=await call('showkontrol_compose_session_media_copy',{source:s.root,destination:s.destination,sha256:inspected.json.showSha256,media:[{source:s.media}],tracks:[{existingPartName:'content/A.sktl',audioClipEdits:[{audioIndex:0,clipIndex:1,mediaIndex:0,attributes:{}}],audioClipRemovals:[{audioIndex:0,clipIndex:0}]}]});
 assert.equal(composed.error,false,composed.text);
 assert.deepEqual(composed.json.clipLinks.map(l=>[l.clipEditIndex,l.mappingLine]),[[0,3]]);
 assert.deepEqual(composed.json.warnings.map(w=>[w.code,w.line]),[['mapping_no_longer_referenced',1],['mapping_no_longer_referenced',2]]);
 const result=await inspectSessionMedia({directory:s.destination});
 assert.deepEqual(result.clips.map(c=>[c.attributes.name,c.attributes.file]),[['B',s.media]]);
});
