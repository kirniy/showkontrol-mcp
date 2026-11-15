import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink,rm,rmdir,lstat,access,realpath,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {composeSessionMediaCopy,publishDirectory,claimDestination} from './session-media-copy.js';
import {readShowSnapshot} from './xml-copy.js';
import {inspectPatch} from './patch.js';
import {inspectShowTimeline} from './timeline.js';

const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const patch='<showkontrol version="2" name="Show"><graph><node id="n1" type="x"><settings><setting key="level">old</setting></settings></node></graph><appSettings/></showkontrol>';
const timeline=name=>`<sktimeline version="1" name="${name}"><layers><layer name="Layer 1"/></layers></sktimeline>`;
const empty='<sktimeline version="1" name="Empty"><layers><layer name="Base"/></layers></sktimeline>';
const settings='{"window":{"x":10},"lastPlayer":"internal"}\n';

// A session shaped like the owner's description: session.skf, settings.json and TIMELINE/ extractions beside session.skshow.
async function fixture(t,{working=true}={}){
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-session-working-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const session=path.join(dir,'Session A'),media=path.join(dir,'library');
 await mkdir(path.join(session,'MEDIA'),{recursive:true});await mkdir(media);
 await writeFile(path.join(session,'MEDIA','old.wav'),'RIFF-old');
 const show=`<skshow>${part('media.map','/orig/old.wav\tMEDIA/old.wav\n')}${part('content/A.sktl',timeline('A'))}${part('content/B.sktl',timeline('B'))}${part('content/Empty.sktl',empty)}${part('patch.skf',patch)}</skshow>`;
 await writeFile(path.join(session,'session.skshow'),show);
 if(working){
  await writeFile(path.join(session,'session.skf'),patch.replace('name="Show"','name="Session A"'));
  await writeFile(path.join(session,'settings.json'),settings);
  await mkdir(path.join(session,'TIMELINE'));
  for(const name of ['A','B'])await writeFile(path.join(session,'TIMELINE',`${name}.sktl`),timeline(name));
  await writeFile(path.join(session,'TIMELINE','Empty.sktl'),empty);
 }
 const source=path.join(media,'kick.wav');await writeFile(source,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4096,3)]));
 return {dir,session,source,sha256:sha(show),destination:path.join(dir,'Session B')};
}
async function tree(root){
 const out={};
 for(const entry of await readdir(root,{withFileTypes:true,recursive:true})){
  const file=path.join(entry.parentPath??entry.path,entry.name);
  out[path.relative(root,file)]=entry.isSymbolicLink()?'symlink':entry.isFile()?sha(await readFile(file)):'dir';
 }
 return out;
}
const addCue={existingPartName:'content/A.sktl',cues:[{layer:0,startMs:100,lengthMs:40,label:'Added'}]};
async function assertNothingPublished(f){
 await assert.rejects(access(f.destination));
 assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('.showkontrol')),[]);
}
// Independent check: every extracted timeline equals its archive part, and session.skf equals patch.skf except for the root name.
async function assertConsistent(destination){
 const snapshot=await readShowSnapshot({file:path.join(destination,'session.skshow')}),parts=new Map(snapshot.parts.map(p=>[p.name,p.bytes]));
 for(const name of await readdir(path.join(destination,'TIMELINE')))assert.ok((await readFile(path.join(destination,'TIMELINE',name))).equals(parts.get(`content/${name}`)),name);
 const working=await readFile(path.join(destination,'session.skf'),'utf8');
 assert.equal(working.replace('name="Session A"','name="Show"'),parts.get('patch.skf').toString('utf8'));
}

test('keeps working files and regenerates only extractions of changed parts',async t=>{
 const f=await fixture(t),before=await tree(f.session);
 const r=await composeSessionMediaCopy({source:f.session,destination:f.destination,sha256:f.sha256,media:[{source:f.source}],tracks:[addCue]});
 assert.deepEqual(await tree(f.session),before);
 assert.deepEqual(r.workingFiles.entries.map(e=>[e.path,e.action,e.relation,e.parts]),[
  ['TIMELINE/A.sktl','regenerated','exact',['content/A.sktl']],
  ['TIMELINE/B.sktl','copied','exact',['content/B.sktl']],
  ['TIMELINE/Empty.sktl','copied','exact',['content/Empty.sktl']],
  ['session.skf','copied','root_name',['patch.skf']],
  ['settings.json','copied','none',undefined]]);
 assert.equal(await readFile(path.join(f.destination,'settings.json'),'utf8'),settings);
 assert.equal((await inspectShowTimeline({file:r.sessionFile,name:'content/A.sktl'})).cueElements.length,1);
 assert.match(await readFile(path.join(f.destination,'TIMELINE','A.sktl'),'utf8'),/label="Added"/);
 await assertConsistent(f.destination);
 assert.deepEqual(r.warnings.map(w=>w.code),['working_patch_root_name_is_session_name']);
 assert.deepEqual((await readdir(f.destination)).sort(),['MEDIA','TIMELINE','session.skf','session.skshow','settings.json']);
});

test('regenerates session.skf from a changed patch and keeps the working root name',async t=>{
 const f=await fixture(t);
 const r=await composeSessionMediaCopy({source:f.session,destination:f.destination,sha256:f.sha256,patchOperations:[{kind:'setting',nodeId:'n1',key:'level',value:'new'}]});
 assert.deepEqual(r.workingFiles.entries.find(e=>e.path==='session.skf'),{path:'session.skf',action:'regenerated',relation:'root_name',parts:['patch.skf'],size:r.workingFiles.entries.find(e=>e.path==='session.skf').size,sha256:sha(await readFile(path.join(f.destination,'session.skf')))});
 const working=await inspectPatch({file:path.join(f.destination,'session.skf'),format:'skf'});
 assert.equal(working.name,'Session A');assert.equal(working.nodes[0].settings[0].value,'new');
 await assertConsistent(f.destination);
 assert.ok(r.workingFiles.entries.filter(e=>e.path.startsWith('TIMELINE/')).every(e=>e.action==='copied'));
});

test('creates the extraction for a new track using the layout observed in the source',async t=>{
 const f=await fixture(t);
 const r=await composeSessionMediaCopy({source:f.session,destination:f.destination,sha256:f.sha256,tracks:[{templateName:'content/Empty.sktl',trackName:'New',partName:'content/New.sktl'}]});
 assert.deepEqual(r.workingFiles.entries.find(e=>e.path==='TIMELINE/New.sktl')?.action,'created');
 await assertConsistent(f.destination);
 // Without a consistent layout the new part has no extraction; the tool refuses rather than leave TIMELINE incomplete.
 const g=await fixture(t);await rename(path.join(g.session,'TIMELINE','B.sktl'),path.join(g.session,'TIMELINE','track-b.sktl'));
 const args={source:g.session,destination:g.destination,sha256:g.sha256,tracks:[{templateName:'content/Empty.sktl',trackName:'New',partName:'content/New.sktl'}]};
 await assert.rejects(composeSessionMediaCopy(args),/No working file was created for new part content\/New\.sktl/);await assertNothingPublished(g);
 const omitted=await composeSessionMediaCopy({...args,omitUnverifiedWorkingFiles:true});
 assert.deepEqual(omitted.warnings.filter(w=>w.code==='working_file_not_created').map(w=>w.part),['content/New.sktl']);
 assert.equal(omitted.workingFiles.entries.find(e=>e.path==='TIMELINE/track-b.sktl').action,'copied');
});

test('refuses working state that would disagree with the composed archive unless told to omit it',async t=>{
 const f=await fixture(t),before=await tree(f.session);
 // An unsaved working edit to the track being composed.
 await writeFile(path.join(f.session,'TIMELINE','A.sktl'),timeline('A').replace('Layer 1','Edited'));
 const args={source:f.session,destination:f.destination,sha256:f.sha256,tracks:[addCue]};
 await assert.rejects(composeSessionMediaCopy(args),/TIMELINE\/A\.sktl: differs from content\/A\.sktl, which the composition changed/);await assertNothingPublished(f);
 const r=await composeSessionMediaCopy({...args,omitUnverifiedWorkingFiles:true});
 assert.deepEqual(r.workingFiles.entries.find(e=>e.path==='TIMELINE/A.sktl'),{path:'TIMELINE/A.sktl',action:'omitted',relation:'name',parts:['content/A.sktl'],reason:'stale_working_file'});
 await assert.rejects(access(path.join(f.destination,'TIMELINE','A.sktl')));
 assert.deepEqual(r.warnings.filter(w=>w.code==='working_file_omitted').map(w=>w.path),['TIMELINE/A.sktl']);
 await assertConsistent(f.destination);
 // A diverged extraction of an untouched track is kept, with a warning.
 const g=await fixture(t);await writeFile(path.join(g.session,'TIMELINE','B.sktl'),timeline('B').replace('Layer 1','Edited'));
 const kept=await composeSessionMediaCopy({source:g.session,destination:g.destination,sha256:g.sha256,tracks:[addCue]});
 assert.equal(kept.workingFiles.entries.find(e=>e.path==='TIMELINE/B.sktl').action,'copied');
 assert.ok(kept.warnings.some(w=>w.code==='working_file_differs_from_archive'&&w.path==='TIMELINE/B.sktl'));
 // An unidentified extraction blocks timeline changes but not media-only changes.
 const h=await fixture(t);await writeFile(path.join(h.session,'TIMELINE','unknown.sktl'),'<sktimeline version="1"/>');
 await assert.rejects(composeSessionMediaCopy({source:h.session,destination:h.destination,sha256:h.sha256,tracks:[addCue]}),/TIMELINE\/unknown\.sktl: matches no archive part/);await assertNothingPublished(h);
 const media=await composeSessionMediaCopy({source:h.session,destination:h.destination,sha256:h.sha256,media:[{source:h.source}]});
 assert.equal(media.workingFiles.entries.find(e=>e.path==='TIMELINE/unknown.sktl').action,'copied');
 assert.deepEqual(await tree(path.join(media.destination,'TIMELINE')),await tree(path.join(h.session,'TIMELINE')));
 // A diverged session.skf blocks patch changes.
 const p=await fixture(t);await writeFile(path.join(p.session,'session.skf'),patch.replace('old','unsaved'));
 await assert.rejects(composeSessionMediaCopy({source:p.session,destination:p.destination,sha256:p.sha256,patchOperations:[{kind:'setting',nodeId:'n1',key:'level',value:'new'}]}),/session\.skf: differs from patch\.skf/);
 await assertNothingPublished(p);
 assert.deepEqual(await tree(f.session),{...before,'TIMELINE/A.sktl':sha(timeline('A').replace('Layer 1','Edited'))});
});

test('rejects symlinks and special entries in the working tree unless omitted',async t=>{
 const f=await fixture(t);await symlink('/etc/hosts',path.join(f.session,'TIMELINE','link.sktl'));
 const args={source:f.session,destination:f.destination,sha256:f.sha256,media:[{source:f.source}]};
 await assert.rejects(composeSessionMediaCopy(args),/TIMELINE\/link\.sktl: is a symlink/);await assertNothingPublished(f);
 const r=await composeSessionMediaCopy({...args,omitUnverifiedWorkingFiles:true});
 assert.equal(r.workingFiles.entries.find(e=>e.path==='TIMELINE/link.sktl').reason,'symlink');
 await assert.rejects(lstat(path.join(f.destination,'TIMELINE','link.sktl')));
});

test('a session without working files gains none',async t=>{
 const f=await fixture(t,{working:false});
 const r=await composeSessionMediaCopy({source:f.session,destination:f.destination,sha256:f.sha256,media:[{source:f.source}],tracks:[addCue,{templateName:'content/Empty.sktl',trackName:'New',partName:'content/New.sktl'}]});
 assert.deepEqual(r.workingFiles.entries,[]);assert.deepEqual((await readdir(f.destination)).sort(),['MEDIA','session.skshow']);
});

test('publication rejects an existing destination and a claim changed before the identity check',async t=>{
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-publish-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const stage=path.join(dir,'stage'),target=path.join(dir,'target');
 await mkdir(stage);await writeFile(path.join(stage,'session.skshow'),'x');
 // The hazard: plain rename(2) replaces an empty directory.
 const probe=path.join(dir,'probe');await mkdir(probe);await mkdir(path.join(dir,'probe-src'));await rename(path.join(dir,'probe-src'),probe);
 await mkdir(target);const claimed=await lstat(target);
 await assert.rejects(publishDirectory(stage,target),/already exists/);
 assert.equal((await lstat(target)).ino,claimed.ino);assert.deepEqual(await readdir(target),[]);
 assert.deepEqual(await readdir(stage),['session.skshow']);
 await rm(target,{recursive:true});
 // Another process replaces the empty claim before the rename.
 let claim=await claimDestination(target);await rmdir(target);await mkdir(target);const theirs=await lstat(target);
 await assert.rejects(publishDirectory(stage,target,claim),/changed during publication/);
 assert.equal((await lstat(target)).ino,theirs.ino);assert.deepEqual(await readdir(stage),['session.skshow']);
 // Another process writes into the claim before the rename.
 await rm(target,{recursive:true});claim=await claimDestination(target);await writeFile(path.join(target,'theirs'),'keep');
 await assert.rejects(publishDirectory(stage,target,claim),/changed during publication/);
 assert.equal(await readFile(path.join(target,'theirs'),'utf8'),'keep');assert.deepEqual(await readdir(stage),['session.skshow']);
 await rm(target,{recursive:true});await publishDirectory(stage,target);
 assert.deepEqual(await readdir(target),['session.skshow']);await assert.rejects(access(stage));
});
