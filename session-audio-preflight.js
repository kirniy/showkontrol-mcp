// Read-only preflight of the media behind session audio clips. Nothing is written; trims are reported, not judged.
import path from 'node:path';
import {open,stat,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {inspectSessionMedia,sidecarStatus} from './session-media.js';

const MAX_PATHS=1000, MAX_PATH_CHARS=4096, MAX_SHOWN_CHARS=256, CONCURRENCY=4;
const MAX_STDOUT=64*1024, MAX_STDERR=16*1024, MAX_WARNINGS=5, MAX_STREAMS=64, MAX_OUTPUT=4*1024*1024;
const DECIMAL=/^(?:\d+(?:\.\d*)?|\.\d+)$/;
// ffprobe reads only the descriptor opened and checked here; no other protocol, so nested references cannot be opened.
const PROBE_ARGS=['-v','warning','-protocol_whitelist','fd','-show_entries','format=duration,format_name:stream=index,codec_type,duration','-of','json','-fd','3','-i','fd:'];
const TRIM_COMPARISON={status:'not_established',reason:'trim_semantics_unverified',detail:'One R27 app save holds two clips imported from WAV files of known four-second length, but the repository does not record their stored trim values, and one import cannot fix the unit of trimStartMs and trimEndMs or whether they are source positions in general. No clip is compared with a duration.'};

const shown=value=>typeof value!=='string'?null:value.length>MAX_SHOWN_CHARS?{length:value.length,valueOmitted:true}:value;
const seconds=value=>typeof value==='string'&&DECIMAL.test(value)&&Number.isFinite(Number(value))?Number(value):null;
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;

function probeFd(fd,timeoutMs){
 return new Promise(resolve=>{
  let child,settled=false,killed;
  const done=result=>{if(!settled){settled=true;clearTimeout(timer);resolve(result);}};
  const timer=setTimeout(()=>{killed='timeout';child?.kill('SIGKILL');},timeoutMs);
  try{child=spawn('ffprobe',PROBE_ARGS,{stdio:['ignore','pipe','pipe',fd],windowsHide:true});}
  catch{return done({status:'unknown',reason:'ffprobe_failed'});}
  const out=[],err=[];let outBytes=0,errBytes=0;
  child.on('error',error=>done(error.code==='ENOENT'?{status:'unavailable'}:{status:'unknown',reason:'ffprobe_failed'}));
  child.stdout.on('data',chunk=>{outBytes+=chunk.length;if(outBytes>MAX_STDOUT){killed??='output_too_large';child.kill('SIGKILL');}else out.push(chunk);});
  child.stderr.on('data',chunk=>{if(errBytes<MAX_STDERR)err.push(chunk.subarray(0,MAX_STDERR-errBytes));errBytes+=chunk.length;});
  child.on('close',code=>{
   if(killed)return done({status:'unknown',reason:killed});
   const stderr=Buffer.concat(err).toString('utf8');
   const warnings=stderr.split(/\r?\n/).map(line=>line.replace(/ @ 0x[0-9a-f]+\]/i,']').trim()).filter(Boolean).slice(0,MAX_WARNINGS).map(line=>line.slice(0,300));
   if(code!==0){
    const fdUnsupported=/Unrecognized option 'fd'|Option fd not found|Protocol not found|Doesn't support pass file descriptor/i.test(stderr);
    return done({status:'unknown',reason:fdUnsupported?'fd_input_unsupported':'ffprobe_failed',warnings});
   }
   let data;try{data=JSON.parse(Buffer.concat(out).toString('utf8'));}catch{return done({status:'unknown',reason:'invalid_output',warnings});}
   if(!data||typeof data!=='object')return done({status:'unknown',reason:'invalid_output',warnings});
   const format=data.format&&typeof data.format==='object'?data.format:{};
   const streams=Array.isArray(data.streams)?data.streams.filter(s=>s&&s.codec_type==='audio'):[];
   const container=seconds(format.duration);
   const facts={formatName:typeof format.format_name==='string'?format.format_name.slice(0,100):null,audioStreamCount:streams.length,
    audioStreams:streams.slice(0,MAX_STREAMS).map(s=>({index:Number.isSafeInteger(s.index)?s.index:null,seconds:seconds(s.duration)})),
    estimatedFromBitrate:/Estimating duration from bitrate/.test(stderr),warnings};
   done(container===null?{status:'unknown',reason:'no_container_duration',...facts}:{status:'known',seconds:container,...facts});
  });
 });
}

// Stage a clip's `file` attribute as a path on this computer. Symlinks are followed, as in the RPP media preflight.
async function stageSourcePath(file){
 if(typeof file!=='string')return {status:'no_file_attribute'};
 if(!file)return {status:'empty'};
 if(file.length>MAX_PATH_CHARS||file.includes('\0'))return {status:'invalid_path'};
 if(!path.isAbsolute(file))return {status:'not_absolute'};
 try{
  const link=await lstat(file),info=await stat(file,{bigint:true});
  if(!info.isFile())return {status:'not_regular_file'};
  return {status:'regular_file',open:file,follow:true,identity:info,...(link.isSymbolicLink()?{viaSymlink:true}:{})};
 }catch(error){
  const errorCode=typeof error.code==='string'?error.code:'UNKNOWN';
  return {status:errorCode==='ENOENT'||errorCode==='ENOTDIR'?'not_found_at_checked_path':'check_failed',errorCode};
 }
}

// Stage the mapped MEDIA sidecar without following symlinks at any component.
async function stageSidecar(root,mapping){
 if(!mapping)return {status:'unmapped'};
 if(mapping.ambiguousLines)return {status:'ambiguous_mapping',ambiguousLines:mapping.ambiguousLines};
 const row={line:mapping.line,archivePath:mapping.archivePath};
 const found=await sidecarStatus(root,mapping.archivePath);
 if(found.status!=='regular_file')return {...row,status:found.status};
 try{
  const info=await lstat(found.file,{bigint:true});
  if(!info.isFile())return {...row,status:'changed_during_check'};
  return {...row,status:'regular_file',open:found.file,follow:false,identity:info};
 }catch{return {...row,status:'changed_during_check'};}
}

export async function preflightSessionAudio({directory,sha256,probeDurations=true,probeBudgetMs=10000}){
 if(typeof probeDurations!=='boolean')throw Error('probeDurations must be a boolean');
 if(!Number.isSafeInteger(probeBudgetMs)||probeBudgetMs<100||probeBudgetMs>30000)throw Error('probeBudgetMs must be an integer from 100 to 30000');
 if(sha256!==undefined&&(typeof sha256!=='string'||!/^[0-9a-f]{64}$/.test(sha256)))throw Error('sha256 must be 64 lowercase hexadecimal characters');
 const session=await inspectSessionMedia({directory});
 if(sha256!==undefined&&session.showSha256!==sha256)throw Error('Session changed since inspection');
 const distinct=new Set();
 for(const clip of session.clips){
  const file=clip.attributes.file;
  if(typeof file==='string'&&file&&path.isAbsolute(file))distinct.add('s\0'+file);
  if(clip.mapping?.archivePath)distinct.add('m\0'+clip.mapping.archivePath);
 }
 if(distinct.size>MAX_PATHS)throw Error(`At most ${MAX_PATHS} distinct media paths are supported`);
 // Stage each distinct path once, then merge paths that name the same file (device and inode).
 const sourceCache=new Map(),sidecarCache=new Map();
 const staged=[];
 for(const clip of session.clips){
  const file=clip.attributes.file;
  if(!sourceCache.has(file))sourceCache.set(file,await stageSourcePath(file));
  const key=clip.mapping?.archivePath??(clip.mapping?.ambiguousLines?'ambiguous\0'+clip.mapping.ambiguousLines.join(','):'');
  if(!sidecarCache.has(key))sidecarCache.set(key,await stageSidecar(session.directory,clip.mapping));
  staged.push({clip,source:sourceCache.get(file),sidecar:sidecarCache.get(key)});
 }
 const files=[],byIdentity=new Map();
 const attach=(candidate,kind,ref)=>{
  if(candidate.status!=='regular_file'||candidate.fileIndex!==undefined)return;
  const key=`${candidate.identity.dev}:${candidate.identity.ino}`;
  let entry=byIdentity.get(key);
  if(!entry){entry={fileIndex:files.length,paths:[],clipCount:0,open:candidate.open,follow:candidate.follow,identity:candidate.identity,size:Number(candidate.identity.size)};byIdentity.set(key,entry);files.push(entry);}
  entry.paths.push({kind,...ref});candidate.fileIndex=entry.fileIndex;
 };
 for(const {source,sidecar,clip} of staged){
  attach(sidecar,'sidecar',{line:sidecar.line,archivePath:sidecar.archivePath,path:sidecar.open});
  attach(source,'source_path',{path:clip.attributes.file});
  // A clip whose sidecar and source path are the same file counts once.
  for(const index of new Set([sidecar.fileIndex,source.fileIndex]))if(index!==undefined)files[index].clipCount++;
 }
 // Open each file, confirm it is still the staged file, and probe that descriptor within one shared time budget.
 const deadline=performance.now()+probeBudgetMs;let ffprobe=probeDurations?'not_run':'disabled',next=0;
 const check=async entry=>{
  let handle;
  try{handle=await open(entry.open,constants.O_RDONLY|(constants.O_NONBLOCK??0)|(entry.follow?0:(constants.O_NOFOLLOW??0)));}
  catch(error){
   // A sidecar replaced by a symlink after staging fails O_NOFOLLOW with ELOOP.
   if(!entry.follow&&error.code==='ELOOP')entry.status='changed_during_check';
   else {entry.status='not_readable';entry.errorCode=typeof error.code==='string'?error.code:'UNKNOWN';}
   entry.duration={status:probeDurations?'not_checked':'disabled'};return;
  }
  try{
   const info=await handle.stat({bigint:true});
   if(!info.isFile()||!sameFile(info,entry.identity)){entry.status='changed_during_check';entry.duration={status:probeDurations?'not_checked':'disabled'};return;}
   entry.status='readable';entry.size=Number(info.size);
   if(!probeDurations){entry.duration={status:'disabled'};return;}
   if(ffprobe==='unavailable'){entry.duration={status:'unavailable'};return;}
   const remaining=Math.floor(deadline-performance.now());
   if(remaining<=0){entry.duration={status:'not_checked',reason:'budget_exhausted'};return;}
   entry.duration=await probeFd(handle.fd,remaining);
   if(entry.duration.status==='unavailable')ffprobe='unavailable';else if(ffprobe==='not_run')ffprobe='ran';
  }finally{await handle.close();}
 };
 await Promise.all(Array.from({length:Math.min(CONCURRENCY,files.length)},async()=>{while(next<files.length)await check(files[next++]);}));
 const candidate=c=>{
  const {open:_o,follow:_f,identity:_i,fileIndex,...rest}=c;
  if(fileIndex===undefined)return rest;
  const entry=files[fileIndex];
  return {...rest,status:entry.status,fileIndex,...(entry.errorCode?{errorCode:entry.errorCode}:{})};
 };
 const clips=staged.map(({clip,source,sidecar})=>({
  part:clip.part,...(clip.itemIndex!==undefined?{itemIndex:clip.itemIndex}:{}),audioIndex:clip.audioIndex,clipIndex:clip.clipIndex,
  name:shown(clip.attributes.name),file:shown(clip.attributes.file),
  observedTrim:{trimStartMs:shown(clip.attributes.trimStartMs),trimEndMs:shown(clip.attributes.trimEndMs)},
  sidecar:candidate(sidecar),sourcePath:candidate(source)
 }));
 const result={directory:session.directory,showSha256:session.showSha256,
  probe:{enabled:probeDurations,ffprobe,budgetMs:probeBudgetMs},
  trimComparison:TRIM_COMPARISON,
  files:files.map(({open:_o,follow:_f,identity:_i,...entry})=>entry),
  clips,diagnostics:session.diagnostics,
  limitations:[
   'Two candidates are checked per clip: the media.map sidecar whose source path equals the clip file, and the clip file as a path on this computer. Which one ShowKontrol uses, and whether it searches elsewhere, is unverified.',
   'Readable means the file opened for reading at the time of the call. Sidecar symlinks are not followed; source path symlinks are.',
   'Duration is the ffprobe container duration of the opened file. Stream durations are reported separately and can differ. Unknown, unavailable or unchecked duration says nothing about whether a clip fits.',
   'Clip trims are reported as observed strings and are not compared with any duration, because their unit and meaning are not established.',
   'Media format, codec support, waveform caches, import, relinking and playback in ShowKontrol are not verified. A readable file with a known duration is not evidence of playback safety.'
  ]};
 if(Buffer.byteLength(JSON.stringify(result,null,2))>MAX_OUTPUT)throw Error('Preflight result exceeds output limit');
 return result;
}
