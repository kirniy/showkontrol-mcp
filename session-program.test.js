import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,access,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {composeSessionMediaCopy} from './session-media-copy.js';
import {inspectSessionMedia} from './session-media.js';
import {inspectShowMedia} from './media-inventory.js';
import {validateShow} from './validate-show.js';
import {inspectShowProgram,inspectProgramTimeline,inspectProgramItemGraph} from './program.js';
import {inspectShowSetlist} from './setlist.js';
import {inspectPatch} from './patch.js';

const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const patch='<showkontrol version="2" name="Show"><graph><node id="n1" type="x"><settings><setting key="level">old</setting></settings></node></graph><appSettings/></showkontrol>';
// The track template allowlist accepts an empty audio lane; lane insertion needs a deck, which templates cannot contain.
const empty='<sktimeline version="1" name="Empty"><layers><layer name="Base"/></layers><audio name="Audio" follow="1"/></sktimeline>';
const donor=`<skshow>${part('Donor.sktl','<sktimeline version="1"><cue id="d"><graph><node id="n5" type="trigger"><settings><setting key="trigger.path">cue.active</setting></settings></node></graph></cue></sktimeline>')}</skshow>`;
const clip={name:'Kick',wave:'',grid:'',pps:'315',offsetMs:'0',trimStartMs:'0',trimEndMs:'2000',fadeInMs:'0',fadeOutMs:'250'};

// A session with session.skf, settings.json and TIMELINE/ extractions, plus a donor show outside it.
async function fixture(t,{extraPart=''}={}){
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-session-program-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const session=path.join(dir,'Session A'),media=path.join(dir,'library');
 await mkdir(path.join(session,'MEDIA'),{recursive:true});await mkdir(path.join(session,'TIMELINE'));await mkdir(media);
 await writeFile(path.join(session,'MEDIA','old.wav'),'RIFF-old');
 const show=`<skshow>${part('media.map','/orig/old.wav\tMEDIA/old.wav\n')}${part('content/Empty.sktl',empty)}${part('Set.skls','<sksetlist version="2"><set name="Main"/></sksetlist>')}${part('patch.skf',patch)}${extraPart}</skshow>`;
 await writeFile(path.join(session,'session.skshow'),show);
 await writeFile(path.join(session,'session.skf'),patch.replace('name="Show"','name="Session A"'));
 await writeFile(path.join(session,'settings.json'),'{"lastPlayer":"internal"}\n');
 await writeFile(path.join(session,'TIMELINE','Empty.sktl'),empty);
 const source=path.join(media,'kick.wav');await writeFile(source,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4096,3)]));
 await writeFile(path.join(dir,'donor.skshow'),donor);
 const track={templateName:'content/Empty.sktl',trackName:'Opener',partName:'content/Opener.sktl',
  audioClips:[{audioIndex:0,mediaIndex:0,clip}],
  cues:[{layer:0,startMs:0,lengthMs:500,label:'Go'}],donor:{file:path.join(dir,'donor.skshow'),sha256:sha(donor),name:'Donor.sktl',cueId:'d'},set:{name:'Set.skls',setName:'Main'}};
 const program={items:[{start:72000000,name:'Doors',notes:'Opener',timeline:{stagedShow:{trackIndex:0},remapCueIds:true},graph:{stagedShow:{trackIndex:0,cueIndex:0},settings:[{nodeIndex:0,key:'trigger.path',value:'item.active'}]}}]};
 return {dir,session,source,sha256:sha(show),destination:path.join(dir,'Session B'),
  args:{source:session,destination:path.join(dir,'Session B'),sha256:sha(show),media:[{source}],patchOperations:[{kind:'setting',nodeId:'n1',key:'level',value:'new'}],tracks:[track],program}};
}
async function assertNothingPublished(f){
 await assert.rejects(access(f.destination));
 assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('.showkontrol')),[]);
}

test('composes media, patch, track, set list and Program into one new session',async t=>{
 const f=await fixture(t),sourceShow=await readFile(path.join(f.session,'session.skshow'));
 const r=await composeSessionMediaCopy(f.args);
 assert.ok((await readFile(path.join(f.session,'session.skshow'))).equals(sourceShow));
 // Independent read-only checks of the published session.
 const validation=await validateShow({file:r.sessionFile});
 assert.deepEqual(validation.diagnostics.filter(d=>d.severity==='error'),[]);
 assert.equal(r.validation.sha256,r.sha256);assert.equal(r.validation.file,r.sessionFile);assert.match(r.validation.note,/staged session\.skshow before publication\.$/);
 assert.equal((await inspectPatch({file:r.sessionFile,format:'skshow'})).nodes.find(n=>n.id==='n1').settings.find(s=>s.key==='level').value,'new');
 assert.deepEqual((await inspectShowSetlist({file:r.sessionFile,name:'Set.skls'})).sets[0].tracks,['Opener']);
 const program=await inspectShowProgram({file:r.sessionFile});
 assert.deepEqual(program.items.map(i=>[i.start,i.name,i.notes]),[[72000000,'Doors','Opener']]);
 const itemTimeline=await inspectProgramTimeline({file:r.sessionFile,sha256:r.sha256,index:0});
 assert.deepEqual(itemTimeline.audioClips.map(c=>c.attributes.file),[f.source]);
 const itemGraph=await inspectProgramItemGraph({file:r.sessionFile,sha256:r.sha256,index:0});
 assert.equal(itemGraph.graph.nodes[0].settings.find(s=>s.key==='trigger.path').value,'item.active');
 const inventory=await inspectShowMedia({file:r.sessionFile});
 assert.deepEqual(inventory.mappings.map(m=>[m.line,m.sourcePath,m.archivePath]),[[1,'/orig/old.wav','MEDIA/old.wav'],[2,f.source,'MEDIA/kick.wav']]);
 assert.deepEqual(inventory.clips.map(c=>[c.part,c.itemIndex,c.mappingLines]),[['content/Opener.sktl',undefined,[2]],['content/Program.skpr',0,[2]]]);
 assert.deepEqual((await inspectSessionMedia({directory:r.destination})).findings.map(x=>[x.archivePath,x.status]),[['MEDIA/old.wav','regular_file'],['MEDIA/kick.wav','regular_file']]);
 assert.ok((await readFile(path.join(r.destination,'MEDIA','kick.wav'))).equals(await readFile(f.source)));
 // Result receipts agree with the independent reads.
 assert.deepEqual(r.clipLinks,[{trackIndex:0,clipItemIndex:0,file:f.source,mappingLine:2,archivePath:'MEDIA/kick.wav',sidecar:'copied'}]);
 assert.deepEqual(r.programClipLinks,[{itemIndex:0,audioIndex:0,clipIndex:0,file:f.source,mappingLine:2,archivePath:'MEDIA/kick.wav',sidecar:'copied'}]);
 assert.equal(program.present,true);assert.equal(r.program.programSha256,program.programSha256);
 assert.equal(r.program.items.length,1);assert.ok(r.program.mappings[0].graph.nodes);
 assert.ok(r.limitations.some(l=>/Program follows static R27 format evidence/.test(l)));
 // session.skf follows the changed patch, the new track gets a TIMELINE extraction, and no Program working file is invented.
 const working=Object.fromEntries(r.workingFiles.entries.map(e=>[e.path,e.action]));
 assert.deepEqual(working,{'TIMELINE/Empty.sktl':'copied','TIMELINE/Opener.sktl':'created','session.skf':'regenerated','settings.json':'copied'});
 assert.match(await readFile(path.join(r.destination,'session.skf'),'utf8'),/name="Session A".*>new</);
 assert.deepEqual(r.warnings.map(w=>w.code),['working_patch_root_name_is_session_name']);
});

test('accepts a Program-only composition and ordered Program edits on a generated session',async t=>{
 const f=await fixture(t);
 const first=await composeSessionMediaCopy({source:f.session,destination:f.destination,sha256:f.sha256,program:{items:[{start:0,name:'Doors',notes:''}]}});
 assert.equal(first.tracks.length,0);assert.deepEqual(first.programClipLinks,[]);assert.deepEqual(first.mediaMap.addedRows,[]);
 const next=path.join(f.dir,'Session C');
 const second=await composeSessionMediaCopy({source:first.destination,destination:next,sha256:first.sha256,program:{operations:[{action:'edit',index:0,name:'Doors open'},{action:'add',start:3600000,name:'Headliner',notes:'Main set'}]}});
 assert.deepEqual((await inspectShowProgram({file:second.sessionFile})).items.map(i=>[i.start,i.name]),[[0,'Doors open'],[3600000,'Headliner']]);
 assert.equal(second.validation.file,second.sessionFile);
 assert.deepEqual((await readdir(next)).sort(),['MEDIA','TIMELINE','session.skf','session.skshow','settings.json']);
});

test('reports Program item clips whose file is not a media.map source',async t=>{
 const f=await fixture(t);f.args.media=[];f.args.tracks[0].audioClips=[{audioIndex:0,clip:{...clip,file:'/elsewhere/kick.wav'}}];
 const r=await composeSessionMediaCopy(f.args);
 assert.deepEqual(r.programClipLinks,[{itemIndex:0,audioIndex:0,clipIndex:0,file:'/elsewhere/kick.wav',mappingLine:null}]);
 assert.deepEqual(r.warnings.filter(w=>w.code.endsWith('unmapped')).map(w=>w.code),['clip_file_unmapped','program_clip_file_unmapped']);
 const g=await fixture(t);await rm(path.join(g.session,'MEDIA','old.wav'));
 g.args.media=[];g.args.allowMissingSidecars=true;g.args.tracks[0].audioClips=[{audioIndex:0,clip:{...clip,file:'/orig/old.wav'}}];
 const missing=await composeSessionMediaCopy(g.args);
 assert.deepEqual(missing.programClipLinks,[{itemIndex:0,audioIndex:0,clipIndex:0,file:'/orig/old.wav',mappingLine:1,archivePath:'MEDIA/old.wav',sidecar:'missing'}]);
 assert.deepEqual(missing.warnings.filter(w=>w.code.includes('sidecar_missing')).map(w=>w.code),['clip_sidecar_missing','program_clip_sidecar_missing']);
});

test('publishes nothing when the composed session fails validation or a staged selector is invalid',async t=>{
 // A source timeline with a cue on a missing layer passes media-only copying but blocks composition.
 const bad='<sktimeline version="1" name="Bad"><layers><layer/></layers><cue id="c1" layer="3" startMs="0" lenMs="10"/></sktimeline>';
 const f=await fixture(t,{extraPart:part('content/Bad.sktl',bad)}),before=await readFile(path.join(f.session,'session.skshow'));
 await assert.rejects(composeSessionMediaCopy({...f.args,patchOperations:undefined,tracks:undefined,media:[],program:{items:[{start:0,name:'Doors',notes:''}]}}),/validation failed/);
 await assertNothingPublished(f);
 const mediaOnly=await composeSessionMediaCopy({source:f.session,destination:f.destination,sha256:f.sha256,media:[{source:f.source}]});
 assert.equal(mediaOnly.validation,undefined);assert.equal(mediaOnly.programClipLinks,undefined);
 await rm(f.destination,{recursive:true});
 const g=await fixture(t);g.args.program.items[0].timeline={stagedShow:{trackIndex:1}};
 await assert.rejects(composeSessionMediaCopy(g.args),/staged-show donor selector/);
 await assertNothingPublished(g);
 assert.ok((await readFile(path.join(f.session,'session.skshow'))).equals(before));
});

test('MCP accepts program in the session media composition schema',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const f=await fixture(t);
 const client=new Client({name:'session-program-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const {tools}=await client.listTools();const tool=tools.find(x=>x.name==='showkontrol_compose_session_media_copy');
 assert.ok(tool.inputSchema.properties.program);
 const full=tools.find(x=>x.name==='showkontrol_compose_full_show_copy');
 assert.deepEqual(tool.inputSchema.properties.program.anyOf,full.inputSchema.properties.program.anyOf);
 const inspected=JSON.parse((await client.callTool({name:'showkontrol_inspect_session_media',arguments:{directory:f.session}})).content[0].text);
 const response=await client.callTool({name:'showkontrol_compose_session_media_copy',arguments:{...f.args,sha256:inspected.showSha256}});
 assert.equal(response.isError,undefined,JSON.stringify(response));
 const r=JSON.parse(response.content[0].text);
 assert.equal(r.programClipLinks[0].archivePath,'MEDIA/kick.wav');
 const after=JSON.parse((await client.callTool({name:'showkontrol_inspect_show_media',arguments:{file:r.sessionFile}})).content[0].text);
 assert.deepEqual(after.clips.map(c=>c.mappingLines),[[2],[2]]);
 const bad=await client.callTool({name:'showkontrol_compose_session_media_copy',arguments:{...f.args,sha256:inspected.showSha256,destination:path.join(f.dir,'C'),program:{items:[{start:-1,name:'x',notes:''}]}}});
 assert.equal(bad.isError,true);
});
