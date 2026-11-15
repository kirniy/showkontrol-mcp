import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {composeSessionMediaCopy} from './session-media-copy.js';
import {inspectSessionMedia} from './session-media.js';
import {preflightSessionAudio} from './session-audio-preflight.js';
import {readShowPart} from './xml-copy.js';

// Interactions between set reordering, media.map removal/re-pointing and the session audio preflight.
const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const hasFfprobe=(()=>{try{execFileSync('ffprobe',['-version'],{stdio:'ignore'});return true;}catch{return false;}})();
// PCM16 mono 8 kHz WAV; durations below come from these frame counts, not from ffprobe.
const wav=frames=>{const data=Buffer.alloc(frames*2),h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+data.length,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(8000,24);h.writeUInt32LE(16000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(data.length,40);return Buffer.concat([h,data]);};
const fields={wave:'',grid:'',pps:'315',offsetMs:'0',trimStartMs:'0',trimEndMs:'1000',fadeInMs:'0',fadeOutMs:'0'};
const attrs=Object.entries(fields).map(([k,v])=>`${k}="${v}"`).join(' ');
const patch='<showkontrol version="2" name="Show"><graph/><appSettings/></showkontrol>';
const timeline=`<sktimeline version="1" name="A"><layers><layer name="L"/></layers><audio name="Main" follow="1"><clip name="A" file="/orig/a.wav" ${attrs}/></audio><deck/></sktimeline>`;
const program='<skprogram version="1"><item start="0" name="Song" notes=""><sktimeline version="1"><audio name="P" follow="0"><clip name="C" file="/orig/c.wav"/></audio></sktimeline></item></skprogram>';
const MAP='/orig/a.wav\tMEDIA/a.wav\n/orig/b.wav\tMEDIA/b.wav\n/orig/c.wav\tMEDIA/c.wav\n';
const SET='content/Set.skls';
const setlist=extra=>`<sksetlist version="2" active="0"><set name="Main"><entry track="A"/></set><set name="Spare"/>${extra}</sksetlist>`;
const remove=(line,name)=>({action:'remove_mapping',line,sourcePath:`/orig/${name}.wav`,archivePath:`MEDIA/${name}.wav`});

// a.wav backs the track clip, c.wav the Program item clip, b.wav nothing; MEDIA/stray.wav has no row.
async function session(t,{sets=setlist(''),base}={}){
 const dir=base??await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-cross-r7-')));if(!base)t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'Session A'),library=path.join(dir,'library');
 await mkdir(path.join(root,'MEDIA'),{recursive:true});await mkdir(path.join(root,'TIMELINE'));await mkdir(library);
 const show=`<skshow>${part('media.map',MAP)}${part('content/A.sktl',timeline)}${part('content/Program.skpr',program)}${part(SET,sets)}${part('patch.skf',patch)}</skshow>`;
 await writeFile(path.join(root,'session.skshow'),show);
 await writeFile(path.join(root,'TIMELINE','A.sktl'),timeline);
 await writeFile(path.join(root,'session.skf'),patch.replace('name="Show"','name="Session A"'));
 await writeFile(path.join(root,'MEDIA','a.wav'),wav(8000));await writeFile(path.join(root,'MEDIA','b.wav'),wav(800));
 await writeFile(path.join(root,'MEDIA','c.wav'),wav(4000));await writeFile(path.join(root,'MEDIA','stray.wav'),'RIFF-stray');
 const media=path.join(library,'new.wav');await writeFile(media,wav(12000));
 return {dir,root,library,media,show,sha256:sha(show),destination:path.join(dir,'Session B')};
}
async function tree(root){
 const out={};
 for(const entry of await readdir(root,{withFileTypes:true,recursive:true})){const file=path.join(entry.parentPath??entry.path,entry.name);out[path.relative(root,file)]=entry.isFile()?sha(await readFile(file)):'dir';}
 return out;
}
const text=async(r,name)=>(await readShowPart({file:r.sessionFile,name})).text;

test('one session call moves a set, removes a row, keeps its sidecar and adds a Program clip; preflight reads the result',{skip:!hasFfprobe&&'ffprobe is not installed'},async t=>{
 const s=await session(t),before=await tree(s.root);
 const {wave:_w,grid:_g,...rest}=fields;
 const r=await composeSessionMediaCopy({source:s.root,destination:s.destination,sha256:s.sha256,media:[{source:s.media}],
  setlistOperations:[{operation:'move_set',name:SET,setName:'Spare',toIndex:0}],
  mediaMapOperations:[remove(2,'b')],removedSidecars:'keep',
  program:{operations:[{action:'add_timeline_audio_clip',index:0,audioIndex:0,mediaIndex:0,clip:{name:'New',wave:'',grid:'',...rest}}]}});
 assert.deepEqual(await tree(s.root),before);
 assert.deepEqual(r.validation.diagnostics.filter(d=>d.severity==='error'),[]);
 // The moved set stays active, the removed row is gone and the new row follows the edited map.
 assert.equal(await text(r,SET),'<sksetlist version="2" active="1"><set name="Spare"/><set name="Main"><entry track="A"/></set></sksetlist>');
 assert.equal(await text(r,'media.map'),`/orig/a.wav\tMEDIA/a.wav\n/orig/c.wav\tMEDIA/c.wav\n${s.media}\tMEDIA/new.wav\n`);
 assert.deepEqual(r.programClipLinks.map(l=>[l.clipIndex,l.file,l.mappingLine,l.archivePath]),[[0,'/orig/c.wav',2,'MEDIA/c.wav'],[1,s.media,3,'MEDIA/new.wav']]);
 // Listing order differs between keep and omit and is not documented.
 assert.deepEqual(r.mediaMap.unmappedSidecars.map(x=>[x.path,x.action,x.reason]).sort(),[['MEDIA/b.wav','kept','mapping_released'],['MEDIA/stray.wav','kept','unmapped_in_source']]);
 // Independent read-back: inventory, then preflight bound to the inventory checksum.
 const inventory=await inspectSessionMedia({directory:s.destination});
 assert.deepEqual(inventory.unmappedMediaEntries.map(e=>e.path).sort(),['MEDIA/b.wav','MEDIA/stray.wav']);
 const p=await preflightSessionAudio({directory:s.destination,sha256:inventory.showSha256});
 assert.deepEqual(p.clips.map(c=>[c.part,c.itemIndex??null,c.clipIndex,c.sidecar.line,c.sidecar.archivePath,c.sidecar.status]),[
  ['content/A.sktl',null,0,1,'MEDIA/a.wav','readable'],['content/Program.skpr',0,0,2,'MEDIA/c.wav','readable'],['content/Program.skpr',0,1,3,'MEDIA/new.wav','readable']]);
 const seconds=c=>p.files[c.sidecar.fileIndex].duration.seconds;
 assert.deepEqual(p.clips.map(seconds),[1,0.5,1.5]);
 // The new clip's source path is the library file, a different file from its sidecar copy.
 const added=p.clips[2];assert.equal(added.sourcePath.status,'readable');assert.notEqual(added.sourcePath.fileIndex,added.sidecar.fileIndex);
 assert.equal(p.files[added.sourcePath.fileIndex].duration.seconds,1.5);
 // A kept, released sidecar is not a candidate of any clip.
 assert.ok(!p.files.some(f=>f.paths.some(x=>x.path.endsWith(`${path.sep}b.wav`))));
 assert.equal(p.trimComparison.status,'not_established');
 assert.deepEqual(p.clips.map(c=>c.observedTrim),[{trimStartMs:'0',trimEndMs:'1000'},{trimStartMs:null,trimEndMs:null},{trimStartMs:'0',trimEndMs:'1000'}]);
 // The source checksum does not bind the published session.
 await assert.rejects(preflightSessionAudio({directory:s.destination,sha256:s.sha256}),/changed|sha256|checksum/i);
});

test('the release guard searches the set list after set operations of the same call',async t=>{
 // A set named by the source path of the row being removed.
 const s=await session(t,{sets:setlist('<set name="/orig/b.wav"/>')}),before=await tree(s.root);
 for(const ops of [[],[{operation:'move_set',name:SET,setName:'/orig/b.wav',toIndex:0}]]){
  await assert.rejects(composeSessionMediaCopy({source:s.root,destination:s.destination,sha256:s.sha256,setlistOperations:ops.length?ops:undefined,mediaMapOperations:[remove(2,'b')],removedSidecars:'omit'}),/Set\.skls/);
  await assert.rejects(readdir(s.destination),{code:'ENOENT'});
 }
 assert.deepEqual(await tree(s.root),before);
 // Removing that set in the same call releases the value.
 const r=await composeSessionMediaCopy({source:s.root,destination:s.destination,sha256:s.sha256,
  setlistOperations:[{operation:'move_set',name:SET,setName:'Spare',toIndex:0},{operation:'remove_set',name:SET,setName:'/orig/b.wav'}],
  mediaMapOperations:[remove(2,'b')],removedSidecars:'omit'});
 assert.equal(await text(r,SET),'<sksetlist version="2" active="1"><set name="Spare"/><set name="Main"><entry track="A"/></set></sksetlist>');
 assert.equal(await text(r,'media.map'),'/orig/a.wav\tMEDIA/a.wav\n/orig/c.wav\tMEDIA/c.wav\n');
 assert.deepEqual((await readdir(path.join(s.destination,'MEDIA'))).sort(),['a.wav','c.wav','stray.wav']);
});

test('re-pointing a row and its clip in one call; preflight sees the new sidecar name and source path',{skip:!hasFfprobe&&'ffprobe is not installed'},async t=>{
 const s=await session(t),moved=path.join(s.library,'a moved.wav');await writeFile(moved,wav(8000));
 const r=await composeSessionMediaCopy({source:s.root,destination:s.destination,sha256:s.sha256,
  tracks:[{existingPartName:'content/A.sktl',audioClipEdits:[{audioIndex:0,clipIndex:0,attributes:{file:moved}}]}],
  mediaMapOperations:[{action:'repoint_mapping',line:1,sourcePath:'/orig/a.wav',archivePath:'MEDIA/a.wav',newSourcePath:moved,newArchivePath:'MEDIA/A final.wav'}],removedSidecars:'omit'});
 assert.equal(await text(r,'media.map'),`${moved}\tMEDIA/A final.wav\n/orig/b.wav\tMEDIA/b.wav\n/orig/c.wav\tMEDIA/c.wav\n`);
 assert.deepEqual((await readdir(path.join(s.destination,'MEDIA'))).sort(),['A final.wav','b.wav','c.wav','stray.wav']);
 // The rewritten working file follows the edited track.
 assert.match(await readFile(path.join(s.destination,'TIMELINE','A.sktl'),'utf8'),/file="[^"]*a moved\.wav"/);
 const p=await preflightSessionAudio({directory:s.destination});
 const [track]=p.clips;
 assert.deepEqual([track.sidecar.line,track.sidecar.archivePath,track.sidecar.status,track.sourcePath.status],[1,'MEDIA/A final.wav','readable','readable']);
 assert.equal(p.files[track.sidecar.fileIndex].duration.seconds,1);assert.equal(p.files[track.sourcePath.fileIndex].duration.seconds,1);
 assert.equal(p.clips[1].sourcePath.status,'not_found_at_checked_path');
});

test('a session reached through a symlinked directory composes with mapping and set operations, and preflight resolves it',async t=>{
 // Reproduces macOS temporary directories (/var -> /private/var) on any system.
 const real=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-cross-r7-alias-')));t.after(()=>rm(real,{recursive:true,force:true}));
 const target=path.join(real,'real');await mkdir(target);const alias=path.join(real,'alias');await symlink(target,alias);
 const s=await session(t,{base:target});
 const r=await composeSessionMediaCopy({source:path.join(alias,'Session A'),destination:path.join(alias,'Session B'),sha256:s.sha256,
  setlistOperations:[{operation:'move_set',name:SET,setName:'Spare',toIndex:0}],mediaMapOperations:[remove(2,'b')],removedSidecars:'omit'});
 assert.equal(path.dirname(r.sessionFile),path.join(target,'Session B'));
 const p=await preflightSessionAudio({directory:path.join(alias,'Session B'),probeDurations:false});
 assert.equal(p.directory,path.join(target,'Session B'));
 assert.deepEqual(p.clips.map(c=>[c.sidecar.archivePath,c.sidecar.status]),[['MEDIA/a.wav','readable'],['MEDIA/c.wav','readable']]);
 // Media sources must still be given as resolved paths.
 await assert.rejects(composeSessionMediaCopy({source:path.join(alias,'Session A'),destination:path.join(alias,'Session C'),sha256:s.sha256,media:[{source:path.join(alias,'library','new.wav')}]}),/symlinked directory/);
});
