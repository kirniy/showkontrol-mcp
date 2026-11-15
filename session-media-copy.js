import path from 'node:path';
import {constants} from 'node:fs';
import {open,lstat,mkdir,mkdtemp,readdir,rename,rm,rmdir,realpath,link,statfs,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inspectShow,readShowSnapshot,readSnapshotPart,writeShowMediaMapCopy} from './xml-copy.js';
import {inspectShowMedia} from './media-inventory.js';
import {inspectSessionMedia,sidecarStatus,sidecarSegments} from './session-media.js';
import {parseXmlSpans} from './xml-spans.js';
import {composeFullShowCopy} from './compose-full-show.js';
import {validateShow} from './validate-show.js';

const MAX_MEDIA=100, MAX_REPORTED=100, CHUNK=1024*1024, DEFAULT_MAX_COPY_BYTES=4*1024**3, MAX_WORKING_ENTRIES=10000, MAX_WORKING_DEPTH=32, MAX_COMPARE_BYTES=128*1024*1024;
export const MAP_DIAGNOSTICS=['duplicate_media_map','invalid_media_map_checksum','invalid_media_map_utf8','malformed_mapping','duplicate_source'];
// Tabs and line breaks would corrupt media.map rows; a BOM would be stripped from the first row.
const UNSAFE_TEXT=/[\x00-\x1f\x7f\ufeff\ufffe\uffff]/u;
const READ_FLAGS=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;

function copyLimit(){
 const value=process.env.SHOWKONTROL_SESSION_MEDIA_MAX_BYTES;
 if(value===undefined)return DEFAULT_MAX_COPY_BYTES;
 if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)throw Error('Invalid SHOWKONTROL_SESSION_MEDIA_MAX_BYTES');
 return Number(value);
}
// macOS volumes usually compare names without case and after Unicode normalization.
export const nameKey=archivePath=>archivePath.normalize('NFC').toLowerCase();
export function checkSourcePath(file){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file||file.endsWith('/')||file.length>4096||UNSAFE_TEXT.test(file))throw Error(`Media source must be a normalized absolute file path without control characters: ${JSON.stringify(file)}`);
}
export function checkSidecarName(name){
 if(typeof name!=='string'||!name||name.startsWith('.')||/[/\\:]/.test(name)||UNSAFE_TEXT.test(name)||Buffer.byteLength(name)>255)throw Error(`Sidecar name must be one visible file name of at most 255 bytes without slashes, colons or control characters: ${JSON.stringify(name)}`);
}
async function absent(file){
 try{await lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
 throw Error('Destination session already exists');
}
// A symlinked parent would make the media.map source path name a file at another location.
async function checkSourceParents(file){
 let current=path.parse(file).root;
 for(const segment of path.dirname(file).split(path.sep).filter(Boolean)){
  current=path.join(current,segment);let info;
  try{info=await lstat(current);}catch(error){throw Error(`Media source ${error.code==='ENOENT'?'not found':'cannot be checked'}: ${file}`);}
  if(info.isSymbolicLink()){let resolved;try{resolved=await realpath(file);}catch{}throw Error(`Media source path passes through symlinked directory ${current}${resolved?`; supply the resolved path ${resolved}`:''}: ${file}`);}
  if(!info.isDirectory())throw Error(`Media source parent is not a directory: ${current}`);
 }
}
// rename(2) replaces an empty directory. Claim the name with mkdir(2), which fails if anything exists, and rename over the claim only if it is still that directory.
export async function claimDestination(target){
 try{await mkdir(target);}catch(error){throw error.code==='EEXIST'?Error('Destination session already exists'):error;}
 return lstat(target);
}
export async function publishDirectory(stage,target,claim){
 claim??=await claimDestination(target);
 const ours=async()=>{try{const now=await lstat(target);return now.isDirectory()&&now.dev===claim.dev&&now.ino===claim.ino;}catch{return false;}};
 // Another process can still swap the claim between this check and rename(2).
 if(!await ours())throw Error('Destination session changed during publication');
 try{await rename(stage,target);}
 catch(error){
  if(await ours())await rmdir(target).catch(()=>{});
  throw ['ENOTEMPTY','EEXIST','ENOTDIR','EISDIR'].includes(error.code)?Error('Destination session changed during publication'):error;
 }
}
async function fileSha256(file){
 const handle=await open(file,READ_FLAGS),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(CHUNK);
 try{for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));}}
 finally{await handle.close();}
 return hash.digest('hex');
}
// Copy from a descriptor whose identity matches the planned file, then re-read the copy.
async function copyVerified({from,planned,target,label}){
 let handle;
 try{handle=await open(from,READ_FLAGS);}
 catch(error){throw Error(`${label} cannot be opened without following symlinks: ${from}: ${error.code||error.message}`);}
 try{
  const before=await handle.stat();
  if(!before.isFile()||before.dev!==planned.dev||before.ino!==planned.ino||before.size!==planned.size)throw Error(`${label} changed before copy: ${from}`);
  const out=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(CHUNK);let total=0;
  try{
   for(;;){
    const {bytesRead}=await handle.read(buffer,0,buffer.length,total);if(!bytesRead)break;
    if(total+bytesRead>before.size)throw Error(`${label} changed during copy: ${from}`);
    hash.update(buffer.subarray(0,bytesRead));
    for(let written=0;written<bytesRead;){const {bytesWritten}=await out.write(buffer,written,bytesRead-written,total+written);written+=bytesWritten;}
    total+=bytesRead;
   }
   await out.sync();
  }finally{await out.close();}
  const after=await handle.stat();
  if(total!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error(`${label} changed during copy: ${from}`);
  const sha256=hash.digest('hex');
  if(await fileSha256(target)!==sha256)throw Error(`Copied file does not match ${label.toLowerCase()}: ${from}`);
  return {size:total,sha256};
 }finally{await handle.close();}
}
export function appendMappingRows(text,rows){
 const eol=text.includes('\r\n')?'\r\n':'\n',separator=text.replace(/^\ufeff/,'')&&!text.endsWith('\n')?eol:'';
 return text+separator+rows.map(row=>`${row.sourcePath}\t${row.archivePath}${eol}`).join('');
}
async function readPlanned(file,planned,label){
 const handle=await open(file,READ_FLAGS);
 try{
  const info=await handle.stat();
  if(!info.isFile()||info.dev!==planned.dev||info.ino!==planned.ino||info.size!==planned.size)throw Error(`${label} changed during planning: ${file}`);
  const bytes=Buffer.alloc(info.size);let total=0;
  while(total<bytes.length){const {bytesRead}=await handle.read(bytes,total,bytes.length-total,total);if(!bytesRead)break;total+=bytesRead;}
  if(total!==info.size)throw Error(`${label} changed during planning: ${file}`);
  return bytes;
 }finally{await handle.close();}
}
// Walk the session without following symlinks. session.skshow is handled separately.
async function walkSession(root){
 const files=[],dirs=[],rejected=[];let count=0;
 async function visit(dir,rel,depth){
  for(const name of (await readdir(dir)).sort()){
   const childRel=rel?`${rel}/${name}`:name;
   if(childRel==='session.skshow')continue;
   if(++count>MAX_WORKING_ENTRIES)throw Error(`Session has more than ${MAX_WORKING_ENTRIES} working entries`);
   const file=path.join(dir,name),info=await lstat(file);
   if(info.isDirectory()){
    if(depth>=MAX_WORKING_DEPTH)throw Error(`Session entries are nested deeper than ${MAX_WORKING_DEPTH} directories`);
    dirs.push({rel:childRel,file,planned:info});await visit(file,childRel,depth+1);
   }else if(info.isFile())files.push({rel:childRel,file,planned:info});
   else rejected.push({rel:childRel,kind:info.isSymbolicLink()?'symlink':'special_file'});
  }
 }
 await visit(root,'',0);return {files,dirs,rejected};
}
const sameEntry=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const partExt=name=>path.posix.extname(name).toLowerCase();
const decode=bytes=>{try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return null;}};
// Split a version 2 patch around the raw value of its root name attribute.
function splitRootName(bytes){
 const text=decode(bytes);if(text===null)return null;
 let root;try{root=parseXmlSpans(text);}catch{return null;}
 if(root.name!=='showkontrol'||typeof root.attributes.name!=='string')return null;
 const found=[...text.slice(root.start,root.openEnd).matchAll(/(\sname\s*=\s*)("[^"]*"|'[^']*')/g)];
 if(found.length!==1)return null;
 const at=root.start+found[0].index+found[0][1].length;
 return {before:text.slice(0,at),raw:found[0][2],after:text.slice(at+found[0][2].length),name:root.attributes.name};
}
function partsByName(snapshot){const map=new Map();for(const part of snapshot.parts)map.set(part.name,[...(map.get(part.name)??[]),part.bytes]);return map;}
function partState(name,before,after){
 const a=before.get(name),b=after.get(name);
 if(a?.length!==1||b?.length>1)return 'ambiguous';
 if(!b)return 'removed';
 return a[0].equals(b[0])?'unchanged':'changed';
}
// The only app evidence: opening a .skshow wrote session.skf equal to patch.skf except for the root name.
// Other working files are related to archive parts by path, exact content or file name.
function relateWorkingFile(entry,before){
 const {rel,bytes}=entry;
 if(rel==='session.skf'&&before.get('patch.skf')?.length===1){
  const patch=before.get('patch.skf')[0];
  if(bytes?.equals(patch))return {relation:'exact',parts:['patch.skf']};
  const work=bytes&&splitRootName(bytes),archive=splitRootName(patch);
  if(work&&archive&&work.before===archive.before&&work.after===archive.after)return {relation:'root_name',parts:['patch.skf'],raw:work.raw,rootName:work.name};
  return {relation:'diverged',parts:['patch.skf']};
 }
 if(before.has(rel))return {relation:before.get(rel).length===1&&bytes?.equals(before.get(rel)[0])?'exact':'diverged',parts:[rel]};
 if(bytes){
  const same=[...before].filter(([,list])=>list.some(b=>b.equals(bytes))).map(([name])=>name);
  if(same.length===1)return {relation:'exact',parts:same};
  if(same.length>1)return {relation:'ambiguous',parts:same};
 }
 const named=[...before.keys()].filter(name=>path.posix.basename(name)===path.posix.basename(rel));
 if(named.length===1)return {relation:'name',parts:named};
 return {relation:'none',parts:[]};
}
// Decide how each working file is carried into the new session so it agrees with the composed archive.
function planWorkingFiles({walk,before,after,sourceName,omit}){
 const plan=[],problems=[],warnings=[],changedExts=new Set(),addedParts=[...after.keys()].filter(name=>!before.has(name));
 for(const name of new Set([...before.keys(),...addedParts]))if(!before.has(name)||partState(name,before,after)!=='unchanged')changedExts.add(partExt(name));
 const unverified=(rel,reason,detail,link)=>{if(omit){plan.push({rel,action:'omitted',...(link?{relation:link.relation,...(link.parts.length?{parts:link.parts}:{})}:{}),reason});warnings.push({code:'working_file_omitted',path:rel,reason,message:detail});}else problems.push(`${rel}: ${detail}`);};
 for(const item of walk.rejected)unverified(item.rel,item.kind,`is a ${item.kind==='symlink'?'symlink':'special file'}; only regular files and directories are copied`);
 const rules=new Map(),broken=new Set(),extracted=new Set();
 for(const entry of walk.files){
  const link=relateWorkingFile(entry,before),base={rel:entry.rel,relation:link.relation,...(link.parts.length?{parts:link.parts}:{}),entry};
  if(link.relation!=='none'&&entry.rel!=='session.skf')for(const name of link.parts)extracted.add(partExt(name));
  if(link.relation==='exact'&&entry.rel!==link.parts[0]&&entry.rel!=='session.skf'){
   const ext=partExt(link.parts[0]),dir=path.posix.dirname(entry.rel);
   if(entry.rel===`${dir}/${path.posix.basename(link.parts[0])}`&&(!rules.has(ext)||rules.get(ext)===dir))rules.set(ext,dir);else broken.add(ext);
  }
  if(link.relation==='exact'||link.relation==='root_name'){
   const state=partState(link.parts[0],before,after);
   if(state==='unchanged')plan.push({...base,action:'copied'});
   else if(state==='removed')plan.push({...base,action:'omitted',reason:'part_removed'});
   else if(state==='changed'){
    let bytes=after.get(link.parts[0])[0];
    if(link.relation==='root_name'){const next=splitRootName(bytes);if(!next){unverified(entry.rel,'root_name_unavailable','matched patch.skf except for its root name, but the composed patch root name cannot be located',link);continue;}bytes=Buffer.from(next.before+link.raw+next.after,'utf8');}
    plan.push({...base,action:'regenerated',bytes});
   }else unverified(entry.rel,'ambiguous_part',`matches ${link.parts[0]}, which is duplicated in the archive`,link);
   if(link.relation==='root_name'&&link.rootName===sourceName)warnings.push({code:'working_patch_root_name_is_session_name',path:entry.rel,rootName:link.rootName,message:'The working patch root name equals the source session directory name. The new session keeps it; ShowKontrol may rename it.'});
   continue;
  }
  if(link.relation==='ambiguous'){
   if(link.parts.every(name=>partState(name,before,after)==='unchanged'))plan.push({...base,action:'copied'});
   else unverified(entry.rel,'ambiguous_part',`matches several archive parts (${link.parts.join(', ')}) and at least one changed`,link);
   continue;
  }
  if(link.relation==='diverged'||link.relation==='name'){
   const state=partState(link.parts[0],before,after);
   if(state==='unchanged'){plan.push({...base,action:'copied'});warnings.push({code:'working_file_differs_from_archive',path:entry.rel,part:link.parts[0],message:'Copied unchanged. It already differed from this archive part in the source session.'});}
   else unverified(entry.rel,'stale_working_file',`differs from ${link.parts[0]}, which the composition ${state==='removed'?'removed':'changed'}; it may hold unsaved working state`,link);
   continue;
  }
  const ext=partExt(entry.rel);
  if(ext&&changedExts.has(ext)||entry.rel.startsWith('TIMELINE/')&&changedExts.has('.sktl'))unverified(entry.rel,'unidentified_working_file',`matches no archive part, and ${ext&&changedExts.has(ext)?ext:'.sktl'} parts changed`,link);
  else plan.push({...base,action:'copied'});
 }
 const planned=new Set(plan.map(p=>nameKey(p.rel)));
 for(const name of addedParts){
  const ext=partExt(name),dir=!broken.has(ext)&&rules.get(ext);
  if(dir){
   const rel=`${dir}/${path.posix.basename(name)}`;
   if(planned.has(nameKey(rel))){unverified(rel,'created_name_taken',`would receive new part ${name}, but the name is already used`);continue;}
   planned.add(nameKey(rel));plan.push({rel,action:'created',relation:'exact',parts:[name],bytes:after.get(name)[0]});
  }else if(ext&&(extracted.has(ext)||walk.files.some(entry=>partExt(entry.rel)===ext||ext==='.sktl'&&entry.rel.startsWith('TIMELINE/')))){
   const detail=`No working file was created for new part ${name}: no consistent extraction layout was found for ${ext} parts`;
   if(omit)warnings.push({code:'working_file_not_created',part:name,message:detail});else problems.push(detail);
  }
 }
 return {plan,problems,warnings};
}

// Create a new session directory: composed session.skshow, extended media.map and verified MEDIA sidecar copies.
export async function composeSessionMediaCopy({source,destination,sha256,media=[],tracks,patchOperations,setlistOperations,program,allowMissingSidecars=false,omitUnverifiedWorkingFiles=false}){
 if(typeof source!=='string'||!path.isAbsolute(source)||typeof destination!=='string'||!path.isAbsolute(destination))throw Error('Source and destination session directories must be absolute paths');
 if(typeof sha256!=='string')throw Error('Supply the inspected session.skshow SHA-256');
 if(!Array.isArray(media)||media.length>MAX_MEDIA)throw Error(`Media must be an array of at most ${MAX_MEDIA} entries`);
 if(typeof allowMissingSidecars!=='boolean')throw Error('allowMissingSidecars must be a boolean');
 if(typeof omitUnverifiedWorkingFiles!=='boolean')throw Error('omitUnverifiedWorkingFiles must be a boolean');
 if(tracks!==undefined&&!Array.isArray(tracks))throw Error('Tracks must be an array');
 const composing=Boolean(tracks?.length)||patchOperations!==undefined||setlistOperations!==undefined||program!==undefined;
 if(!media.length&&!composing)throw Error('Add media, tracks, operations or a Program');
 const root=await realpath(source),show=path.join(root,'session.skshow');
 if(!(await lstat(show)).isFile())throw Error('session.skshow must be a regular file, not a symlink');
 const name=path.basename(destination);
 if(!name||name==='.'||name==='..')throw Error('Destination must name a new session directory');
 const parent=await realpath(path.dirname(destination)),target=path.join(parent,name);
 if(target===root||target.startsWith(root+path.sep))throw Error('Destination must be outside the source session');
 await absent(target);
 const inventory=await inspectShowMedia({file:show});
 if(inventory.sha256!==sha256)throw Error('Source changed since inspection');
 const mapProblems=[...new Set(inventory.diagnostics.filter(d=>MAP_DIAGNOSTICS.includes(d.code)).map(d=>d.code))];
 if(mapProblems.length)throw Error(`media.map cannot be extended safely: ${mapProblems.join(', ')}`);
 const warnings=[],keys=new Map(),existing=new Map();
 for(const mapping of inventory.mappings){
  const entry=existing.get(mapping.archivePath);if(entry){entry.lines.push(mapping.line);continue;}
  const key=nameKey(mapping.archivePath);
  if(keys.has(key))warnings.push({code:'case_insensitive_sidecar_collision',archivePaths:[keys.get(key),mapping.archivePath],message:'These sidecars can collide on a case-insensitive volume.'});
  else keys.set(key,mapping.archivePath);
  existing.set(mapping.archivePath,{archivePath:mapping.archivePath,lines:[mapping.line]});
 }
 const mappedSources=new Map(inventory.mappings.map(m=>[m.sourcePath,m.line])),added=[];
 for(const [index,item] of media.entries()){
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['source','sidecarName'].includes(k)))throw Error(`Invalid media entry at index ${index}`);
  checkSourcePath(item.source);
  if(mappedSources.has(item.source))throw Error(`Media source is already mapped on media.map line ${mappedSources.get(item.source)}; use it as clip.file instead: ${item.source}`);
  if(added.some(a=>a.sourcePath===item.source))throw Error(`Duplicate media source: ${item.source}`);
  const sidecarName=item.sidecarName??path.basename(item.source);checkSidecarName(sidecarName);
  const archivePath=`MEDIA/${sidecarName}`,key=nameKey(archivePath);
  const clash=keys.get(key)??[...keys.entries()].find(([other])=>other.startsWith(key+'/'))?.[1];
  if(clash)throw Error(`Sidecar ${archivePath} collides with ${clash}; names are compared without case after Unicode normalization. Choose another sidecarName`);
  keys.set(key,archivePath);added.push({mediaIndex:index,sourcePath:item.source,archivePath});
 }
 // mediaIndex selects a new media entry; its source path becomes the clip file.
 const withMedia=(items,label,field,trackIndex)=>items.map((item,index)=>{
  if(!item||typeof item!=='object'||item.mediaIndex===undefined)return item;
  const {mediaIndex,...rest}=item;
  if(!Number.isSafeInteger(mediaIndex)||!added[mediaIndex])throw Error(`Track ${trackIndex} ${label} ${index}: mediaIndex must select an entry in media`);
  if(!rest[field]||typeof rest[field]!=='object'||Array.isArray(rest[field])||Object.hasOwn(rest[field],'file'))throw Error(`Track ${trackIndex} ${label} ${index}: mediaIndex supplies ${field}.file; omit file`);
  return {...rest,[field]:{...rest[field],file:added[mediaIndex].sourcePath}};
 });
 const resolvedTracks=(tracks??[]).map((track,trackIndex)=>!track||typeof track!=='object'?track:{...track,
  ...(Array.isArray(track.audioClips)?{audioClips:withMedia(track.audioClips,'audio clip','clip',trackIndex)}:{}),
  ...(Array.isArray(track.audioClipEdits)?{audioClipEdits:withMedia(track.audioClipEdits,'audio clip edit','attributes',trackIndex)}:{})});
 const copies=[],missing=[];let total=0;
 for(const entry of existing.values()){
  const status=await sidecarStatus(root,entry.archivePath);
  if(status.status==='missing'&&allowMissingSidecars){missing.push(entry);continue;}
  if(status.status!=='regular_file')throw Error(`Mapped sidecar ${entry.archivePath} is ${status.status}${status.status==='missing'?'; set allowMissingSidecars to keep its mapping without a file':''}`);
  copies.push({...entry,origin:'existing',from:status.file,planned:status,segments:sidecarSegments(entry.archivePath),label:'Session sidecar'});total+=status.size;
 }
 for(const entry of added){
  await checkSourceParents(entry.sourcePath);
  let info;try{info=await lstat(entry.sourcePath);}catch(error){throw Error(`Media source ${error.code==='ENOENT'?'not found':'cannot be checked'}: ${entry.sourcePath}`);}
  if(info.isSymbolicLink())throw Error(`Media source is a symlink; supply the file path: ${entry.sourcePath}`);
  if(!info.isFile())throw Error(`Media source is not a regular file: ${entry.sourcePath}`);
  if(!info.size)throw Error(`Media source is empty: ${entry.sourcePath}`);
  copies.push({...entry,origin:'added',from:entry.sourcePath,planned:info,segments:sidecarSegments(entry.archivePath),label:'Media source'});total+=info.size;
 }
 // Every other session entry is working state; mapped sidecars are matched by name and file identity.
 const copiedSidecars=new Map(copies.filter(c=>c.origin==='existing').map(c=>[nameKey(c.archivePath),c.planned]));
 const isSidecar=(rel,info)=>{const p=copiedSidecars.get(nameKey(rel));return Boolean(p&&info&&p.dev===info.dev&&p.ino===info.ino);};
 const walk=await walkSession(root);
 walk.files=walk.files.filter(f=>!isSidecar(f.rel,f.planned));
 for(const row of added){
  const key=nameKey(row.archivePath),clash=[...walk.files,...walk.dirs,...walk.rejected].find(e=>nameKey(e.rel)===key||nameKey(e.rel).startsWith(key+'/'));
  if(clash)throw Error(`Sidecar ${row.archivePath} collides with existing session entry ${clash.rel}; names are compared without case after Unicode normalization. Choose another sidecarName`);
 }
 const sourceSnapshot=await readShowSnapshot({file:show});if(sourceSnapshot.sha256!==sha256)throw Error('Source changed since inspection');
 const before=partsByName(sourceSnapshot),partSizes=new Set(sourceSnapshot.parts.map(p=>p.bytes.length));
 for(const entry of walk.files){
  if(entry.planned.size<=MAX_COMPARE_BYTES&&(entry.rel==='session.skf'||before.has(entry.rel)||partSizes.has(entry.planned.size)))entry.bytes=await readPlanned(entry.file,entry.planned,'Session working file');
  total+=entry.planned.size;
 }
 const limit=copyLimit(),checkLimit=bytes=>{if(bytes>limit)throw Error(`Session copies total ${bytes} bytes, above the ${limit}-byte limit (SHOWKONTROL_SESSION_MEDIA_MAX_BYTES)`);};checkLimit(total);
 const space=await statfs(parent);if(total+2*(await lstat(show)).size>space.bavail*space.bsize)throw Error('Destination volume does not have enough free space for the session copy');
 const work=await mkdtemp(path.join(parent,'.showkontrol-session-work-'));
 let stage,published=false,result;const cleanupWarnings=[];
 try{
  stage=await mkdtemp(path.join(parent,'.showkontrol-session-'));
  let current=show,currentHash=sha256,composition;
  if(composing){
   const next=path.join(work,'composed.skshow');
   // The full-show composer adds the Program stage and rejects a composed archive with validation errors.
   composition=await composeFullShowCopy({source:show,destination:next,sha256,tracks:resolvedTracks,patchOperations,setlistOperations,program});
   current=next;currentHash=composition.sha256;
  }
  if(added.length){
   const snapshot=await readShowSnapshot({file:current});if(snapshot.sha256!==currentHash)throw Error('Staged show changed during composition');
   const text=snapshot.parts.some(p=>p.name==='media.map')?readSnapshotPart({snapshot,name:'media.map'}).text:'';
   const next=path.join(work,'mapped.skshow'),written=await writeShowMediaMapCopy({source:current,destination:next,sha256:currentHash,text:appendMappingRows(text,added)});
   current=next;currentHash=written.sha256;
  }
  const finalSnapshot=await readShowSnapshot({file:current});if(finalSnapshot.sha256!==currentHash)throw Error('Staged show changed during composition');
  // Validate the archive that will be published; appended media.map rows follow the composer's validation.
  const validation=composition&&!added.length?composition.validation:composition&&await validateShow({file:current});
  if(validation){
   if(validation.sha256!==currentHash)throw Error('Staged show changed during validation');
   const errors=validation.diagnostics.filter(d=>d.severity==='error');
   if(errors.length)throw Error(`Final session.skshow validation failed: ${[...new Set(errors.map(d=>d.code))].join(', ')}`);
  }
  const working=planWorkingFiles({walk,before,after:partsByName(finalSnapshot),sourceName:path.basename(root),omit:omitUnverifiedWorkingFiles});
  if(working.problems.length)throw Error(`Working files cannot be kept consistent with the composed session.skshow; set omitUnverifiedWorkingFiles to leave them out and let ShowKontrol regenerate them, which is unverified: ${working.problems.slice(0,5).join('; ')}${working.problems.length>5?`; and ${working.problems.length-5} more`:''}`);
  checkLimit(copies.reduce((sum,c)=>sum+c.planned.size,0)+working.plan.reduce((sum,w)=>sum+(w.bytes?.length??(w.action==='copied'?w.entry.planned.size:0)),0));
  for(const dir of walk.dirs)await mkdir(path.join(stage,...dir.rel.split('/')),{recursive:true});
  const sidecars=[];
  for(const copy of copies){
   const file=path.join(stage,...copy.segments);await mkdir(path.dirname(file),{recursive:true});
   const {size,sha256:digest}=await copyVerified({from:copy.from,planned:copy.planned,target:file,label:copy.label});
   if(copy.origin==='added'){
    await checkSourceParents(copy.from);const now=await lstat(copy.from);
    if(now.isSymbolicLink()||now.dev!==copy.planned.dev||now.ino!==copy.planned.ino)throw Error(`Media source path changed during copy: ${copy.from}`);
   }
   sidecars.push({archivePath:copy.archivePath,origin:copy.origin,from:copy.from,size,sha256:digest,...(copy.lines?{lines:copy.lines}:{mediaIndex:copy.mediaIndex})});
  }
  const workingFiles=[];
  for(const item of working.plan){
   const report={path:item.rel,action:item.action,...(item.relation?{relation:item.relation}:{}),...(item.parts?{parts:item.parts}:{}),...(item.reason?{reason:item.reason}:{})};workingFiles.push(report);
   if(item.action==='omitted')continue;
   const file=path.join(stage,...item.rel.split('/'));await mkdir(path.dirname(file),{recursive:true});
   if(item.action==='copied')Object.assign(report,await copyVerified({from:item.entry.file,planned:item.entry.planned,target:file,label:'Session working file'}));
   else{
    await writeFile(file,item.bytes,{flag:'wx',mode:0o644});const digest=createHash('sha256').update(item.bytes).digest('hex');
    if(await fileSha256(file)!==digest)throw Error(`Written working file does not match its archive part: ${item.rel}`);
    Object.assign(report,{size:item.bytes.length,sha256:digest});
   }
  }
  await link(current,path.join(stage,'session.skshow'));
  // Check the staged session with the read-only inventory tools before publication.
  const staged=await inspectShowMedia({file:path.join(stage,'session.skshow')}),statuses=await inspectSessionMedia({directory:stage});
  if(staged.sha256!==currentHash||statuses.showSha256!==currentHash)throw Error('Staged session verification failed');
  if(staged.diagnostics.some(d=>MAP_DIAGNOSTICS.includes(d.code)))throw Error('Staged media.map verification failed');
  const expected=[...inventory.mappings.map(m=>[m.sourcePath,m.archivePath]),...added.map(a=>[a.sourcePath,a.archivePath])];
  if(staged.mappings.length!==expected.length||staged.mappings.some((m,i)=>m.sourcePath!==expected[i][0]||m.archivePath!==expected[i][1]))throw Error('Staged media.map rows do not match the plan');
  const sizes=new Map(sidecars.map(s=>[s.archivePath,s.size])),allowedMissing=new Set(missing.map(m=>m.archivePath));
  for(const finding of statuses.findings){
   if(finding.status==='regular_file'?finding.size!==sizes.get(finding.archivePath):!(finding.status==='missing'&&allowedMissing.has(finding.archivePath)))throw Error(`Staged sidecar verification failed: ${finding.archivePath} is ${finding.status}`);
  }
  for(const row of added)row.line=staged.mappings.find(m=>m.sourcePath===row.sourcePath).line;
  const sidecarState=row=>allowedMissing.has(row.archivePath)?'missing':'copied';
  const rowsBySource=new Map(staged.mappings.map(m=>[m.sourcePath,m])),clipLinks=[];
  for(const [trackIndex,track] of resolvedTracks.entries())for(const [clipItemIndex,item] of (track?.audioClips??[]).entries()){
   const file=item?.clip?.file,row=rowsBySource.get(file);
   clipLinks.push({trackIndex,clipItemIndex,file,...(row?{mappingLine:row.line,archivePath:row.archivePath,sidecar:sidecarState(row)}:{mappingLine:null})});
   if(!row)warnings.push({code:'clip_file_unmapped',trackIndex,clipItemIndex,file,message:'The clip file is not a media.map source path in the new session.'});
   else if(allowedMissing.has(row.archivePath))warnings.push({code:'clip_sidecar_missing',trackIndex,clipItemIndex,file,archivePath:row.archivePath});
  }
  // A clip edit that sets file changes the clip media; link it like a new clip.
  for(const [trackIndex,track] of resolvedTracks.entries())for(const [clipEditIndex,edit] of (track?.audioClipEdits??[]).entries()){
   if(!edit?.attributes||!Object.hasOwn(edit.attributes,'file'))continue;
   const file=edit.attributes.file,row=rowsBySource.get(file);
   clipLinks.push({trackIndex,clipEditIndex,file,...(row?{mappingLine:row.line,archivePath:row.archivePath,sidecar:sidecarState(row)}:{mappingLine:null})});
   if(!row)warnings.push({code:'clip_file_unmapped',trackIndex,clipEditIndex,file,message:'The edited clip file is not a media.map source path in the new session.'});
   else if(allowedMissing.has(row.archivePath))warnings.push({code:'clip_sidecar_missing',trackIndex,clipEditIndex,file,archivePath:row.archivePath});
  }
  // Rows are never removed. Report rows that a clip named before the composition and none names now.
  const named=clips=>new Set(clips.map(c=>c.attributes.file).filter(f=>typeof f==='string'));
  const namedBefore=named(inventory.clips),namedAfter=named(staged.clips);
  for(const row of inventory.mappings)if(namedBefore.has(row.sourcePath)&&!namedAfter.has(row.sourcePath))warnings.push({code:'mapping_no_longer_referenced',line:row.line,sourcePath:row.sourcePath,archivePath:row.archivePath,message:'No track or Program clip in the new session.skshow names this source path. The media.map row and its sidecar are kept.'});
  // Program item clips come from the staged inventory, including clips embedded from staged tracks.
  const programClipLinks=program===undefined?undefined:staged.clips.filter(c=>c.itemIndex!==undefined).map(c=>{
   const file=c.attributes.file??null,row=typeof file==='string'?rowsBySource.get(file):undefined,scope={itemIndex:c.itemIndex,audioIndex:c.audioIndex,clipIndex:c.clipIndex};
   if(file&&!row)warnings.push({code:'program_clip_file_unmapped',...scope,file,message:'The Program item clip file is not a media.map source path in the new session.'});
   else if(row&&allowedMissing.has(row.archivePath))warnings.push({code:'program_clip_sidecar_missing',...scope,file,archivePath:row.archivePath});
   return {...scope,file,...(row?{mappingLine:row.line,archivePath:row.archivePath,sidecar:sidecarState(row)}:{mappingLine:null})};
  });
  if((await inspectShow({file:show})).sha256!==sha256)throw Error('Source changed during session copy');
  const recheck=await walkSession(root),key=e=>`${e.rel}\0${e.planned?.dev}:${e.planned?.ino}`;
  const seen=[...recheck.files.filter(f=>!isSidecar(f.rel,f.planned)),...recheck.dirs,...recheck.rejected].map(key).sort(),planned=[...walk.files,...walk.dirs,...walk.rejected].map(key).sort();
  if(seen.join('\n')!==planned.join('\n')||walk.files.some(f=>!sameEntry(f.planned,recheck.files.find(r=>r.rel===f.rel).planned)))throw Error('Source session working files changed during session copy');
  await publishDirectory(stage,target);published=true;
  const sessionFile=path.join(target,'session.skshow');
  result={source:root,destination:target,sessionFile,sourceSha256:sha256,sha256:currentHash,
   mediaMap:{created:added.length>0&&!inventory.mapParts.length,preservedRows:inventory.mappings.length,addedRows:added.map(({mediaIndex,sourcePath,archivePath,line})=>({mediaIndex,line,sourcePath,archivePath}))},
   sidecars,missingSidecars:missing.map(({archivePath,lines})=>({archivePath,lines})),
   ...(composition?{tracks:composition.tracks.map(t=>t.mediaClone?{...t,mediaClone:{...t.mediaClone,destination:sessionFile}}:t),setlistOperations:composition.setlistOperations}:{}),
   ...(composition?.program?{program:composition.program}:{}),
   clipLinks,...(programClipLinks?{programClipLinks}:{}),workingFiles:{count:workingFiles.length,directories:walk.dirs.length,entries:workingFiles.slice(0,MAX_REPORTED),truncated:workingFiles.length>MAX_REPORTED},
   warnings:[...warnings,...working.warnings,...(composition?.warnings??[])],
   ...(validation?{validation:{...validation,file:sessionFile,note:`${validation.note.replace(/ Validation was performed before publication\.$/,'')} Validation was performed on the staged session.skshow before publication.`}}:{}),
   limitations:['Follows one observed R27 session layout: media.map rows map an original absolute path to a MEDIA/ sidecar beside session.skshow. ShowKontrol has not opened, played or relinked a generated session.','Working files are related to archive parts by path, exact content or file name. Only session.skf to patch.skf (equal except the root name) is backed by app evidence; whether ShowKontrol reads working files or session.skshow when it opens a session directory is unverified. File permissions and timestamps are not preserved.','Sidecars are byte-verified copies. Media format, duration, waveform caches and clip timing against the media are not checked.',...(program!==undefined?['The Program follows static R27 format evidence only. ShowKontrol has not loaded a generated Program, sorted its items, run item graphs or resolved Program item clips through media.map.']:[])]};
  if(composition?.cleanupWarnings)cleanupWarnings.push(...composition.cleanupWarnings);
 }finally{
  const failures=[];
  for(const dir of published?[work]:[work,stage].filter(Boolean)){
   try{await rm(dir,{recursive:true,force:true});}
   catch(error){failures.push(error);cleanupWarnings.push(`Published session is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`);}
  }
  if(failures.length&&!published)throw failures[0];
 }
 if(cleanupWarnings.length)result.cleanupWarnings=cleanupWarnings;
 return result;
}
