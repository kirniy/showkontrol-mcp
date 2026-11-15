import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {composeProgramEditsCopy} from './program-edit-compose.js';
import {composeFullShowCopy} from './compose-full-show.js';
import {composeSessionMediaCopy} from './session-media-copy.js';
import {inspectSessionMedia} from './session-media.js';
import {embedProgramTimelineCopy,inspectShowProgram,inspectProgramTimeline} from './program.js';
import {readShowSnapshot,readSnapshotPart,readShowPart} from './xml-copy.js';
import {validateShow} from './validate-show.js';

// Byte-exact R27 27.0.11 app-saved empty track (see audio-lane-deckless.test.js): no deck, one lane directly after layers.
const APP_EMPTY_TRACK='<?xml version="1.0" encoding="UTF-8"?><sktimeline version="1" name="Track 2" fps="25" fpsdef="1" offsetMs="0" smpteMs="0" media="" mediaWave="" mediaGrid="" mediaPps="75" mediaStructS="" mediaStructE="" mediaStructL=""><titles/><layers><layer name="Layer 1"/><layer name="Layer 2"/><layer name="Layer 3"/><layer name="Layer 4"/></layers><audio name="Audio 1" follow="0"/></sktimeline>';
const APP_ROOT=APP_EMPTY_TRACK.slice(APP_EMPTY_TRACK.indexOf('<sktimeline'));
const APP_LANE='<audio name="Audio 1" follow="0"/>';
const sha=value=>createHash('sha256').update(value).digest('hex');
const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const clip={name:'Kick',file:'/music/kick.wav',wave:'',grid:'',pps:'315',offsetMs:'0',trimStartMs:'0',trimEndMs:'1000',fadeInMs:'0',fadeOutMs:'0'};
const clipXml=c=>`<clip name="${c.name}" file="${c.file}" wave="${c.wave}" grid="${c.grid}" pps="${c.pps}" offsetMs="${c.offsetMs}" trimStartMs="${c.trimStartMs}" trimEndMs="${c.trimEndMs}" fadeInMs="${c.fadeInMs}" fadeOutMs="${c.fadeOutMs}"/>`;
const deckTimeline='<sktimeline version="1" name="Main"><layers/><deck/></sktimeline>',patch='<showkontrol version="2" name="Show"><graph/><appSettings/></showkontrol>';
const other='<sktimeline version="1" name="Other"><layers/><audio name="Main" follow="1"/><deck/></sktimeline>';
const programWith=doors=>`<skprogram version="1"><item start="0" name="Doors" notes="">${doors}</item><item start="1000" name="Show" notes="">${other}</item></skprogram>`;

async function tempDir(t,prefix){const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),prefix)));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
// The Doors item timeline is produced by embedding the app-saved file, not written by hand.
async function embeddedAppItem(dir){
 const track=path.join(dir,'empty.sktl'),bare=path.join(dir,'bare.skpr'),embedded=path.join(dir,'embedded.skpr');
 await writeFile(track,APP_EMPTY_TRACK);
 const bareXml=`<skprogram version="1"><item start="0" name="Doors" notes=""/><item start="1000" name="Show" notes="">${other}</item></skprogram>`;await writeFile(bare,bareXml);
 await embedProgramTimelineCopy({source:bare,destination:embedded,sha256:sha(bareXml),index:0,donor:track,donorSha256:sha(APP_EMPTY_TRACK)});
 const xml=await readFile(embedded,'utf8');assert.equal(xml,programWith(APP_ROOT));
 await rm(bare);await rm(embedded);await rm(track);return xml;
}
async function showFile(dir,programXml,name='in.skshow'){
 const xml=`<skshow>${part('content/Main.sktl',deckTimeline)}${part('patch.skf',patch)}${part('content/Program.skpr',programXml)}</skshow>`,file=path.join(dir,name);
 await writeFile(file,xml);return {file,xml,sha256:sha(xml)};
}
const programText=async file=>readSnapshotPart({snapshot:await readShowSnapshot({file}),name:'content/Program.skpr'}).text;

test('Program lane operations append after the last lane of an item holding the app-saved empty track',async t=>{
 const dir=await tempDir(t,'sk-program-deckless-'),show=await showFile(dir,await embeddedAppItem(dir)),destination=path.join(dir,'out.skshow');
 const snare={...clip,name:'Snare',file:'/music/snare.wav'};
 const operations=[
  {action:'add_timeline_audio_lane',index:0,laneName:'Audio 2',follow:true},
  {action:'add_timeline_audio_clip',index:0,audioIndex:1,clip},
  {action:'add_timeline_audio_clip',index:0,audioIndex:0,clip:snare},
  {action:'add_timeline_audio_lane',index:0,laneName:'Audio 3',follow:false},
  // The deck-bearing item in the same call keeps the deck rule.
  {action:'add_timeline_audio_lane',index:1,laneName:'Stems',follow:false}
 ];
 const r=await composeProgramEditsCopy({source:show.file,destination,sha256:show.sha256,operations});
 assert.deepEqual(r.audioOperations.map(o=>[o.action,o.itemIndex,o.audioIndex,o.clipIndex,o.position]),[
  ['add_timeline_audio_lane',0,1,undefined,'after_last_lane'],['add_timeline_audio_clip',0,1,0,undefined],['add_timeline_audio_clip',0,0,0,undefined],['add_timeline_audio_lane',0,2,undefined,'after_last_lane'],['add_timeline_audio_lane',1,1,undefined,'before_deck']]);
 // Exact bytes: lanes appended at the end of the app timeline; the other item gets its lane before the deck.
 const doors=APP_ROOT.replace(APP_LANE,`<audio name="Audio 1" follow="0">${clipXml(snare)}</audio><audio name="Audio 2" follow="1">${clipXml(clip)}</audio><audio name="Audio 3" follow="0"/>`);
 const otherAfter=other.replace('<deck/>','<audio name="Stems" follow="0"/><deck/>');
 assert.equal(await programText(destination),`<skprogram version="1"><item start="0" name="Doors" notes="">${doors}</item><item start="1000" name="Show" notes="">${otherAfter}</item></skprogram>`);
 // Independent read-back.
 const inspected=await inspectProgramTimeline({file:destination,sha256:r.sha256,index:0});
 assert.deepEqual(inspected.audio,[{name:'Audio 1',follow:'0'},{name:'Audio 2',follow:'1'},{name:'Audio 3',follow:'0'}]);
 assert.deepEqual(inspected.audioClips.map(c=>[c.audioIndex,c.clipIndex,c.attributes.name]),[[0,0,'Snare'],[1,0,'Kick']]);
 assert.equal(inspected.layers.length,4);
 assert.deepEqual((await validateShow({file:destination})).diagnostics.filter(d=>d.severity==='error'),[]);
 assert.ok(r.warnings.some(w=>typeof w==='string'&&/deckless timeline, as in the app-saved empty track\. App acceptance and follow behavior are unverified/.test(w)));
 assert.equal((await readShowPart({file:destination,name:'content/Main.sktl'})).text,deckTimeline);
 assert.equal(await readFile(show.file,'utf8'),show.xml);
});

test('a Program item staged from a new track with cues takes a lane before those cues',async t=>{
 const dir=await tempDir(t,'sk-program-deckless-cues-'),template=path.join(dir,'empty.sktl');await writeFile(template,APP_EMPTY_TRACK);
 const sourceXml=`<skshow>${part('content/Main.sktl',deckTimeline)}${part('patch.skf',patch)}</skshow>`,source=path.join(dir,'in.skshow');await writeFile(source,sourceXml);
 const first=path.join(dir,'first.skshow');
 const a=await composeFullShowCopy({source,destination:first,sha256:sha(sourceXml),
  tracks:[{templateDonor:{file:template,format:'sktl',sha256:sha(APP_EMPTY_TRACK)},trackName:'Intro',partName:'content/Intro.sktl',cues:[{layer:0,startMs:0,lengthMs:500,label:'Hit'}]}],
  program:{items:[{start:0,name:'Intro',notes:'',timeline:{stagedShow:{trackIndex:0},remapCueIds:true}}]}});
 assert.match(await programText(first),/<audio name="Audio 1" follow="0"\/><cue [^>]*label="Hit"\/><\/sktimeline><\/item>/);
 const second=path.join(dir,'second.skshow');
 const b=await composeProgramEditsCopy({source:first,destination:second,sha256:a.sha256,operations:[
  {action:'add_timeline_audio_lane',index:0,laneName:'Audio 2',follow:true},
  {action:'add_timeline_audio_clip',index:0,audioIndex:1,clip}
 ]});
 assert.deepEqual(b.audioOperations.map(o=>[o.action,o.audioIndex,o.position]),[['add_timeline_audio_lane',1,'after_last_lane'],['add_timeline_audio_clip',1,undefined]]);
 assert.match(await programText(second),/<audio name="Audio 1" follow="0"\/><audio name="Audio 2" follow="1"><clip name="Kick" [^>]*\/><\/audio><cue [^>]*label="Hit"\/><\/sktimeline><\/item>/);
 assert.deepEqual(b.validation?.diagnostics?.filter(d=>d.severity==='error')??[],[]);
});

test('removing and re-adding the app lane in a Program item restores the embedded bytes',async t=>{
 const dir=await tempDir(t,'sk-program-deckless-roundtrip-'),programXml=await embeddedAppItem(dir),show=await showFile(dir,programXml),destination=path.join(dir,'out.skshow');
 const r=await composeProgramEditsCopy({source:show.file,destination,sha256:show.sha256,operations:[
  {action:'remove_timeline_audio_lane',index:0,audioIndex:0},
  {action:'add_timeline_audio_lane',index:0,laneName:'Audio 1',follow:false}
 ]});
 assert.deepEqual(r.audioOperations.map(o=>[o.action,o.audioIndex,o.position]),[['remove_timeline_audio_lane',0,undefined],['add_timeline_audio_lane',0,'after_layers']]);
 assert.equal(await programText(destination),programXml);
});

test('unobserved deckless Program item layouts are rejected and publish nothing',async t=>{
 const dir=await tempDir(t,'sk-program-deckless-reject-'),appProgram=await embeddedAppItem(dir);
 const cases=[
  ['lane after a cue',programWith(APP_ROOT.replace(APP_LANE,APP_LANE+'<cue id="c1" layer="0" startMs="0" lenMs="100" label="Go"/><audio name="Late" follow="0"/>')),[{action:'add_timeline_audio_lane',index:0,laneName:'New',follow:false}],/directly after layers, followed by nothing but direct cues/],
  ['element between layers and lane',programWith(APP_ROOT.replace(APP_LANE,'<titles/>'+APP_LANE)),[{action:'add_timeline_audio_lane',index:0,laneName:'New',follow:false}],/directly after layers, followed by nothing but direct cues/],
  ['two layers',programWith(APP_ROOT.replace('<titles/>','<layers/>')),[{action:'add_timeline_audio_lane',index:0,laneName:'New',follow:false}],/exactly one direct layers/],
  ['duplicate app lane name',appProgram,[{action:'add_timeline_audio_lane',index:0,laneName:'Audio 1',follow:true}],/already exists/],
  // A valid deckless addition before a failing one leaves nothing behind.
  ['later failure',appProgram,[{action:'add_timeline_audio_lane',index:0,laneName:'Audio 2',follow:true},{action:'add_timeline_audio_clip',index:0,audioIndex:2,clip}],/Audio lane does not exist/]
 ];
 for(const [label,programXml,operations,error] of cases){
  const sub=path.join(dir,label.replaceAll(' ','-'));await mkdir(sub);
  const show=await showFile(sub,programXml),destination=path.join(sub,'out.skshow');
  await assert.rejects(composeProgramEditsCopy({source:show.file,destination,sha256:show.sha256,operations}),error,label);
  assert.deepEqual(await readdir(sub),['in.skshow'],label);assert.equal(await readFile(show.file,'utf8'),show.xml,label);
 }
});

test('a new deckless track staged into a Program item takes Program lane operations in a later composition',async t=>{
 const dir=await tempDir(t,'sk-program-deckless-staged-'),template=path.join(dir,'empty.sktl');await writeFile(template,APP_EMPTY_TRACK);
 const sourceXml=`<skshow>${part('content/Main.sktl',deckTimeline)}${part('patch.skf',patch)}</skshow>`,source=path.join(dir,'in.skshow');await writeFile(source,sourceXml);
 const first=path.join(dir,'first.skshow');
 const a=await composeFullShowCopy({source,destination:first,sha256:sha(sourceXml),
  tracks:[{templateDonor:{file:template,format:'sktl',sha256:sha(APP_EMPTY_TRACK)},trackName:'Drums',partName:'content/Drums.sktl',audioLanes:[{laneName:'Audio 2',follow:true}],audioClips:[{laneName:'Audio 2',clip}]}],
  program:{items:[{start:0,name:'Drums',notes:'',timeline:{stagedShow:{trackIndex:0}}}]}});
 const drums=(await readShowPart({file:first,name:'content/Drums.sktl'})).text;
 assert.deepEqual(a.tracks[0].audioLanes,[{laneName:'Audio 2',audioIndex:1}]);
 // The staged item timeline is the composed deckless track.
 const program=await inspectShowProgram({file:first});
 const staged=await inspectProgramTimeline({file:first,sha256:program.sha256,index:0});
 assert.deepEqual(staged.audio,[{name:'Audio 1',follow:'0'},{name:'Audio 2',follow:'1'}]);
 assert.ok(!(await programText(first)).includes('<deck'));
 const second=path.join(dir,'second.skshow');
 const b=await composeFullShowCopy({source:first,destination:second,sha256:a.sha256,program:{operations:[
  {action:'add_timeline_audio_lane',index:0,laneName:'Audio 3',follow:false},
  {action:'add_timeline_audio_clip',index:0,audioIndex:2,clip:{...clip,name:'Hat',file:'/music/hat.wav'}}
 ]}});
 assert.deepEqual(b.program.audioOperations.map(o=>[o.action,o.audioIndex,o.clipIndex,o.position]),[['add_timeline_audio_lane',2,undefined,'after_last_lane'],['add_timeline_audio_clip',2,0,undefined]]);
 const after=await inspectProgramTimeline({file:second,sha256:b.sha256,index:0});
 assert.deepEqual(after.audio.map(l=>l.name),['Audio 1','Audio 2','Audio 3']);
 assert.deepEqual(after.audioClips.map(c=>[c.audioIndex,c.clipIndex,c.attributes.name]),[[1,0,'Kick'],[2,0,'Hat']]);
 assert.match(await programText(second),/<audio name="Audio 2" follow="1"><clip [^>]*\/><\/audio><audio name="Audio 3" follow="0"><clip name="Hat" [^>]*\/><\/audio><\/sktimeline><\/item>/);
 // The track part is a separate copy and is not changed by Program operations.
 assert.equal((await readShowPart({file:second,name:'content/Drums.sktl'})).text,drums);
 assert.deepEqual(b.validation.diagnostics.filter(d=>d.severity==='error'),[]);
});

test('a session composition adds a lane and a mediaIndex clip to a deckless Program item',async t=>{
 const dir=await tempDir(t,'sk-program-deckless-session-'),session=path.join(dir,'Session A'),library=path.join(dir,'library');
 const programXml=await embeddedAppItem(dir);
 await mkdir(path.join(session,'MEDIA'),{recursive:true});await mkdir(library);
 const show=`<skshow>${part('content/Main.sktl',deckTimeline)}${part('patch.skf',patch)}${part('content/Program.skpr',programXml)}</skshow>`;await writeFile(path.join(session,'session.skshow'),show);
 const media=path.join(library,'Kick.wav');await writeFile(media,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(1024,3)]));
 const {file:_,...clipFields}=clip,destination=path.join(dir,'Session B');
 const r=await composeSessionMediaCopy({source:session,destination,sha256:sha(show),media:[{source:media}],program:{operations:[
  {action:'add_timeline_audio_lane',index:0,laneName:'Audio 2',follow:false},
  {action:'add_timeline_audio_clip',index:0,audioIndex:1,mediaIndex:0,clip:clipFields}
 ]}});
 assert.deepEqual(r.program.audioOperations.map(o=>[o.action,o.audioIndex,o.position]),[['add_timeline_audio_lane',1,'after_last_lane'],['add_timeline_audio_clip',1,undefined]]);
 assert.deepEqual(r.programClipLinks,[{itemIndex:0,audioIndex:1,clipIndex:0,file:media,mappingLine:1,archivePath:'MEDIA/Kick.wav',sidecar:'copied'}]);
 assert.deepEqual(r.validation.diagnostics.filter(d=>d.severity==='error'),[]);assert.equal(r.validation.file,r.sessionFile);
 // Independent read of the published session.
 const inventory=await inspectSessionMedia({directory:destination});
 assert.deepEqual(inventory.lanes.filter(l=>l.part==='content/Program.skpr').map(l=>[l.itemIndex,l.audioIndex,l.attributes.name,l.clipCount]),[[0,0,'Audio 1',0],[0,1,'Audio 2',1],[1,0,'Main',0]]);
 assert.deepEqual(inventory.clips.filter(c=>c.part==='content/Program.skpr').map(c=>[c.itemIndex,c.audioIndex,c.clipIndex,c.attributes.file,c.mapping]),[[0,1,0,media,{line:1,archivePath:'MEDIA/Kick.wav',sidecar:'regular_file'}]]);
 assert.ok((await readFile(path.join(destination,'MEDIA','Kick.wav'))).equals(await readFile(media)));
 assert.equal(await readFile(path.join(session,'session.skshow'),'utf8'),show);
});

test('MCP Program edits report the deckless lane position and describe both layout rules',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const dir=await tempDir(t,'sk-program-deckless-mcp-'),show=await showFile(dir,await embeddedAppItem(dir)),destination=path.join(dir,'out.skshow');
 const client=new Client({name:'program-deckless-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const {tools}=await client.listTools(),lane=tools.find(x=>x.name==='showkontrol_compose_program_edits_copy').inputSchema.properties.operations.items.oneOf.find(o=>o.properties.action.const==='add_timeline_audio_lane');
 assert.match(lane.description,/before the item timeline's unique deck element, or, without a deck, after the last lane/);
 const r=await client.callTool({name:'showkontrol_compose_program_edits_copy',arguments:{source:show.file,destination,sha256:show.sha256,operations:[{action:'add_timeline_audio_lane',index:0,laneName:'Audio 2',follow:true}]}});
 assert.equal(r.isError,undefined,JSON.stringify(r));
 assert.deepEqual(JSON.parse(r.content[0].text).audioOperations.map(o=>[o.audioIndex,o.position]),[[1,'after_last_lane']]);
 const bad=await client.callTool({name:'showkontrol_compose_program_edits_copy',arguments:{source:show.file,destination:path.join(dir,'bad.skshow'),sha256:show.sha256,operations:[{action:'add_timeline_audio_lane',index:0,laneName:'Audio 1',follow:true}]}});
 assert.equal(bad.isError,true);assert.match(bad.content[0].text,/already exists/);
 assert.deepEqual((await readdir(dir)).sort(),['in.skshow','out.skshow']);
});
