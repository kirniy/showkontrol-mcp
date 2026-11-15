import path from 'node:path';
import {constants} from 'node:fs';
import {open,lstat,mkdir,mkdtemp,readdir,rename,rm,realpath,link,statfs} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inspectShow,readShowSnapshot,readSnapshotPart,writeShowMediaMapCopy} from './xml-copy.js';
import {inspectShowMedia} from './media-inventory.js';
import {inspectSessionMedia,sidecarStatus,sidecarSegments} from './session-media.js';
import {composeMultiTrackShowCopy} from './compose-multi-show.js';

const MAX_MEDIA=100, MAX_REPORTED=100, CHUNK=1024*1024, DEFAULT_MAX_COPY_BYTES=4*1024**3;
const MAP_DIAGNOSTICS=['duplicate_media_map','invalid_media_map_checksum','invalid_media_map_utf8','malformed_mapping','duplicate_source'];
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
const nameKey=archivePath=>archivePath.normalize('NFC').toLowerCase();
function checkSourcePath(file){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file||file.endsWith('/')||file.length>4096||UNSAFE_TEXT.test(file))throw Error(`Media source must be a normalized absolute file path without control characters: ${JSON.stringify(file)}`);
}
function checkSidecarName(name){
 if(typeof name!=='string'||!name||name.startsWith('.')||/[/\\:]/.test(name)||UNSAFE_TEXT.test(name)||Buffer.byteLength(name)>255)throw Error(`Sidecar name must be one visible file name of at most 255 bytes without slashes, colons or control characters: ${JSON.stringify(name)}`);
}
async function absent(file){
 try{await lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
 throw Error('Destination session already exists');
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
function appendMappingRows(text,rows){
 const eol=text.includes('\r\n')?'\r\n':'\n',separator=text.replace(/^\ufeff/,'')&&!text.endsWith('\n')?eol:'';
 return text+separator+rows.map(row=>`${row.sourcePath}\t${row.archivePath}${eol}`).join('');
}
async function listNotCopied(root,mapped){
 const sessionEntries=[],mediaEntries=[];let sessionCount=0,mediaCount=0;
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(entry.name==='session.skshow'||(entry.name==='MEDIA'&&entry.isDirectory()))continue;
  sessionCount++;if(sessionEntries.length<MAX_REPORTED)sessionEntries.push(entry.name);
 }
 const used=new Set([...mapped].map(archivePath=>archivePath.split('/')[1]));
 try{
  for(const entry of await readdir(path.join(root,'MEDIA'),{withFileTypes:true})){
   if(used.has(entry.name))continue;
   mediaCount++;if(mediaEntries.length<MAX_REPORTED)mediaEntries.push(entry.name);
  }
 }catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
 return {sessionEntries,sessionEntryCount:sessionCount,mediaEntries,mediaEntryCount:mediaCount};
}

// Create a new session directory: composed session.skshow, extended media.map and verified MEDIA sidecar copies.
export async function composeSessionMediaCopy({source,destination,sha256,media=[],tracks,patchOperations,setlistOperations,allowMissingSidecars=false}){
 if(typeof source!=='string'||!path.isAbsolute(source)||typeof destination!=='string'||!path.isAbsolute(destination))throw Error('Source and destination session directories must be absolute paths');
 if(typeof sha256!=='string')throw Error('Supply the inspected session.skshow SHA-256');
 if(!Array.isArray(media)||media.length>MAX_MEDIA)throw Error(`Media must be an array of at most ${MAX_MEDIA} entries`);
 if(typeof allowMissingSidecars!=='boolean')throw Error('allowMissingSidecars must be a boolean');
 if(tracks!==undefined&&!Array.isArray(tracks))throw Error('Tracks must be an array');
 const composing=Boolean(tracks?.length)||patchOperations!==undefined||setlistOperations!==undefined;
 if(!media.length&&!composing)throw Error('Add media, tracks or operations');
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
 const resolvedTracks=(tracks??[]).map((track,trackIndex)=>!track||typeof track!=='object'||!Array.isArray(track.audioClips)?track:{...track,audioClips:track.audioClips.map((item,clipItemIndex)=>{
  if(!item||typeof item!=='object'||item.mediaIndex===undefined)return item;
  const {mediaIndex,...rest}=item;
  if(!Number.isSafeInteger(mediaIndex)||!added[mediaIndex])throw Error(`Track ${trackIndex} audio clip ${clipItemIndex}: mediaIndex must select an entry in media`);
  if(!rest.clip||typeof rest.clip!=='object'||Array.isArray(rest.clip)||Object.hasOwn(rest.clip,'file'))throw Error(`Track ${trackIndex} audio clip ${clipItemIndex}: mediaIndex supplies clip.file; omit file`);
  return {...rest,clip:{...rest.clip,file:added[mediaIndex].sourcePath}};
 })});
 const copies=[],missing=[];let total=0;
 for(const entry of existing.values()){
  const status=await sidecarStatus(root,entry.archivePath);
  if(status.status==='missing'&&allowMissingSidecars){missing.push(entry);continue;}
  if(status.status!=='regular_file')throw Error(`Mapped sidecar ${entry.archivePath} is ${status.status}${status.status==='missing'?'; set allowMissingSidecars to keep its mapping without a file':''}`);
  copies.push({...entry,origin:'existing',from:status.file,planned:status,segments:sidecarSegments(entry.archivePath),label:'Session sidecar'});total+=status.size;
 }
 for(const entry of added){
  let info;try{info=await lstat(entry.sourcePath);}catch(error){throw Error(`Media source ${error.code==='ENOENT'?'not found':'cannot be checked'}: ${entry.sourcePath}`);}
  if(info.isSymbolicLink())throw Error(`Media source is a symlink; supply the file path: ${entry.sourcePath}`);
  if(!info.isFile())throw Error(`Media source is not a regular file: ${entry.sourcePath}`);
  if(!info.size)throw Error(`Media source is empty: ${entry.sourcePath}`);
  copies.push({...entry,origin:'added',from:entry.sourcePath,planned:info,segments:sidecarSegments(entry.archivePath),label:'Media source'});total+=info.size;
 }
 const limit=copyLimit();if(total>limit)throw Error(`Sidecar copies total ${total} bytes, above the ${limit}-byte limit (SHOWKONTROL_SESSION_MEDIA_MAX_BYTES)`);
 const space=await statfs(parent);if(total+2*(await lstat(show)).size>space.bavail*space.bsize)throw Error('Destination volume does not have enough free space for the session copy');
 const work=await mkdtemp(path.join(parent,'.showkontrol-session-work-'));
 let stage,published=false,result;const cleanupWarnings=[];
 try{
  stage=await mkdtemp(path.join(parent,'.showkontrol-session-'));
  let current=show,currentHash=sha256,composition;
  if(composing){
   const next=path.join(work,'composed.skshow');
   composition=await composeMultiTrackShowCopy({source:show,destination:next,sha256,tracks:resolvedTracks,patchOperations,setlistOperations});
   current=next;currentHash=composition.sha256;
  }
  if(added.length){
   const snapshot=await readShowSnapshot({file:current});if(snapshot.sha256!==currentHash)throw Error('Staged show changed during composition');
   const text=snapshot.parts.some(p=>p.name==='media.map')?readSnapshotPart({snapshot,name:'media.map'}).text:'';
   const next=path.join(work,'mapped.skshow'),written=await writeShowMediaMapCopy({source:current,destination:next,sha256:currentHash,text:appendMappingRows(text,added)});
   current=next;currentHash=written.sha256;
  }
  const sidecars=[];
  for(const copy of copies){
   const file=path.join(stage,...copy.segments);await mkdir(path.dirname(file),{recursive:true});
   const {size,sha256:digest}=await copyVerified({from:copy.from,planned:copy.planned,target:file,label:copy.label});
   sidecars.push({archivePath:copy.archivePath,origin:copy.origin,from:copy.from,size,sha256:digest,...(copy.lines?{lines:copy.lines}:{mediaIndex:copy.mediaIndex})});
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
  const rowsBySource=new Map(staged.mappings.map(m=>[m.sourcePath,m])),clipLinks=[];
  for(const [trackIndex,track] of resolvedTracks.entries())for(const [clipItemIndex,item] of (track?.audioClips??[]).entries()){
   const file=item?.clip?.file,row=rowsBySource.get(file);
   clipLinks.push({trackIndex,clipItemIndex,file,...(row?{mappingLine:row.line,archivePath:row.archivePath,sidecar:allowedMissing.has(row.archivePath)?'missing':'copied'}:{mappingLine:null})});
   if(!row)warnings.push({code:'clip_file_unmapped',trackIndex,clipItemIndex,file,message:'The clip file is not a media.map source path in the new session.'});
   else if(allowedMissing.has(row.archivePath))warnings.push({code:'clip_sidecar_missing',trackIndex,clipItemIndex,file,archivePath:row.archivePath});
  }
  const notCopied=await listNotCopied(root,existing.keys());
  if((await inspectShow({file:show})).sha256!==sha256)throw Error('Source changed during session copy');
  await absent(target);
  await rename(stage,target);published=true;
  const sessionFile=path.join(target,'session.skshow');
  result={source:root,destination:target,sessionFile,sourceSha256:sha256,sha256:currentHash,
   mediaMap:{created:added.length>0&&!inventory.mapParts.length,preservedRows:inventory.mappings.length,addedRows:added.map(({mediaIndex,sourcePath,archivePath,line})=>({mediaIndex,line,sourcePath,archivePath}))},
   sidecars,missingSidecars:missing.map(({archivePath,lines})=>({archivePath,lines})),
   ...(composition?{tracks:composition.tracks.map(t=>t.mediaClone?{...t,mediaClone:{...t.mediaClone,destination:sessionFile}}:t),setlistOperations:composition.setlistOperations}:{}),
   clipLinks,warnings:[...warnings,...(composition?.warnings??[])],notCopied,
   limitations:['Follows one observed R27 session layout: media.map rows map an original absolute path to a MEDIA/ sidecar beside session.skshow. ShowKontrol has not opened, played or relinked a generated session.','Other session files are not copied; ShowKontrol may need to regenerate working files. File permissions and timestamps are not preserved.','Sidecars are byte-verified copies. Media format, duration, waveform caches and clip timing against the media are not checked.']};
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
