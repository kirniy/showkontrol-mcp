import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,access,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {addTimelineAudioLaneCopy,addTimelineCueCopy,removeTimelineAudioLaneCopy,parseTimeline,inspectShowTimeline} from './timeline.js';
import {composeShowCopy} from './compose-show.js';
import {composeMultiTrackShowCopy} from './compose-multi-show.js';
import {composeSessionMediaCopy} from './session-media-copy.js';
import {inspectSessionMedia} from './session-media.js';
import {readShowPart} from './xml-copy.js';

// Byte-exact R27 27.0.11 app-saved empty track: no deck, one lane directly after layers, no trailing newline.
const APP_EMPTY_TRACK='<?xml version="1.0" encoding="UTF-8"?><sktimeline version="1" name="Track 2" fps="25" fpsdef="1" offsetMs="0" smpteMs="0" media="" mediaWave="" mediaGrid="" mediaPps="75" mediaStructS="" mediaStructE="" mediaStructL=""><titles/><layers><layer name="Layer 1"/><layer name="Layer 2"/><layer name="Layer 3"/><layer name="Layer 4"/></layers><audio name="Audio 1" follow="0"/></sktimeline>';
const sha=value=>createHash('sha256').update(value).digest('hex');
const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const clip={name:'Kick',file:'/music/kick.wav',wave:'',grid:'',pps:'315',offsetMs:'0',trimStartMs:'0',trimEndMs:'1000',fadeInMs:'0',fadeOutMs:'0'};
const deckTimeline='<sktimeline version="1" name="Main"><layers/><deck/></sktimeline>',patch='<showkontrol version="2" name="Show"><graph/><appSettings/></showkontrol>';

async function tempDir(t,prefix){const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),prefix)));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function timelineFile(dir,xml,name='source.sktl'){const file=path.join(dir,name);await writeFile(file,xml);return {file,sha256:sha(xml)};}
async function showFile(dir,parts,name='in.skshow'){const xml=`<skshow>${[...parts,['patch.skf',patch]].map(([n,v])=>part(n,v)).join('')}</skshow>`,file=path.join(dir,name);await writeFile(file,xml);return {file,xml,sha256:sha(xml)};}
async function assertNoOutput(dir,destination){await assert.rejects(access(destination));assert.deepEqual((await readdir(dir)).filter(n=>n.startsWith('.showkontrol')),[]);}

test('the embedded fixture is the app-saved empty track',()=>{
 assert.equal(sha(APP_EMPTY_TRACK),'8c61339015f5f5a339791639fbb384c68eb32e9e24f1b7d7685c8b7f2baf9065');
 const parsed=parseTimeline(APP_EMPTY_TRACK);
 assert.deepEqual(parsed.audio,[{name:'Audio 1',follow:'0'}]);assert.equal(parsed.layers.length,4);assert.ok(!APP_EMPTY_TRACK.includes('<deck'));
});

test('appends a lane after the existing lane of the deckless app-saved empty track',async t=>{
 const dir=await tempDir(t,'sk-deckless-add-'),{file:source,sha256}=await timelineFile(dir,APP_EMPTY_TRACK),destination=path.join(dir,'out.sktl');
 const r=await addTimelineAudioLaneCopy({source,destination,format:'sktl',sha256,laneName:'Audio 2',follow:true});
 assert.equal(r.audioIndex,1);assert.equal(r.position,'after_last_lane');
 const out=await readFile(destination,'utf8');
 assert.equal(out,APP_EMPTY_TRACK.replace('<audio name="Audio 1" follow="0"/>','<audio name="Audio 1" follow="0"/><audio name="Audio 2" follow="1"/>'));
 assert.deepEqual(parseTimeline(out).audio,[{name:'Audio 1',follow:'0'},{name:'Audio 2',follow:'1'}]);
 const third=path.join(dir,'third.sktl'),t3=await addTimelineAudioLaneCopy({source:destination,destination:third,format:'sktl',sha256:sha(out),laneName:'Audio 3',follow:false});
 assert.equal(t3.audioIndex,2);assert.match(await readFile(third,'utf8'),/<\/layers><audio name="Audio 1" follow="0"\/><audio name="Audio 2" follow="1"\/><audio name="Audio 3" follow="0"\/><\/sktimeline>$/);
 assert.equal(await readFile(source,'utf8'),APP_EMPTY_TRACK);
 await assert.rejects(addTimelineAudioLaneCopy({source,destination:path.join(dir,'dup.sktl'),format:'sktl',sha256,laneName:'Audio 1',follow:false}),/already exists/);
 await assert.rejects(access(path.join(dir,'dup.sktl')));
});

test('a removed app lane can be added back after layers to the same bytes',async t=>{
 const dir=await tempDir(t,'sk-deckless-roundtrip-'),{file:source,sha256}=await timelineFile(dir,APP_EMPTY_TRACK),bare=path.join(dir,'bare.sktl'),again=path.join(dir,'again.sktl');
 await removeTimelineAudioLaneCopy({source,destination:bare,format:'sktl',sha256,audioIndex:0});
 const bareXml=await readFile(bare,'utf8');assert.equal(parseTimeline(bareXml).audio.length,0);
 const r=await addTimelineAudioLaneCopy({source:bare,destination:again,format:'sktl',sha256:sha(bareXml),laneName:'Audio 1',follow:false});
 assert.equal(r.position,'after_layers');assert.equal(r.audioIndex,0);assert.equal(await readFile(again,'utf8'),APP_EMPTY_TRACK);
});

test('keeps the deck rule and rejects unobserved deckless layouts without writing',async t=>{
 const dir=await tempDir(t,'sk-deckless-reject-');
 const deck=await timelineFile(dir,'<sktimeline version="1"><layers/>\n <audio name="A" follow="0"/>\n <deck/><cue id="c"/></sktimeline>','deck.sktl');
 const ok=await addTimelineAudioLaneCopy({source:deck.file,destination:path.join(dir,'deck-out.sktl'),format:'sktl',sha256:deck.sha256,laneName:'B',follow:false});
 assert.equal(ok.position,'before_deck');assert.match(await readFile(path.join(dir,'deck-out.sktl'),'utf8'),/<audio name="B" follow="0"\/><deck\/><cue id="c"\/>/);
 // A pretty-printed deckless timeline keeps its whitespace; the lane goes directly after the last lane.
 const pretty=await timelineFile(dir,'<sktimeline version="1">\n <layers>\n  <layer name="L"/>\n </layers>\n <audio name="A" follow="0"/>\n</sktimeline>\n','pretty.sktl');
 const p=await addTimelineAudioLaneCopy({source:pretty.file,destination:path.join(dir,'pretty-out.sktl'),format:'sktl',sha256:pretty.sha256,laneName:'B',follow:true});
 assert.equal(p.position,'after_last_lane');assert.equal(await readFile(path.join(dir,'pretty-out.sktl'),'utf8'),'<sktimeline version="1">\n <layers>\n  <layer name="L"/>\n </layers>\n <audio name="A" follow="0"/><audio name="B" follow="1"/>\n</sktimeline>\n');
 const cases=[
  ['lane after deck','<sktimeline version="1"><layers/><deck/><audio name="A"/></sktimeline>',/Audio lane order is unsupported/],
  ['two decks','<sktimeline version="1"><layers/><deck/><deck/></sktimeline>',/at most one direct deck/],
  ['lane after a cue','<sktimeline version="1"><layers/><audio name="A"/><cue id="c"/><audio name="B"/></sktimeline>',/directly after layers, followed by nothing but direct cues/],
  ['element after a cue','<sktimeline version="1"><layers/><audio name="A"/><cue id="c"/><titles/></sktimeline>',/directly after layers, followed by nothing but direct cues/],
  ['comment between lane and cue','<sktimeline version="1"><layers/><audio name="A"/><!-- x --><cue id="c"/></sktimeline>',/only whitespace/],
  ['lane before layers','<sktimeline version="1"><audio name="A"/><layers/></sktimeline>',/directly after layers, followed by nothing but direct cues/],
  ['lane before layers and cue after','<sktimeline version="1"><audio name="A"/><layers/><cue id="c"/></sktimeline>',/directly after layers, followed by nothing but direct cues/],
  ['element between layers and lane','<sktimeline version="1"><layers/><titles/><audio name="A"/></sktimeline>',/directly after layers, followed by nothing but direct cues/],
  ['element between lanes','<sktimeline version="1"><layers/><audio name="A"/><titles/><audio name="B"/></sktimeline>',/directly after layers, followed by nothing but direct cues/],
  ['comment after lane','<sktimeline version="1"><layers/><audio name="A"/><!-- x --></sktimeline>',/only whitespace/],
  ['text before lane','<sktimeline version="1"><layers/>x<audio name="A"/></sktimeline>',/only whitespace/],
  ['no layers','<sktimeline version="1"><audio name="A"/></sktimeline>',/exactly one direct layers/],
  ['two layers','<sktimeline version="1"><layers/><layers/><audio name="A"/></sktimeline>',/exactly one direct layers/],
 ];
 for(const [label,xml,error] of cases){
  const {file,sha256}=await timelineFile(dir,xml,`${label.replaceAll(' ','-')}.sktl`),destination=path.join(dir,`${label.replaceAll(' ','-')}-out.sktl`);
  await assert.rejects(addTimelineAudioLaneCopy({source:file,destination,format:'sktl',sha256,laneName:'New',follow:false}),error,label);
  await assert.rejects(access(destination),label);assert.equal(await readFile(file,'utf8'),xml,label);
 }
});

// The server appends cues at the end, after the lanes, so a lane added later goes after the last lane and before the cues.
test('adds a lane to the app-saved empty track after this server added cues to it',async t=>{
 const dir=await tempDir(t,'sk-deckless-cues-');
 const app=await timelineFile(dir,APP_EMPTY_TRACK,'app.sktl'),cued=path.join(dir,'cued.sktl'),laned=path.join(dir,'laned.sktl');
 const cue=await addTimelineCueCopy({source:app.file,destination:cued,sha256:app.sha256,layer:1,startMs:5000,lengthMs:2000,label:'Go'});
 const cuedXml=await readFile(cued,'utf8');
 const r=await addTimelineAudioLaneCopy({source:cued,destination:laned,format:'sktl',sha256:sha(cuedXml),laneName:'Audio 2',follow:true});
 assert.equal(r.position,'after_last_lane');assert.equal(r.audioIndex,1);
 const out=await readFile(laned,'utf8');
 assert.equal(out,APP_EMPTY_TRACK.replace('<audio name="Audio 1" follow="0"/>',`<audio name="Audio 1" follow="0"/><audio name="Audio 2" follow="1"/><cue id="${cue.id}" layer="1" startMs="5000" lenMs="2000" label="Go"/>`));
 // A pretty-printed timeline keeps the whitespace around the cues, and a laneless one takes the lane after layers.
 const pretty=await timelineFile(dir,'<sktimeline version="1">\n <layers/>\n <audio name="A" follow="0"/>\n <cue id="c1"/>\n <cue id="c2"/>\n</sktimeline>\n','pretty.sktl');
 const p=await addTimelineAudioLaneCopy({source:pretty.file,destination:path.join(dir,'pretty-out.sktl'),format:'sktl',sha256:pretty.sha256,laneName:'B',follow:false});
 assert.equal(p.position,'after_last_lane');assert.equal(await readFile(path.join(dir,'pretty-out.sktl'),'utf8'),'<sktimeline version="1">\n <layers/>\n <audio name="A" follow="0"/><audio name="B" follow="0"/>\n <cue id="c1"/>\n <cue id="c2"/>\n</sktimeline>\n');
 const laneless=await timelineFile(dir,'<sktimeline version="1"><layers/><cue id="c"/></sktimeline>','laneless.sktl');
 const l=await addTimelineAudioLaneCopy({source:laneless.file,destination:path.join(dir,'laneless-out.sktl'),format:'sktl',sha256:laneless.sha256,laneName:'A',follow:false});
 assert.equal(l.position,'after_layers');assert.equal(await readFile(path.join(dir,'laneless-out.sktl'),'utf8'),'<sktimeline version="1"><layers/><audio name="A" follow="0"/><cue id="c"/></sktimeline>');
 assert.equal(await readFile(app.file,'utf8'),APP_EMPTY_TRACK);
});

test('composes lanes, clips and cues on a new track from the app-saved empty template',async t=>{
 const dir=await tempDir(t,'sk-deckless-compose-'),template=await timelineFile(dir,APP_EMPTY_TRACK,'empty.sktl');
 const show=await showFile(dir,[['content/Main.sktl',deckTimeline]]),templateDonor={file:template.file,format:'sktl',sha256:template.sha256};
 const destination=path.join(dir,'out.skshow');
 const r=await composeShowCopy({source:show.file,destination,sha256:show.sha256,templateDonor,trackName:'Drums',partName:'content/Drums.sktl',audioLanes:[{laneName:'Audio 2',follow:true}],audioClips:[{audioIndex:0,clip},{laneName:'Audio 2',clip:{...clip,name:'Snare',file:'/music/snare.wav'}}],cues:[{layer:0,startMs:0,lengthMs:500,label:'Hit'}]});
 assert.deepEqual(r.audioLanes,[{laneName:'Audio 2',audioIndex:1}]);
 const track=await inspectShowTimeline({file:destination,name:'content/Drums.sktl'});
 assert.equal(track.attributes.name,'Drums');assert.equal(track.attributes.mediaPps,'75');
 assert.deepEqual(track.audio,[{name:'Audio 1',follow:'0'},{name:'Audio 2',follow:'1'}]);
 assert.deepEqual(track.audioClips.map(c=>[c.audioIndex,c.attributes.name]),[[0,'Kick'],[1,'Snare']]);
 assert.equal(track.cueElements.length,1);assert.equal(track.layers.length,4);
 assert.equal((await readShowPart({file:destination,name:'content/Main.sktl'})).text,deckTimeline);
 assert.equal(await readFile(show.file,'utf8'),show.xml);

 // Removing the template lane in the same composition shifts the added lane down in the receipt.
 const shifted=path.join(dir,'shifted.skshow');
 const s=await composeShowCopy({source:show.file,destination:shifted,sha256:show.sha256,templateDonor,trackName:'Bass',partName:'content/Bass.sktl',audioLanes:[{laneName:'Bass',follow:false}],audioClips:[{laneName:'Bass',clip}],audioLaneRemovals:[{audioIndex:0}]});
 assert.deepEqual(s.audioLanes,[{laneName:'Bass',audioIndex:0}]);assert.deepEqual(s.audioRemovals.lanes,[{audioIndex:0,attributes:{name:'Audio 1',follow:'0'},clips:[]}]);
 assert.deepEqual((await inspectShowTimeline({file:shifted,name:'content/Bass.sktl'})).audio,[{name:'Bass',follow:'0'}]);

 // The same template as a part of the show, selected with templateName, in multi-track composition.
 const inShow=await showFile(dir,[['content/Main.sktl',deckTimeline],['content/Empty.sktl',APP_EMPTY_TRACK]],'with-template.skshow'),multi=path.join(dir,'multi.skshow');
 const m=await composeMultiTrackShowCopy({source:inShow.file,destination:multi,sha256:inShow.sha256,tracks:[{templateName:'content/Empty.sktl',trackName:'One',partName:'content/One.sktl',audioLanes:[{laneName:'Click',follow:false}]},{existingPartName:'content/Main.sktl',audioLanes:[{laneName:'Main',follow:true}]}]});
 assert.deepEqual(m.tracks.map(x=>x.audioLanes),[[{laneName:'Click',audioIndex:1}],[{laneName:'Main',audioIndex:0}]]);
 assert.equal((await readShowPart({file:multi,name:'content/Empty.sktl'})).text,APP_EMPTY_TRACK);
 assert.match((await readShowPart({file:multi,name:'content/Main.sktl'})).text,/<layers\/><audio name="Main" follow="1"\/><deck\/>/);
});

test('a failing new-track audio operation publishes nothing',async t=>{
 const dir=await tempDir(t,'sk-deckless-rollback-'),template=await timelineFile(dir,APP_EMPTY_TRACK,'empty.sktl');
 const show=await showFile(dir,[['content/Main.sktl',deckTimeline]]),templateDonor={file:template.file,format:'sktl',sha256:template.sha256};
 const base={source:show.file,sha256:show.sha256,templateDonor,trackName:'Drums',partName:'content/Drums.sktl'};
 const failures=[
  [{audioLanes:[{laneName:'Audio 1',follow:false}]},/already exists/],
  [{audioLanes:[{laneName:'Audio 2',follow:true}],audioClips:[{laneName:'Audio 2',clip:{...clip,trimEndMs:'0'}}]},/trimEndMs/],
  [{audioLanes:[{laneName:'Audio 2',follow:true}],audioClips:[{audioIndex:2,clip}]},/Audio lane does not exist/],
  [{audioLanes:[{laneName:'Audio 2',follow:true}],cues:[{layer:4,startMs:0,lengthMs:5,label:'Late'}]},/Layer index/],
 ];
 for(const [i,[fields,error]] of failures.entries()){
  const destination=path.join(dir,`bad-${i}.skshow`);
  await assert.rejects(composeShowCopy({...base,destination,...fields}),error);
  await assertNoOutput(dir,destination);
 }
 assert.equal(await readFile(show.file,'utf8'),show.xml);
});

test('a session composition adds a mapped clip in a lane added to a new track',async t=>{
 const dir=await tempDir(t,'sk-deckless-session-'),session=path.join(dir,'Session A'),library=path.join(dir,'library');
 await mkdir(path.join(session,'MEDIA'),{recursive:true});await mkdir(library);
 const show=`<skshow>${part('content/Main.sktl',deckTimeline)}${part('patch.skf',patch)}</skshow>`;await writeFile(path.join(session,'session.skshow'),show);
 const media=path.join(library,'Kick.wav');await writeFile(media,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(1024,3)]));
 const template=await timelineFile(dir,APP_EMPTY_TRACK,'empty.sktl'),destination=path.join(dir,'Session B');
 const {file:_,...clipFields}=clip;
 const r=await composeSessionMediaCopy({source:session,destination,sha256:sha(show),media:[{source:media}],tracks:[{templateDonor:{file:template.file,format:'sktl',sha256:template.sha256},trackName:'Drums',partName:'content/Drums.sktl',audioLanes:[{laneName:'Audio 2',follow:false}],audioClips:[{laneName:'Audio 2',mediaIndex:0,clip:clipFields}]}]});
 assert.deepEqual(r.validation.diagnostics.filter(d=>d.severity==='error'),[]);assert.equal(r.validation.file,r.sessionFile);assert.equal(r.clipLinks.length,1);assert.equal(r.clipLinks[0].archivePath,'MEDIA/Kick.wav');
 const inventory=await inspectSessionMedia({directory:destination});
 const lanes=inventory.lanes.filter(l=>l.part==='content/Drums.sktl');
 assert.deepEqual(lanes.map(l=>[l.audioIndex,l.attributes.name,l.clipCount]),[[0,'Audio 1',0],[1,'Audio 2',1]]);
 assert.deepEqual(inventory.clips.filter(c=>c.part==='content/Drums.sktl').map(c=>[c.audioIndex,c.clipIndex,c.attributes.file,c.mapping]),[[1,0,media,{line:1,archivePath:'MEDIA/Kick.wav',sidecar:'regular_file'}]]);
 assert.equal(await readFile(path.join(session,'session.skshow'),'utf8'),show);
});

test('MCP adds lanes to the app-saved empty track and to a new track from it',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const dir=await tempDir(t,'sk-deckless-mcp-'),template=await timelineFile(dir,APP_EMPTY_TRACK,'empty.sktl'),show=await showFile(dir,[['content/Main.sktl',deckTimeline]]);
 const client=new Client({name:'deckless-lane-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.equal(r.isError,undefined,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const lane=await call('showkontrol_add_timeline_audio_lane_copy',{source:template.file,destination:path.join(dir,'lane.sktl'),format:'sktl',sha256:template.sha256,laneName:'Audio 2',follow:true});
 assert.equal(lane.audioIndex,1);assert.equal(lane.position,'after_last_lane');
 const destination=path.join(dir,'out.skshow');
 const composed=await call('showkontrol_compose_show_copy',{source:show.file,destination,sha256:show.sha256,templateDonor:{file:template.file,format:'sktl',sha256:template.sha256},trackName:'Drums',partName:'content/Drums.sktl',audioLanes:[{laneName:'Audio 2',follow:true}],audioClips:[{laneName:'Audio 2',clip}]});
 assert.deepEqual(composed.audioLanes,[{laneName:'Audio 2',audioIndex:1}]);
 assert.deepEqual((await inspectShowTimeline({file:destination,name:'content/Drums.sktl'})).audioClips.map(c=>[c.audioIndex,c.attributes.name]),[[1,'Kick']]);
 const rejected=await client.callTool({name:'showkontrol_compose_show_copy',arguments:{source:show.file,destination:path.join(dir,'bad.skshow'),sha256:show.sha256,templateDonor:{file:template.file,format:'sktl',sha256:template.sha256},trackName:'Drums',partName:'content/Drums.sktl',audioLanes:[{laneName:'Audio 1',follow:false}]}});
 assert.equal(rejected.isError,true);assert.match(rejected.content[0].text,/already exists/);await assertNoOutput(dir,path.join(dir,'bad.skshow'));
});
