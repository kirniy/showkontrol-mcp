import os from 'node:os';
import path from 'node:path';
import {constants} from 'node:fs';
import {lstat,lutimes,mkdir,open,readdir,readFile,readlink,realpath,rename,rm,rmdir,unlink,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';

// Session staging lives in one owner-recorded wrapper directory beside the destination:
//   .showkontrol-session-staging-<token>/owner.json  who created it (host, boot, pid, process token, wrapper inode)
//   .../claim.json                                    fallback publication only: the destination claimed with mkdir
//   .../work/  .../session/                           intermediate archives, and the session renamed to the destination
export const STAGING_PREFIX='.showkontrol-session-staging-';
// A removal first renames the wrapper to <name>.removing-<16 hex>; the owner record still verifies it there.
const STAGING_NAME=/^\.showkontrol-session-staging-([0-9a-f]{32})(\.removing-[0-9a-f]{16})?$/;
// Names used by versions before owner records; they cannot be attributed to a call.
const LEGACY_NAME=/^\.showkontrol-session-(?:work-)?[A-Za-z0-9]{6}$/;
const OWNER='owner.json',CLAIM='claim.json',RECORD='session-staging',TOOL='showkontrol-mcp';
const MAX_RECORD=4096,MAX_LISTED=200,MAX_WALK=10000;
export const HEARTBEAT_MS=15000;
// A wrapper is stale only when its owner process is gone and its record has not been touched for this long.
export const STALE_AFTER_MS=120000;
const PROCESS_TOKEN=randomBytes(16).toString('hex');
const active=new Set(),identities=new WeakMap();
const errnoName=code=>Object.entries(os.constants.errno).find(([,n])=>n===code)?.[0]??`errno ${code}`;

// ---- No-replace rename -------------------------------------------------------
// Node's fs.rename is rename(2), which replaces an empty destination directory. Linux renameat2(RENAME_NOREPLACE)
// and macOS renamex_np(RENAME_EXCL) fail with EEXIST instead, atomically. Node exposes neither; the experimental
// built-in node:ffi can call them without an addon. Node.js 26.1.0 to 26.8.1 provide node:ffi only in builds with
// FFI support and only when the process is started with --experimental-ffi; the flag is never added here.
let bound,override;
export function setNoReplaceRenameForTests(value){override=value;}
const FFI_FLAG='--experimental-ffi',NO_FFI_FLAG='--no-experimental-ffi';
const cString=file=>{if(file.includes('\0'))throw Error('Path contains a NUL byte');return Buffer.concat([Buffer.from(file),Buffer.alloc(1)]);};
// Facts about this process that decide why node:ffi is missing. Flags are looked up in execArgv and NODE_OPTIONS.
export function ffiRuntimeFacts(){
 const flags=[...process.execArgv,...(process.env.NODE_OPTIONS??'').split(/\s+/)];
 const last=flags.filter(flag=>flag===FFI_FLAG||flag===NO_FFI_FLAG).at(-1);
 return {version:process.version,getBuiltinModule:typeof process.getBuiltinModule==='function',flagKnown:process.allowedNodeEnvironmentFlags?.has(FFI_FLAG)??false,flag:last===FFI_FLAG?'enabled':last===NO_FFI_FLAG?'disabled':'absent',permissionModel:!!process.permission};
}
// Why node:ffi could not be loaded, from the runtime's own option list rather than its version.
export function ffiUnavailableReason(facts,error){
 const code=error?` (${error.code||error.message})`:'';
 if(!facts.getBuiltinModule)return `node:ffi cannot be loaded: Node.js ${facts.version} has no process.getBuiltinModule`;
 if(!facts.flagKnown)return `node:ffi is not available in Node.js ${facts.version}: this runtime does not accept the ${FFI_FLAG} option, so it has no node:ffi (Node.js before 26.1.0, or a build without FFI support)${code}`;
 if(facts.flag==='disabled')return `node:ffi is disabled by ${NO_FFI_FLAG} in this process${code}`;
 if(facts.flag==='absent')return `node:ffi is not enabled in this process: Node.js ${facts.version} accepts ${FFI_FLAG} and provides node:ffi only when started with it (node ${FFI_FLAG} server.js)${code}`;
 return `node:ffi could not be loaded although ${FFI_FLAG} was given${facts.permissionModel?'; the permission model also requires --allow-ffi':''}${code}`;
}
function bindNative(){
 if(process.platform!=='linux'&&process.platform!=='darwin')return {reason:`no no-replace rename binding for platform ${process.platform}`};
 let ffi;
 try{ffi=process.getBuiltinModule?.('node:ffi');}catch(error){return {reason:ffiUnavailableReason(ffiRuntimeFacts(),error)};}
 if(!ffi)return {reason:ffiUnavailableReason(ffiRuntimeFacts())};
 try{
  const lib=new ffi.DynamicLibrary(null);
  if(process.platform==='linux'){
   // int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags); glibc 2.28+
   const call=lib.getFunction('renameat2',{arguments:['int32','buffer','int32','buffer','uint32'],return:'int32'}),errno=lib.getFunction('__errno_location',{arguments:[],return:'pointer'});
   const AT_FDCWD=-100,RENAME_NOREPLACE=1;
   return {method:'renameat2_noreplace',rename:(from,to)=>call(AT_FDCWD,cString(from),AT_FDCWD,cString(to),RENAME_NOREPLACE)===0?0:ffi.getInt32(errno())};
  }
  // int renamex_np(const char *from, const char *to, unsigned int flags); macOS 10.12+
  const call=lib.getFunction('renamex_np',{arguments:['buffer','buffer','uint32'],return:'int32'}),errno=lib.getFunction('__error',{arguments:[],return:'pointer'});
  const RENAME_EXCL=4;
  return {method:'renamex_np_excl',rename:(from,to)=>call(cString(from),cString(to),RENAME_EXCL)===0?0:ffi.getInt32(errno())};
 }catch(error){return {reason:`node:ffi could not bind the no-replace rename: ${error.code||error.message}${error.code==='ERR_ACCESS_DENIED'?' (the permission model requires --allow-ffi)':''}`};}
}
function nativeRename(){
 if(override!==undefined)return override??{reason:'no-replace rename disabled for this test'};
 return bound??=bindNative();
}
// Exercise the primitive on the destination volume: it must refuse an existing empty directory with EEXIST
// and leave both entries, and move a directory to an absent name in another directory. errno is read in a second
// native call after the rename returns; if anything in between overwrote it, the probe fails and the fallback is used.
async function probe(dir,primitive){
 const root=path.join(dir,'probe'),a=path.join(root,'a'),b=path.join(root,'b'),c=path.join(root,'c','moved');
 await mkdir(root);await mkdir(a);await mkdir(b);await mkdir(path.dirname(c));
 try{
  const ai=(await lstat(a)).ino,bi=(await lstat(b)).ino,refused=primitive.rename(a,b);
  if(refused===0)return 'the rename replaced an existing empty directory; the no-replace flag is not honoured on this volume';
  if(errnoName(refused)!=='EEXIST')return `the rename failed with ${errnoName(refused)} instead of EEXIST on this volume`;
  if((await lstat(a)).ino!==ai||(await lstat(b)).ino!==bi)return 'a refused rename changed an entry';
  const moved=primitive.rename(a,c);
  if(moved!==0)return `the rename to an absent name failed with ${errnoName(moved)}`;
  if((await lstat(c)).ino!==ai)return 'the rename did not move the directory';
  return null;
 }finally{await rm(root,{recursive:true,force:true});}
}
// Choose how this staging wrapper's session will be published to target.
export async function publicationMode(dir,target){
 const primitive=nativeRename();
 if(!primitive.rename)return {method:'claim_rename',atomicNoReplace:false,reason:primitive.reason};
 // FFI calls are not checked by the permission model, so the native rename is used only where fs.write is granted.
 const denied=process.permission&&[dir,target].filter(Boolean).find(file=>!process.permission.has('fs.write',file));
 if(denied)return {method:'claim_rename',atomicNoReplace:false,reason:`${primitive.method}: the permission model does not grant fs.write for ${denied}, and a native rename would not be checked by it`};
 let problem;
 try{problem=await probe(dir,primitive);}catch(error){problem=`the probe failed: ${error.code||error.message}`;}
 return problem?{method:'claim_rename',atomicNoReplace:false,reason:`${primitive.method}: ${problem}`}:{method:primitive.method,atomicNoReplace:true,rename:primitive.rename};
}

// ---- Fallback: claim and rename ---------------------------------------------
// mkdir(2) fails if anything exists. Rename over the claim only if it is still that directory. Another process
// can still swap the claim between this check and rename(2).
export async function claimDestination(target){
 try{await mkdir(target);}catch(error){throw error.code==='EEXIST'?Error('Destination session already exists'):error;}
 return lstat(target);
}
export async function publishDirectory(stage,target,claim,{onClaim}={}){
 if(!claim){await onClaim?.({state:'claiming'});claim=await claimDestination(target);await onClaim?.({state:'claimed',ino:claim.ino});}
 const ours=async()=>{try{const now=await lstat(target);return now.isDirectory()&&now.dev===claim.dev&&now.ino===claim.ino;}catch{return false;}};
 if(!await ours())throw Error('Destination session changed during publication');
 try{await rename(stage,target);}
 catch(error){
  if(await ours())await rmdir(target).catch(()=>{});
  throw ['ENOTEMPTY','EEXIST','ENOTDIR','EISDIR'].includes(error.code)?Error('Destination session changed during publication'):error;
 }
}
export async function publishStaged(staging,target,mode){
 if(mode.atomicNoReplace){
  const staged=await lstat(staging.stage),code=mode.rename(staging.stage,target);
  if(code===0)return;
  const name=errnoName(code);
  if(name==='EEXIST'||name==='ENOTEMPTY')throw Error('Destination session already exists; the no-replace rename left it unchanged');
  // Say that nothing was published only while the staged session is still where it was.
  const inPlace=await lstat(staging.stage).then(now=>now.dev===staged.dev&&now.ino===staged.ino,()=>false);
  throw Error(inPlace?`No-replace publication failed with ${name}; nothing was published`:`No-replace publication failed with ${name}, and the staged session is no longer in staging; check the destination`);
 }
 await publishDirectory(staging.stage,target,undefined,{onClaim:state=>recordClaim(staging.dir,target,state)});
 await unlink(path.join(staging.dir,CLAIM)).catch(()=>{});
}

// Written before mkdir (state claiming) and after it with the claim inode (state claimed).
export const recordClaim=(dir,target,state)=>writeRecord(dir,CLAIM,{destinationName:path.basename(target),...state});

// ---- Owner records ----------------------------------------------------------
let identity;
async function hostIdentity(){
 return identity??=(async()=>{
  const id={host:os.hostname(),platform:process.platform};
  if(process.platform==='linux'){
   try{id.bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();}catch{}
   try{id.pidNamespace=await readlink('/proc/self/ns/pid');}catch{}
  }
  return id;
 })();
}
async function writeRecord(dir,name,value){
 const tmp=path.join(dir,`.${name}.${randomBytes(4).toString('hex')}`);
 await writeFile(tmp,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await rename(tmp,path.join(dir,name));
}
export async function createStaging(parent,destinationName){
 const token=randomBytes(16).toString('hex'),dir=path.join(parent,STAGING_PREFIX+token);
 await mkdir(dir,{mode:0o700});
 let timer;
 try{
  const info=await lstat(dir);
  await writeFile(path.join(dir,OWNER),JSON.stringify({tool:TOOL,record:RECORD,format:1,token,ino:info.ino,destinationName,createdAt:new Date().toISOString(),pid:process.pid,processToken:PROCESS_TOKEN,uid:process.getuid?.()??null,...await hostIdentity()})+'\n',{flag:'wx',mode:0o600});
  await mkdir(path.join(dir,'work'),{mode:0o700});await mkdir(path.join(dir,'session'),{mode:0o700});
 }catch(error){await rm(dir,{recursive:true,force:true}).catch(()=>{});throw error;}
 active.add(dir);
 // A live call touches its record, so a cleaner that misjudges the owner process still sees recent activity.
 timer=setInterval(()=>{const now=new Date();lutimes(path.join(dir,OWNER),now,now).catch(()=>{});},HEARTBEAT_MS);timer.unref();
 return {dir,name:path.basename(dir),work:path.join(dir,'work'),stage:path.join(dir,'session'),
  release:async()=>{clearInterval(timer);try{await removeWrapper(dir);}finally{active.delete(dir);}}};
}
// The owner record goes last, so an interrupted removal leaves a wrapper that can still be verified.
async function removeWrapper(dir){
 for(const name of await readdir(dir))if(name!==OWNER)await rm(path.join(dir,name),{recursive:true,force:true});
 await rm(path.join(dir,OWNER),{force:true});await rmdir(dir);
}

// ---- Discovery and cleanup --------------------------------------------------
async function readRecord(file){
 let handle;
 try{handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
 catch(error){return {problem:error.code==='ENOENT'?'missing':`cannot be opened without following symlinks (${error.code})`};}
 try{
  const info=await handle.stat();
  if(!info.isFile())return {problem:'is not a regular file'};
  if(info.size>MAX_RECORD)return {problem:'is too large'};
  try{return {value:JSON.parse((await handle.readFile()).toString('utf8')),info};}catch{return {problem:'is not valid JSON'};}
 }finally{await handle.close();}
}
async function size(dir){
 let bytes=0,entries=0;const pending=[dir];
 while(pending.length){
  const current=pending.pop();
  for(const entry of await readdir(current,{withFileTypes:true}).catch(()=>[])){
   if(++entries>MAX_WALK)return {bytes,truncated:true};
   const file=path.join(current,entry.name);
   if(entry.isDirectory())pending.push(file);
   else if(entry.isFile())bytes+=(await lstat(file).catch(()=>({size:0}))).size;
  }
 }
 return {bytes};
}
function ownerGone(record,now){
 if(record.host!==now.host)return {unknown:`created on host ${JSON.stringify(record.host)}, not this host ${JSON.stringify(now.host)}`};
 if(record.platform!==now.platform)return {unknown:`created on platform ${record.platform}`};
 if(now.platform==='linux'){
  if(typeof record.bootId!=='string'||!now.bootId)return {unknown:'the boot identifier is unknown'};
  if(record.bootId!==now.bootId)return {gone:'the system has restarted since the owner ran'};
  if(record.pidNamespace!==now.pidNamespace)return {unknown:'created in another PID namespace'};
 }
 if(record.pid===process.pid)return record.processToken===PROCESS_TOKEN?{gone:'it was left by a finished call in this server process'}:{gone:'its process ID now belongs to this server process'};
 try{process.kill(record.pid,0);}catch(error){if(error.code==='ESRCH')return {gone:`owner process ${record.pid} is not running`};return {running:`owner process ${record.pid} cannot be checked (${error.code}) and may be running`};}
 return {running:`process ${record.pid} is running; it may be the owner or a reused process ID`};
}
// Verdicts: stale (verified owned by this tool, owner gone, idle), active, or unverified. Only stale is removable.
async function assess(parent,name){
 const dir=path.join(parent,name),entry={name};
 if(LEGACY_NAME.test(name))return {...entry,kind:'legacy',status:'unverified',reason:'created by an earlier version without an owner record; remove it manually once no session copy is running'};
 const [,token,removing]=STAGING_NAME.exec(name)??[];if(!token)return null;
 Object.assign(entry,{kind:'staging',...(removing?{interruptedRemoval:true}:{})});
 const unverified=reason=>({...entry,status:'unverified',reason});
 let info;try{info=await lstat(dir);}catch(error){return unverified(`cannot be checked (${error.code})`);}
 if(info.isSymbolicLink()||!info.isDirectory())return unverified('is not a directory');
 if(process.getuid&&info.uid!==process.getuid())return unverified('is owned by another user');
 const {value:record,info:recordInfo,problem}=await readRecord(path.join(dir,OWNER));
 if(problem)return unverified(`its owner record ${problem}`);
 if(record?.tool!==TOOL||record.record!==RECORD||record.format!==1)return unverified('its owner record is not a session staging record of this tool');
 if(record.token!==token)return unverified('its owner record belongs to another staging directory name');
 if(record.ino!==info.ino)return unverified('it is not the directory its owner record was written for (inode differs)');
 if(!Number.isSafeInteger(record.pid)||record.pid<1||typeof record.host!=='string'||typeof record.processToken!=='string')return unverified('its owner record is incomplete');
 Object.assign(entry,{destinationName:record.destinationName,createdAt:record.createdAt,owner:{host:record.host,pid:record.pid},idleMs:Math.max(0,Math.round(Date.now()-recordInfo.mtimeMs))});
 const claimRecord=await readRecord(path.join(dir,CLAIM));
 if(claimRecord.value||claimRecord.problem!=='missing')entry.claim=await assessClaim(parent,record,claimRecord);
 if(active.has(dir))return {...entry,status:'active',reason:'a call in this server process is using it'};
 const verdict=ownerGone(record,await hostIdentity());
 if(verdict.unknown)return unverified(`${verdict.unknown}; whether its owner is running cannot be checked`);
 if(verdict.running)return {...entry,status:'active',reason:verdict.running};
 if(entry.idleMs<STALE_AFTER_MS)return {...entry,status:'active',reason:`${verdict.gone}, but its record was touched ${Math.round(entry.idleMs/1000)} s ago`};
 const stale={...entry,status:'stale',reason:verdict.gone,...await size(dir)};
 identities.set(stale,{dev:info.dev,ino:info.ino});
 return stale;
}
// The fallback claims the destination with an empty directory. It is ours only while it is the recorded inode and empty.
async function assessClaim(parent,record,{value,problem}){
 if(problem)return {status:'unverified',reason:`claim record ${problem}`};
 if(value?.destinationName!==record.destinationName||typeof value.destinationName!=='string'||!value.destinationName||value.destinationName.includes('/'))return {status:'unverified',reason:'claim record does not match the owner record'};
 const claim={name:value.destinationName};
 if(value.state!=='claimed'||!Number.isSafeInteger(value.ino))return {...claim,status:'unverified',reason:'the claim inode was not recorded; the destination may be an empty directory left by this call'};
 let info;try{info=await lstat(path.join(parent,value.destinationName));}catch(error){return {...claim,status:error.code==='ENOENT'?'absent':'unverified',...(error.code==='ENOENT'?{}:{reason:error.code})};}
 if(!info.isDirectory()||info.isSymbolicLink()||info.ino!==value.ino)return {...claim,status:'replaced',reason:'the destination is not the claimed directory; it is kept'};
 if((await readdir(path.join(parent,value.destinationName))).length)return {...claim,status:'not_empty',reason:'the claimed directory has entries; it is kept'};
 return {...claim,status:'empty_claim',ino:value.ino};
}
async function listDirectory(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('Directory must be an absolute path');
 return realpath(directory);
}
export async function findSessionStaging({directory}){
 const parent=await listDirectory(directory),entries=[];let truncated=false;
 for(const name of (await readdir(parent)).sort()){
  const entry=await assess(parent,name);if(!entry)continue;
  if(entries.length>=MAX_LISTED){truncated=true;break;}
  entries.push(entry);
 }
 return {directory:parent,entries,...(truncated?{truncated}:{}),staleAfterMs:STALE_AFTER_MS,
  note:'Only entries with status stale can be removed with showkontrol_remove_stale_session_staging: a directory created by this tool whose owner record matches its name and inode, whose owner process is gone on this host, and whose record has been idle for staleAfterMs. Legacy and unverified entries are never removed by the tool.'};
}
let beforeRemoval;
// Runs after an entry is verified and before it is moved, to reproduce a concurrent replacement in tests.
export function setBeforeRemovalForTests(hook){beforeRemoval=hook;}
export async function removeStaleSessionStaging({directory,names}){
 const parent=await listDirectory(directory);
 if(!Array.isArray(names)||!names.length||names.length>100||new Set(names).size!==names.length)throw Error('Names must list 1 to 100 distinct staging directory names');
 for(const name of names)if(typeof name!=='string'||!STAGING_NAME.test(name))throw Error(`Not a session staging directory name of this tool: ${JSON.stringify(name)}`);
 const removed=[],kept=[];
 for(const name of names){
  // Verified again immediately before removal.
  const entry=await assess(parent,name);
  if(entry?.status!=='stale'){kept.push({name,status:entry?.status??'unverified',reason:entry?.reason});continue;}
  const report={name,bytes:entry.bytes,...(entry.truncated?{bytesTruncated:true}:{})};
  // Move the verified wrapper to a fresh name and check that the moved entry is still that directory, so a
  // directory or symlink put at its name after verification is not emptied. rename(2) moves a symlink itself.
  const verified=identities.get(entry),from=path.join(parent,name);
  await beforeRemoval?.({parent,name,entry});
  const tomb=path.join(parent,`${STAGING_PREFIX}${STAGING_NAME.exec(name)[1]}.removing-${randomBytes(8).toString('hex')}`);
  try{await rename(from,tomb);}
  catch(error){kept.push({name,status:'stale',reason:`removal failed: ${error.code||error.message}`});continue;}
  const moved=await lstat(tomb).catch(()=>null);
  if(!moved?.isDirectory()||moved.dev!==verified.dev||moved.ino!==verified.ino){
   // Put it back unless something has taken the name meanwhile.
   const back=await lstat(from).then(()=>false,error=>error.code==='ENOENT'&&rename(tomb,from).then(()=>true,()=>false));
   kept.push({name,status:'changed',reason:`the entry was replaced after verification; nothing was removed${back?'':`, and it was left at ${path.basename(tomb)}`}`});
   continue;
  }
  report.removedAs=path.basename(tomb);
  if(entry.claim?.status==='empty_claim'){
   const file=path.join(parent,entry.claim.name),info=await lstat(file).catch(()=>null);
   // rmdir(2) removes only an empty directory.
   // A different empty directory put there after this check would be removed; nothing with entries can be.
   report.claim=info?.isDirectory()&&info.dev===verified.dev&&info.ino===entry.claim.ino
    ?await rmdir(file).then(()=>({name:entry.claim.name,action:'removed'}),error=>({name:entry.claim.name,action:'kept',reason:error.code}))
    :{name:entry.claim.name,action:'kept',status:'changed'};
  }else if(entry.claim)report.claim={name:entry.claim.name,action:'kept',status:entry.claim.status};
  try{await removeWrapper(tomb);removed.push(report);}
  catch(error){kept.push({name:path.basename(tomb),status:'stale',reason:`removal failed: ${error.code||error.message}; it can be removed again under this name`});}
 }
 return {directory:parent,removed,kept};
}
// For a rejected destination: the stale staging directory whose empty claim occupies it, if any.
export async function staleClaimOf(parent,destinationName){
 for(const name of await readdir(parent).catch(()=>[])){
  if(!STAGING_NAME.test(name))continue;
  const entry=await assess(parent,name);
  if(entry?.status==='stale'&&entry.claim?.status==='empty_claim'&&entry.claim.name===destinationName)return name;
 }
}
