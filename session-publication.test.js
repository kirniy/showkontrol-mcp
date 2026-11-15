import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink,rm,rename,lstat,access,realpath,utimes,cp} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';import os from 'node:os';
import {composeSessionMediaCopy} from './session-media-copy.js';
import {createStaging,publicationMode,publishStaged,findSessionStaging,removeStaleSessionStaging,setNoReplaceRenameForTests,STAGING_PREFIX,STALE_AFTER_MS} from './session-publication.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const part=(name,value)=>`<part name="${name}" md5="${createHash('md5').update(value).digest('hex')}">${Buffer.from(value).toString('base64')}</part>`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const errno=os.constants.errno;
const moduleUrl=pathToFileURL(path.resolve('session-publication.js')).href;
const ffi=(()=>{try{return process.getBuiltinModule?.('node:ffi');}catch{}})();

// A real RENAME_NOREPLACE through Python ctypes, to exercise the publication path on runtimes without node:ffi.
const PY='import ctypes,os,sys\nf=ctypes.CDLL(None,use_errno=True).renameat2\nf.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\nprint(0 if f(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),1)==0 else ctypes.get_errno())';
const python=(()=>{if(process.platform!=='linux')return false;try{execFileSync('python3',['-I','-c','import ctypes;ctypes.CDLL(None).renameat2']);return true;}catch{return false;}})();
const pyRename=(from,to)=>Number(execFileSync('python3',['-I','-c',PY,from,to],{encoding:'utf8'}).trim());
const realPrimitive={method:'renameat2_noreplace_python_test',rename:pyRename};

async function fixture(t){
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-publication-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const session=path.join(dir,'Session A');await mkdir(path.join(session,'MEDIA'),{recursive:true});
 await writeFile(path.join(session,'MEDIA','old.wav'),'RIFF-old');
 const show=`<skshow>${part('media.map','/orig/old.wav\tMEDIA/old.wav\n')}${part('content/A.sktl','<sktimeline version="1"><layers/><deck/></sktimeline>')}</skshow>`;
 await writeFile(path.join(session,'session.skshow'),show);
 const source=path.join(dir,'Kick.wav');await writeFile(source,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(5000,7)]));
 return {dir,session,source,sha256:sha(show),destination:path.join(dir,'Session B'),args:{source:session,destination:path.join(dir,'Session B'),sha256:sha(show),media:[{source}]}};
}
const temps=async dir=>(await readdir(dir)).filter(n=>n.startsWith('.showkontrol'));
const age=async(dir,name,ms)=>{const when=new Date(Date.now()-ms);await utimes(path.join(dir,name,'owner.json'),when,when);};
// A child server process that stages and is killed, as by a crash or force quit.
function child(script,{wait=false}={}){
 const proc=spawn(process.execPath,['--input-type=module','-e',`import * as m from ${JSON.stringify(moduleUrl)};${script}`],{stdio:['ignore','pipe','inherit']});
 return new Promise((resolve,reject)=>{
  let out='';proc.stdout.on('data',d=>{out+=d;if(wait&&out.includes('\n'))resolve({proc,name:out.trim()});});
  proc.on('exit',(code,signal)=>wait?reject(Error(`child exited ${code??signal}`)):resolve({code,signal,name:out.trim()}));
 });
}

test('this runtime: node:ffi no-replace rename when available, otherwise the claim fallback with its reason',async t=>{
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-publication-runtime-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const staging=await createStaging(dir,'Target');t.after(()=>staging.release().catch(()=>{}));
 const mode=await publicationMode(staging.dir);
 t.diagnostic(`Node.js ${process.version} ${process.platform}: ${mode.method}${mode.reason?` (${mode.reason})`:''}`);
 if(process.env.SHOWKONTROL_EXPECT_ATOMIC_PUBLICATION==='1')assert.equal(mode.atomicNoReplace,true,mode.reason);
 if(!ffi){assert.equal(mode.method,'claim_rename');assert.match(mode.reason,/node:ffi is not available/);return;}
 if(!mode.atomicNoReplace){assert.match(mode.reason,/renameat2|renamex_np|node:ffi/);return;}
 assert.equal(mode.method,process.platform==='darwin'?'renamex_np_excl':'renameat2_noreplace');
 // The hazard of rename(2): an empty directory at the destination. The no-replace rename must leave it.
 const target=path.join(dir,'Target');await mkdir(target);const theirs=(await lstat(target)).ino;
 await writeFile(path.join(staging.stage,'session.skshow'),'x');
 await assert.rejects(publishStaged(staging,target,mode),/already exists; the no-replace rename left it unchanged/);
 assert.equal((await lstat(target)).ino,theirs);assert.deepEqual(await readdir(target),[]);
 await rm(target,{recursive:true});await publishStaged(staging,target,mode);
 assert.deepEqual(await readdir(target),['session.skshow']);await assert.rejects(access(staging.stage));
});

test('the probe rejects a primitive that replaces, or refuses with another error, and keeps the claim fallback',async t=>{
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-publication-probe-')));t.after(()=>{setNoReplaceRenameForTests(undefined);return rm(dir,{recursive:true,force:true});});
 const staging=await createStaging(dir,'Target');t.after(()=>staging.release().catch(()=>{}));
 setNoReplaceRenameForTests({method:'plain',rename:(a,b)=>{renameSync(a,b);return 0;}});
 assert.deepEqual(await publicationMode(staging.dir),{method:'claim_rename',atomicNoReplace:false,reason:'plain: the rename replaced an existing empty directory; the no-replace flag is not honoured on this volume'});
 setNoReplaceRenameForTests({method:'unsupported',rename:()=>errno.EINVAL});
 assert.match((await publicationMode(staging.dir)).reason,/^unsupported: the rename failed with EINVAL instead of EEXIST/);
 setNoReplaceRenameForTests({method:'thrown',rename:()=>{throw Error('boom');}});
 assert.match((await publicationMode(staging.dir)).reason,/^thrown: the probe failed: boom/);
 setNoReplaceRenameForTests(null);
 assert.equal((await publicationMode(staging.dir)).method,'claim_rename');
 // Probe entries are removed whatever the outcome.
 assert.deepEqual((await readdir(staging.dir)).sort(),['owner.json','session','work']);
 if(python){setNoReplaceRenameForTests(realPrimitive);const mode=await publicationMode(staging.dir);assert.equal(mode.atomicNoReplace,true,mode.reason);}
});

test('a real RENAME_NOREPLACE publishes the session and refuses a destination created just before the rename',{skip:!python&&'needs Linux python3 ctypes renameat2'},async t=>{
 t.after(()=>setNoReplaceRenameForTests(undefined));
 const f=await fixture(t);setNoReplaceRenameForTests(realPrimitive);
 const r=await composeSessionMediaCopy(f.args);
 assert.deepEqual(r.publication,{method:'renameat2_noreplace_python_test',atomicNoReplace:true,note:r.publication.note});
 assert.match(r.publication.note,/no-replace rename/);
 assert.deepEqual((await readdir(f.destination)).sort(),['MEDIA','session.skshow']);
 assert.deepEqual(await temps(f.dir),[]);
 // Another process creates an empty directory at the destination immediately before the publication rename.
 const other=path.join(f.dir,'Session C');let theirs;
 setNoReplaceRenameForTests({method:'race',rename:(from,to)=>{if(to===other){execFileSync('mkdir',[other]);theirs=execFileSync('stat',['-c','%i',other],{encoding:'utf8'}).trim();}return pyRename(from,to);}});
 await assert.rejects(composeSessionMediaCopy({...f.args,destination:other}),/Destination session already exists; the no-replace rename left it unchanged/);
 assert.equal(String((await lstat(other)).ino),theirs);assert.deepEqual(await readdir(other),[]);
 assert.deepEqual(await temps(f.dir),[]);
});

test('requireAtomicPublication fails before copying when only the fallback is available; the fallback is reported',async t=>{
 t.after(()=>setNoReplaceRenameForTests(undefined));
 const f=await fixture(t);setNoReplaceRenameForTests(null);
 await assert.rejects(composeSessionMediaCopy({...f.args,requireAtomicPublication:true}),/^Error: Atomic no-replace publication is unavailable: no-replace rename disabled for this test$/);
 await assert.rejects(access(f.destination));assert.deepEqual(await temps(f.dir),[]);
 await assert.rejects(composeSessionMediaCopy({...f.args,requireAtomicPublication:'yes'}),/requireAtomicPublication must be a boolean/);
 const r=await composeSessionMediaCopy(f.args);
 assert.equal(r.publication.method,'claim_rename');assert.equal(r.publication.atomicNoReplace,false);
 assert.equal(r.publication.fallbackReason,'no-replace rename disabled for this test');
 assert.match(r.publication.note,/replaced without detection/);
 assert.deepEqual(await temps(f.dir),[]);
});

test('a killed call leaves a verified wrapper: active while recently touched, then stale, reported by the next call and removable',async t=>{
 const f=await fixture(t);
 const {signal,name}=await child(`const s=await m.createStaging(${JSON.stringify(f.dir)},'Session B');await (await import('node:fs/promises')).writeFile(s.stage+'/big.wav',Buffer.alloc(70000));console.log(s.name);process.kill(process.pid,'SIGKILL');`);
 assert.equal(signal,'SIGKILL');assert.ok(name.startsWith(STAGING_PREFIX));
 let [entry]=(await findSessionStaging({directory:f.dir})).entries;
 assert.equal(entry.status,'active');assert.match(entry.reason,/is not running, but its record was touched \d+ s ago/);
 await assert.deepEqual((await removeStaleSessionStaging({directory:f.dir,names:[name]})).removed,[]);
 await age(f.dir,name,STALE_AFTER_MS+1000);
 [entry]=(await findSessionStaging({directory:f.dir})).entries;
 assert.equal(entry.status,'stale');assert.equal(entry.kind,'staging');assert.equal(entry.destinationName,'Session B');assert.match(entry.reason,/owner process \d+ is not running|restarted/);
 assert.ok(entry.bytes>=70000);
 const r=await composeSessionMediaCopy({...f.args,destination:path.join(f.dir,'Other')});
 assert.deepEqual(r.warnings.find(w=>w.code==='stale_session_staging'),{code:'stale_session_staging',directory:f.dir,names:[name],bytes:entry.bytes,message:r.warnings.find(w=>w.code==='stale_session_staging').message});
 assert.deepEqual(await temps(f.dir),[name]);
 assert.deepEqual(await removeStaleSessionStaging({directory:f.dir,names:[name]}),{directory:f.dir,removed:[{name,bytes:entry.bytes}],kept:[]});
 assert.deepEqual(await temps(f.dir),[]);
});

test('a running owner keeps its wrapper even when its record looks idle; this process\'s own calls are active',async t=>{
 const f=await fixture(t);
 const {proc,name}=await child(`const s=await m.createStaging(${JSON.stringify(f.dir)},'Session B');console.log(s.name);setInterval(()=>{},1000);`,{wait:true});
 t.after(()=>proc.kill('SIGKILL'));
 await age(f.dir,name,STALE_AFTER_MS*10);
 let [entry]=(await findSessionStaging({directory:f.dir})).entries;
 assert.equal(entry.status,'active');assert.match(entry.reason,new RegExp(`process ${proc.pid} is running`));
 assert.deepEqual((await removeStaleSessionStaging({directory:f.dir,names:[name]})).kept,[{name,status:'active',reason:entry.reason}]);
 const exited=new Promise(resolve=>proc.on('exit',resolve));proc.kill('SIGKILL');await exited;await age(f.dir,name,STALE_AFTER_MS*10);
 assert.equal((await findSessionStaging({directory:f.dir})).entries[0].status,'stale');
 const own=await createStaging(f.dir,'Mine');
 const mine=(await findSessionStaging({directory:f.dir})).entries.find(e=>e.name===own.name);
 assert.deepEqual([mine.status,mine.reason],['active','a call in this server process is using it']);
 await own.release();assert.deepEqual(await temps(f.dir),[name]);
});

test('fallback crash between claim and rename: the empty claim is named in the error and removed with its wrapper',async t=>{
 const f=await fixture(t);
 const script=`const s=await m.createStaging(${JSON.stringify(f.dir)},'Session B');console.log(s.name);
await m.publishDirectory(s.stage,${JSON.stringify(f.destination)},undefined,{onClaim:async st=>{await m.recordClaim(s.dir,${JSON.stringify(f.destination)},st);if(st.state==='claimed')process.kill(process.pid,'SIGKILL');}});`;
 const {signal,name}=await child(script);assert.equal(signal,'SIGKILL');
 assert.deepEqual(await readdir(f.destination),[]);
 await assert.rejects(composeSessionMediaCopy(f.args),/^Error: Destination session already exists$/);
 await age(f.dir,name,STALE_AFTER_MS+1000);
 const [entry]=(await findSessionStaging({directory:f.dir})).entries;
 assert.deepEqual(entry.claim,{name:'Session B',status:'empty_claim',ino:(await lstat(f.destination)).ino});
 await assert.rejects(composeSessionMediaCopy(f.args),new RegExp(`empty claim of an interrupted call \\(staging ${name}\\); remove both with showkontrol_remove_stale_session_staging`));
 const removed=await removeStaleSessionStaging({directory:f.dir,names:[name]});
 assert.deepEqual(removed.removed.map(r=>[r.name,r.claim]),[[name,{name:'Session B',action:'removed'}]]);
 await assert.rejects(access(f.destination));assert.deepEqual(await temps(f.dir),[]);
 assert.deepEqual((await readdir((await composeSessionMediaCopy(f.args)).destination)).sort(),['MEDIA','session.skshow']);
});

test('a claim that has entries or was replaced is kept; only the wrapper is removed',async t=>{
 const f=await fixture(t),names=[];
 for(const destination of ['Kept','Swapped']){
  const target=path.join(f.dir,destination);
  const {name}=await child(`const s=await m.createStaging(${JSON.stringify(f.dir)},${JSON.stringify(destination)});console.log(s.name);
await m.publishDirectory(s.stage,${JSON.stringify(target)},undefined,{onClaim:async st=>{await m.recordClaim(s.dir,${JSON.stringify(target)},st);if(st.state==='claimed')process.kill(process.pid,'SIGKILL');}});`);
  names.push(name);await age(f.dir,name,STALE_AFTER_MS+1000);
 }
 await writeFile(path.join(f.dir,'Kept','user.txt'),'keep');
 await rm(path.join(f.dir,'Swapped'),{recursive:true});await mkdir(path.join(f.dir,'Swapped'));
 const found=Object.fromEntries((await findSessionStaging({directory:f.dir})).entries.map(e=>[e.destinationName,e.claim.status]));
 assert.deepEqual(found,{Kept:'not_empty',Swapped:'replaced'});
 const r=await removeStaleSessionStaging({directory:f.dir,names});
 assert.deepEqual(r.removed.map(x=>x.claim.action),['kept','kept']);
 assert.equal(await readFile(path.join(f.dir,'Kept','user.txt'),'utf8'),'keep');await access(path.join(f.dir,'Swapped'));
 assert.deepEqual(await temps(f.dir),[]);
});

test('legacy, copied, recreated, symlinked, foreign-host and recordless directories are never removed',async t=>{
 const f=await fixture(t);
 const {name}=await child(`const s=await m.createStaging(${JSON.stringify(f.dir)},'Session B');console.log(s.name);process.kill(process.pid,'SIGKILL');`);
 await age(f.dir,name,STALE_AFTER_MS+1000);
 const token=()=>STAGING_PREFIX+createHash('md5').update(String(Math.random())).digest('hex');
 const copied=token(),recreated=token(),linked=token(),foreign=token(),recordless=token();
 await cp(path.join(f.dir,name),path.join(f.dir,copied),{recursive:true});
 // Same name and record, another directory.
 await cp(path.join(f.dir,name),path.join(f.dir,recreated),{recursive:true});
 const record=JSON.parse(await readFile(path.join(f.dir,name,'owner.json'),'utf8'));
 await writeFile(path.join(f.dir,recreated,'owner.json'),JSON.stringify({...record,token:recreated.slice(STAGING_PREFIX.length)}));
 await symlink(path.join(f.dir,name),path.join(f.dir,linked));
 await mkdir(path.join(f.dir,foreign));
 await writeFile(path.join(f.dir,foreign,'owner.json'),JSON.stringify({...record,token:foreign.slice(STAGING_PREFIX.length),ino:(await lstat(path.join(f.dir,foreign))).ino,host:'another-mac.local'}));
 await mkdir(path.join(f.dir,recordless));
 for(const legacy of ['.showkontrol-session-abc123','.showkontrol-session-work-XYZ789'])await mkdir(path.join(f.dir,legacy));
 const found=Object.fromEntries((await findSessionStaging({directory:f.dir})).entries.map(e=>[e.name,[e.status,e.reason]]));
 assert.equal(found[name][0],'stale');
 assert.deepEqual(found[copied],['unverified','its owner record belongs to another staging directory name']);
 assert.deepEqual(found[recreated],['unverified','it is not the directory its owner record was written for (inode differs)']);
 assert.deepEqual(found[linked],['unverified','is not a directory']);
 assert.match(found[foreign][1],/^created on host "another-mac.local", not this host .*; whether its owner is running cannot be checked$/);
 assert.deepEqual(found[recordless],['unverified','its owner record missing']);
 assert.equal(found['.showkontrol-session-abc123'][0],'unverified');assert.match(found['.showkontrol-session-work-XYZ789'][1],/earlier version without an owner record/);
 await assert.rejects(removeStaleSessionStaging({directory:f.dir,names:['.showkontrol-session-abc123']}),/Not a session staging directory name/);
 await assert.rejects(removeStaleSessionStaging({directory:f.dir,names:['../x']}),/Not a session staging directory name/);
 const r=await removeStaleSessionStaging({directory:f.dir,names:[copied,recreated,linked,foreign,recordless,name]});
 assert.deepEqual(r.removed.map(x=>x.name),[name]);
 assert.deepEqual(r.kept.map(x=>[x.name,x.status]),[copied,recreated,linked,foreign,recordless].map(n=>[n,'unverified']));
 assert.deepEqual((await temps(f.dir)).sort(),[copied,recreated,linked,foreign,recordless,'.showkontrol-session-abc123','.showkontrol-session-work-XYZ789'].sort());
 // The symlink target was not followed.
 await assert.rejects(access(path.join(f.dir,name)));assert.equal((await lstat(path.join(f.dir,linked))).isSymbolicLink(),true);
});

test('MCP lists and removes stale staging and exposes requireAtomicPublication',async t=>{
 const f=await fixture(t);
 const {name}=await child(`const s=await m.createStaging(${JSON.stringify(f.dir)},'Session B');console.log(s.name);process.kill(process.pid,'SIGKILL');`);
 await age(f.dir,name,STALE_AFTER_MS+1000);
 const client=new Client({name:'publication-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=async(tool,args)=>{const r=await client.callTool({name:tool,arguments:args});assert.equal(r.isError,undefined,r.content?.[0]?.text);return JSON.parse(r.content[0].text);};
 const found=await call('showkontrol_find_session_staging',{directory:f.dir});
 assert.deepEqual(found.entries.map(e=>[e.name,e.status]),[[name,'stale']]);
 const bad=await client.callTool({name:'showkontrol_remove_stale_session_staging',arguments:{directory:f.dir,names:['Session A']}});assert.equal(bad.isError,true);assert.match(bad.content[0].text,/Not a session staging directory name/);
 assert.deepEqual((await call('showkontrol_remove_stale_session_staging',{directory:f.dir,names:[name]})).removed.map(r=>r.name),[name]);
 const tools=(await client.listTools()).tools;
 assert.equal(tools.find(x=>x.name==='showkontrol_compose_session_media_copy').inputSchema.properties.requireAtomicPublication.type,'boolean');
 assert.equal(tools.find(x=>x.name==='showkontrol_find_session_staging').annotations.readOnlyHint,true);
 assert.equal(tools.find(x=>x.name==='showkontrol_remove_stale_session_staging').annotations.destructiveHint,true);
 const r=await call('showkontrol_compose_session_media_copy',{...f.args});
 assert.equal(typeof r.publication.atomicNoReplace,'boolean');
});
