import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const hash=(algorithm,text)=>createHash(algorithm).update(text).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;
// Byte-exact R27 27.0.11 app-saved empty track (see audio-lane-deckless.test.js).
const APP_EMPTY_TRACK='<?xml version="1.0" encoding="UTF-8"?><sktimeline version="1" name="Track 2" fps="25" fpsdef="1" offsetMs="0" smpteMs="0" media="" mediaWave="" mediaGrid="" mediaPps="75" mediaStructS="" mediaStructE="" mediaStructL=""><titles/><layers><layer name="Layer 1"/><layer name="Layer 2"/><layer name="Layer 3"/><layer name="Layer 4"/></layers><audio name="Audio 1" follow="0"/></sktimeline>';
const clip={name:'Kick',file:'/music/kick.wav',wave:'',grid:'',pps:'315',offsetMs:'0',trimStartMs:'0',trimEndMs:'1000',fadeInMs:'0',fadeOutMs:'0'};

// Each single-step copy tool returns the written file's SHA-256, so an agent can chain them without inspecting in between.
test('single-step show copy tools return the SHA-256 the next tool needs',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-copy-chain-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'00.skshow'),template=path.join(dir,'empty.sktl');
 const xml=`<skshow>${part('content/Main.sktl','<sktimeline version="1" name="Main"><layers><layer name="L"/></layers></sktimeline>')}${part('content/Setlist.skls','<sksetlist version="2" active="0"><set name="Night"><entry track="Main"/></set></sksetlist>')}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 await writeFile(source,xml);await writeFile(template,APP_EMPTY_TRACK);
 const client=new Client({name:'copy-chain-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const name='content/Intro.sktl';
 const steps=[
  ['showkontrol_create_show_track_copy',{templateDonor:{file:template,format:'sktl',sha256:hash('sha256',APP_EMPTY_TRACK)},trackName:'Intro',partName:name}],
  ['showkontrol_add_show_timeline_cue_copy',{name,layer:0,startMs:5000,lengthMs:2000,label:'Go'}],
  ['showkontrol_edit_timeline_layer_copy',{format:'skshow',name,operation:'rename',layerName:'Layer 1',newName:'Lights'}],
  ['showkontrol_add_timeline_audio_lane_copy',{format:'skshow',name,laneName:'Audio 2',follow:true}],
  ['showkontrol_add_timeline_audio_clip_copy',{format:'skshow',name,audioIndex:1,clip}],
  ['showkontrol_edit_timeline_audio_clip_copy',{format:'skshow',name,audioIndex:1,clipIndex:0,attributes:{name:'Kick 2'}}],
  ['showkontrol_rename_timeline_audio_lane_copy',{format:'skshow',name,audioIndex:1,laneName:'Audio 2',newName:'Drums'}],
  ['showkontrol_remove_timeline_audio_clip_copy',{format:'skshow',name,audioIndex:1,clipIndex:0}],
  ['showkontrol_remove_timeline_audio_lane_copy',{format:'skshow',name,audioIndex:1}],
  ['showkontrol_add_show_setlist_track_copy',{name:'content/Setlist.skls',setName:'Night',trackName:'Intro'}],
  ['showkontrol_edit_show_setlist_copy',{name:'content/Setlist.skls',operation:'create_set',newSetName:'Late'}],
  ['showkontrol_edit_show_setlist_copy',{name:'content/Setlist.skls',operation:'move_set',setName:'Late',toIndex:0}],
  ['showkontrol_rename_show_track_copy',{oldName:'Intro',newName:'Opening'}],
  ['showkontrol_edit_show_part_copy',{name:'content/Main.sktl',edits:[{find:'name="L"',replace:'name="Layer"'}]}],
 ];
 let current=source,sha256=hash('sha256',xml);
 for(const [index,[tool,args]] of steps.entries()){
  const destination=path.join(dir,`${String(index+1).padStart(2,'0')}.skshow`);
  const response=await client.callTool({name:tool,arguments:{source:current,destination,sha256,...args}});
  assert.equal(response.isError,undefined,`${tool}: ${response.content[0].text}`);
  const result=JSON.parse(response.content[0].text);
  assert.equal(result.sha256,hash('sha256',await readFile(destination)),tool);
  current=destination;sha256=result.sha256;
 }
 const validation=JSON.parse((await client.callTool({name:'showkontrol_validate_show',arguments:{file:current}})).content[0].text);
 assert.equal(validation.sha256,sha256);
 assert.deepEqual(validation.diagnostics.filter(d=>d.severity==='error'),[]);
});

test('set list creation and media track cloning return the written SHA-256',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-copy-chain-clone-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'00.skshow');
 const xml=`<skshow>${part('content/Song.sktl','<sktimeline version="1" name="Song" media="/music/song.wav"><layers><layer/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 await writeFile(source,xml);
 const client=new Client({name:'copy-chain-clone-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 let current=source,sha256=hash('sha256',xml);
 for(const [index,[tool,args]] of [
  ['showkontrol_create_show_setlist_copy',{name:'content/Setlist.skls',setName:'Night',tracks:['Song']}],
  ['showkontrol_clone_media_track_copy',{templateName:'content/Song.sktl',trackName:'Song Copy',partName:'content/SongCopy.sktl'}],
  ['showkontrol_add_show_setlist_track_copy',{name:'content/Setlist.skls',setName:'Night',trackName:'Song Copy'}],
 ].entries()){
  const destination=path.join(dir,`${index+1}.skshow`);
  const response=await client.callTool({name:tool,arguments:{source:current,destination,sha256,...args}});
  assert.equal(response.isError,undefined,`${tool}: ${response.content[0].text}`);
  const result=JSON.parse(response.content[0].text);
  assert.equal(result.sha256,hash('sha256',await readFile(destination)),tool);
  current=destination;sha256=result.sha256;
 }
});
