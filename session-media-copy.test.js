import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink,rm,lstat,access,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {composeSessionMediaCopy} from './session-media-copy.js';
import {inspectSessionMedia} from './session-media.js';
import {inspectShowMedia} from './media-inventory.js';
import {readShowSnapshot,readShowPart} from './xml-copy.js';

const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const timeline='<sktimeline version="1"><layers/><deck/></sktimeline>';
const clip={name:'Kick',wave:'',grid:'',pps:'315',offsetMs:'1000',trimStartMs:'0',trimEndMs:'2000',fadeInMs:'0',fadeOutMs:'250'};
const opaque=Buffer.from([0,1,2,255,254]);

async function fixture(t,{map='/orig/old.wav\tMEDIA/old.wav\n',sidecars={'old.wav':'RIFF-old'},extra=true}={}){
 // macOS reaches its temporary directory through the /var symlink; media sources must use resolved paths.
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-session-copy-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const session=path.join(dir,'Session A'),media=path.join(dir,'library');
 await mkdir(path.join(session,'MEDIA'),{recursive:true});await mkdir(media);
 for(const [name,value] of Object.entries(sidecars))await writeFile(path.join(session,'MEDIA',name),value);
 if(extra){await writeFile(path.join(session,'session.skf'),'<working/>');await writeFile(path.join(session,'MEDIA','stray.wav'),'unmapped');}
 const show=`<skshow>${map===null?'':part('media.map',map)}${part('content/A.sktl',timeline)}${part('blob.bin',opaque)}</skshow>`;
 await writeFile(path.join(session,'session.skshow'),show);
 const source=path.join(media,'Kick One.wav');await writeFile(source,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(70000,7)]));
 return {dir,session,media,source,sha256:sha(show),destination:path.join(dir,'Session B')};
}
async function tree(root){
 const out={};
 for(const entry of await readdir(root,{withFileTypes:true,recursive:true})){
  const file=path.join(entry.parentPath??entry.path,entry.name),key=path.relative(root,file);
  out[key]=entry.isSymbolicLink()?'symlink':entry.isFile()?sha(await readFile(file)):'dir';
 }
 return out;
}
async function assertNothingPublished(f){
 await assert.rejects(access(f.destination));
 assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('.showkontrol')),[]);
}

test('copies mapped and new sidecars into a new session and links a composed clip',async t=>{
 const f=await fixture(t),before=await tree(f.session);
 const r=await composeSessionMediaCopy({source:f.session,destination:f.destination,sha256:f.sha256,media:[{source:f.source}],tracks:[{existingPartName:'content/A.sktl',audioLanes:[{laneName:'Audio',follow:true}],audioClips:[{laneName:'Audio',mediaIndex:0,clip},{laneName:'Audio',clip:{...clip,name:'Old',file:'/orig/old.wav'}}]}]});
 assert.deepEqual(await tree(f.session),before);
 assert.deepEqual((await readdir(f.dir)).sort(),['Session A','Session B','library']);
 assert.deepEqual((await readdir(f.destination)).sort(),['MEDIA','session.skf','session.skshow']);
 assert.deepEqual((await readdir(path.join(f.destination,'MEDIA'))).sort(),['Kick One.wav','old.wav','stray.wav']);
 assert.equal(await readFile(path.join(f.destination,'session.skf'),'utf8'),'<working/>');
 assert.ok((await readFile(path.join(f.destination,'MEDIA','Kick One.wav'))).equals(await readFile(f.source)));
 assert.equal(await readFile(path.join(f.destination,'MEDIA','old.wav'),'utf8'),'RIFF-old');
 assert.equal((await lstat(path.join(f.destination,'session.skshow'))).nlink,1);
 // Independent read-only inventory of the published session.
 const statuses=await inspectSessionMedia({directory:f.destination});
 assert.equal(statuses.showSha256,r.sha256);
 assert.deepEqual(statuses.findings.map(x=>[x.line,x.archivePath,x.status]),[[1,'MEDIA/old.wav','regular_file'],[2,'MEDIA/Kick One.wav','regular_file']]);
 const inventory=await inspectShowMedia({file:r.sessionFile});
 assert.deepEqual(inventory.mappings.map(m=>[m.sourcePath,m.archivePath]),[['/orig/old.wav','MEDIA/old.wav'],[f.source,'MEDIA/Kick One.wav']]);
 assert.deepEqual(inventory.clips.map(c=>[c.attributes.name,c.attributes.file,c.mappingLines]),[['Kick',f.source,[2]],['Old','/orig/old.wav',[1]]]);
 assert.deepEqual(inventory.diagnostics,[]);
 const snapshot=await readShowSnapshot({file:r.sessionFile});
 assert.ok(snapshot.parts.every(p=>p.valid));
 assert.ok(snapshot.parts.find(p=>p.name==='blob.bin').bytes.equals(opaque));
 assert.equal(r.sidecars.find(s=>s.origin==='added').sha256,sha(await readFile(f.source)));
 assert.deepEqual(r.mediaMap.addedRows,[{mediaIndex:0,line:2,sourcePath:f.source,archivePath:'MEDIA/Kick One.wav'}]);
 assert.deepEqual(r.clipLinks.map(l=>l.mappingLine),[2,1]);
 assert.deepEqual(r.workingFiles.entries.map(e=>[e.path,e.action,e.relation]),[['MEDIA/stray.wav','copied','none'],['session.skf','copied','none']]);
 assert.equal(r.workingFiles.directories,1);
 assert.deepEqual(r.warnings,[]);
});

test('creates media.map when absent and keeps CRLF, BOM and missing final line breaks',async t=>{
 const absent=await fixture(t,{map:null,sidecars:{},extra:false});
 const created=await composeSessionMediaCopy({source:absent.session,destination:absent.destination,sha256:absent.sha256,media:[{source:absent.source,sidecarName:'kick.wav'}]});
 assert.equal(created.mediaMap.created,true);assert.equal(created.tracks,undefined);
 assert.equal((await readShowPart({file:created.sessionFile,name:'media.map'})).text,`${absent.source}\tMEDIA/kick.wav\n`);
 const crlf=await fixture(t,{map:'﻿/orig/old.wav\tMEDIA/old.wav'});
 const r=await composeSessionMediaCopy({source:crlf.session,destination:crlf.destination,sha256:crlf.sha256,media:[{source:crlf.source}]});
 assert.equal(r.mediaMap.created,false);
 assert.equal((await readShowPart({file:r.sessionFile,name:'media.map'})).text,`﻿/orig/old.wav\tMEDIA/old.wav\n${crlf.source}\tMEDIA/Kick One.wav\n`);
 const windows=await fixture(t,{map:'/orig/old.wav\tMEDIA/old.wav\r\n'});
 const w=await composeSessionMediaCopy({source:windows.session,destination:windows.destination,sha256:windows.sha256,media:[{source:windows.source}]});
 assert.equal((await readShowPart({file:w.sessionFile,name:'media.map'})).text,`/orig/old.wav\tMEDIA/old.wav\r\n${windows.source}\tMEDIA/Kick One.wav\r\n`);
});

test('rejects unsafe media, names and session states without publishing or changing the source',async t=>{
 const f=await fixture(t),before=await tree(f.session),args={source:f.session,destination:f.destination,sha256:f.sha256};
 const reject=async(input,pattern)=>{await assert.rejects(composeSessionMediaCopy({...args,...input}),pattern);await assertNothingPublished(f);assert.deepEqual(await tree(f.session),before);};
 await symlink(f.source,path.join(f.media,'link.wav'));
 await reject({media:[{source:path.join(f.media,'link.wav')}]},/symlink/);
 await reject({media:[{source:f.media}]},/not a regular file/);
 await writeFile(path.join(f.media,'empty.wav'),'');await reject({media:[{source:path.join(f.media,'empty.wav')}]},/empty/);
 await reject({media:[{source:path.join(f.media,'none.wav')}]},/not found/);
 await reject({media:[{source:'relative.wav'}]},/normalized absolute/);
 await reject({media:[{source:f.media+'/../library/Kick One.wav'}]},/normalized absolute/);
 await writeFile(path.join(f.media,'tab\tname.wav'),'x');await reject({media:[{source:path.join(f.media,'tab\tname.wav')}]},/control characters/);
 for(const sidecarName of ['../x.wav','a/b.wav','.hidden.wav','a:b.wav','line\nbreak.wav'])await reject({media:[{source:f.source,sidecarName}]},/Sidecar name/);
 await reject({media:[{source:f.source,sidecarName:'OLD.WAV'}]},/collides with MEDIA\/old\.wav/);
 await reject({media:[{source:f.source,sidecarName:'Stray.WAV'}]},/collides with existing session entry MEDIA\/stray\.wav/);
 // A symlinked parent directory would record a path that names a file elsewhere.
 await symlink(f.media,path.join(f.dir,'alias'));
 await reject({media:[{source:path.join(f.dir,'alias','Kick One.wav')}]},new RegExp(`symlinked directory ${path.join(f.dir,'alias').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}; supply the resolved path ${f.source.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
 await writeFile(path.join(f.dir,'plain'),'x');await reject({media:[{source:path.join(f.dir,'plain','x.wav')}]},/parent is not a directory/);
 await reject({media:[{source:path.join(f.dir,'nowhere','x.wav')}]},/not found/);
 await reject({media:[{source:f.source},{source:path.join(f.media,'Kick One.wav')}]},/Duplicate media source/);
 await reject({media:[{source:'/orig/old.wav'}]},/already mapped on media.map line 1/);
 await reject({media:[{source:f.source}],sha256:'0'.repeat(64)},/changed since inspection/);
 await reject({media:[]},/Add media, tracks, operations or a Program/);
 await reject({media:[{source:f.source}],destination:path.join(f.session,'MEDIA','nested')},/outside the source session/);
 await reject({media:[{source:f.source}],tracks:[{existingPartName:'content/A.sktl',audioClips:[{audioIndex:0,mediaIndex:1,clip}]}]},/mediaIndex must select/);
 await reject({media:[{source:f.source}],tracks:[{existingPartName:'content/A.sktl',audioClips:[{audioIndex:0,mediaIndex:0,clip:{...clip,file:'/x.wav'}}]}]},/omit file/);
 // Composition fails after planning; no destination or staging directory may remain.
 await reject({media:[{source:f.source}],tracks:[{existingPartName:'content/A.sktl',audioClips:[{laneName:'Missing',mediaIndex:0,clip}]}]},/laneName/);
 try{execFileSync('mkfifo',[path.join(f.media,'pipe.wav')]);await reject({media:[{source:path.join(f.media,'pipe.wav')}]},/not a regular file/);}catch(error){if(error.code!=='ENOENT')throw error;}
 process.env.SHOWKONTROL_SESSION_MEDIA_MAX_BYTES='100';t.after(()=>{delete process.env.SHOWKONTROL_SESSION_MEDIA_MAX_BYTES;});
 await reject({media:[{source:f.source}]},/above the 100-byte limit/);
 delete process.env.SHOWKONTROL_SESSION_MEDIA_MAX_BYTES;
 await mkdir(f.destination);await assert.rejects(composeSessionMediaCopy({...args,media:[{source:f.source}]}),/already exists/);
 assert.deepEqual(await readdir(f.destination),[]);
});

test('compares sidecar names after Unicode normalization',async t=>{
 const nfc='caf\u00e9.wav',nfd='cafe\u0301.wav';assert.notEqual(nfc,nfd);
 const f=await fixture(t,{map:`/orig/cafe.wav\tMEDIA/${nfc}\n`,sidecars:{[nfc]:'old'}});
 await assert.rejects(composeSessionMediaCopy({source:f.session,destination:f.destination,sha256:f.sha256,media:[{source:f.source,sidecarName:nfd}]}),/collides/);
 await assertNothingPublished(f);
});

test('requires every mapped sidecar to be a regular file unless missing sidecars are allowed',async t=>{
 const f=await fixture(t,{map:'/orig/old.wav\tMEDIA/old.wav\n/orig/gone.wav\tMEDIA/gone.wav\n'}),args={source:f.session,destination:f.destination,sha256:f.sha256,media:[{source:f.source}]};
 await assert.rejects(composeSessionMediaCopy(args),/MEDIA\/gone\.wav is missing; set allowMissingSidecars/);await assertNothingPublished(f);
 const r=await composeSessionMediaCopy({...args,allowMissingSidecars:true,tracks:[{existingPartName:'content/A.sktl',audioLanes:[{laneName:'Audio',follow:false}],audioClips:[{laneName:'Audio',clip:{...clip,file:'/orig/gone.wav'}},{laneName:'Audio',clip:{...clip,file:'/elsewhere.wav'}}]}]});
 assert.deepEqual(r.missingSidecars,[{archivePath:'MEDIA/gone.wav',lines:[2]}]);
 assert.deepEqual(r.warnings.map(w=>w.code),['clip_sidecar_missing','clip_file_unmapped']);
 assert.deepEqual((await inspectSessionMedia({directory:f.destination})).findings.map(x=>x.status),['regular_file','missing','regular_file']);
 const linked=await fixture(t);await rm(path.join(linked.session,'MEDIA','old.wav'));await symlink(linked.source,path.join(linked.session,'MEDIA','old.wav'));
 await assert.rejects(composeSessionMediaCopy({source:linked.session,destination:linked.destination,sha256:linked.sha256,media:[{source:linked.source,sidecarName:'new.wav'}],allowMissingSidecars:true}),/MEDIA\/old\.wav is symlink/);
 await assertNothingPublished(linked);
 const unsafe=await fixture(t,{map:'/orig/x.wav\tMEDIA/../x.wav\n'});
 await assert.rejects(composeSessionMediaCopy({source:unsafe.session,destination:unsafe.destination,sha256:unsafe.sha256,media:[{source:unsafe.source}]}),/unsafe_path/);
 const malformed=await fixture(t,{map:'/orig/x.wav MEDIA/x.wav\n'});
 await assert.rejects(composeSessionMediaCopy({source:malformed.session,destination:malformed.destination,sha256:malformed.sha256,media:[{source:malformed.source}]}),/malformed_mapping/);
});

test('MCP composes a session media copy with a mediaIndex clip',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const f=await fixture(t);
 const client=new Client({name:'session-media-copy-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const {tools}=await client.listTools();assert.ok(tools.some(tool=>tool.name==='showkontrol_compose_session_media_copy'));
 const inspected=JSON.parse((await client.callTool({name:'showkontrol_inspect_session_media',arguments:{directory:f.session}})).content[0].text);
 const response=await client.callTool({name:'showkontrol_compose_session_media_copy',arguments:{source:f.session,destination:f.destination,sha256:inspected.showSha256,media:[{source:f.source,sidecarName:'kick.wav'}],tracks:[{existingPartName:'content/A.sktl',audioLanes:[{laneName:'Audio',follow:true}],audioClips:[{laneName:'Audio',mediaIndex:0,clip}]}]}});
 assert.equal(response.isError,undefined,JSON.stringify(response));
 const r=JSON.parse(response.content[0].text);assert.equal(r.clipLinks[0].archivePath,'MEDIA/kick.wav');
 const after=JSON.parse((await client.callTool({name:'showkontrol_inspect_show_media',arguments:{file:r.sessionFile}})).content[0].text);
 assert.deepEqual(after.clips.map(c=>c.mappingLines),[[2]]);
 const bad=await client.callTool({name:'showkontrol_compose_session_media_copy',arguments:{source:f.session,destination:path.join(f.dir,'C'),sha256:inspected.showSha256,media:[{source:f.source,sidecarName:'old.wav'}]}});
 assert.equal(bad.isError,true);assert.match(bad.content[0].text,/collides/);
});
