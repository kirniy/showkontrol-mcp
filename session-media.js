import path from 'node:path';
import {lstat,readdir,realpath} from 'node:fs/promises';
import {inspectShowMedia} from './media-inventory.js';

export function sidecarSegments(archivePath){
 const segments=archivePath.split('/');
 return segments[0]!=='MEDIA'||segments.length<2||segments.some(s=>!s||s==='.'||s==='..'||s.includes('\\')||s.includes('\0'))?null:segments;
}

// Walk a mapped sidecar without following symlinks. The final identity lets callers detect a later swap.
export async function sidecarStatus(root,archivePath){
 const segments=sidecarSegments(archivePath);if(!segments)return {status:'unsafe_path'};
 let current=root;
 try{
  for(let i=0;i<segments.length;i++){
   current=path.join(current,segments[i]);const info=await lstat(current);
   if(info.isSymbolicLink())return {status:'symlink'};
   if(i<segments.length-1&&!info.isDirectory())return {status:'not_directory'};
   if(i===segments.length-1)return info.isFile()?{status:'regular_file',size:info.size,file:current,dev:info.dev,ino:info.ino}:{status:'not_regular_file'};
  }
 }catch(error){return {status:error.code==='ENOENT'||error.code==='ENOTDIR'?'missing':'unreadable'};}
}

const MAX_MEDIA_ENTRIES=10000,MAX_MEDIA_DEPTH=32;
// List MEDIA/ entries that no media.map row names, without following symlinks.
async function unmappedMediaEntries(root,mapped){
 const out=[];let count=0;
 async function visit(dir,rel,depth){
  for(const name of (await readdir(dir)).sort()){
   if(++count>MAX_MEDIA_ENTRIES)throw Error(`MEDIA/ has more than ${MAX_MEDIA_ENTRIES} entries`);
   const childRel=`${rel}/${name}`,file=path.join(dir,name),info=await lstat(file);
   if(info.isDirectory()){if(depth>=MAX_MEDIA_DEPTH)throw Error(`MEDIA/ is nested deeper than ${MAX_MEDIA_DEPTH} directories`);await visit(file,childRel,depth+1);}
   else if(!mapped.has(childRel))out.push({path:childRel,kind:info.isFile()?'regular_file':info.isSymbolicLink()?'symlink':'special_file',...(info.isFile()?{size:info.size}:{})});
  }
 }
 let info;try{info=await lstat(path.join(root,'MEDIA'));}catch(error){if(error.code==='ENOENT')return out;throw error;}
 if(info.isDirectory())await visit(path.join(root,'MEDIA'),'MEDIA',1);
 return out;
}

// Inspect only regular sidecar files below the selected session, without following symlinks.
export async function inspectSessionMedia({directory}) {
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('Session directory must be an absolute path');
 const root=await realpath(directory), archive=path.join(root,'session.skshow');
 const show=await inspectShowMedia({file:archive});
 const findings=[];
 for(const mapping of show.mappings){
  const {status,size}=await sidecarStatus(root,mapping.archivePath);
  findings.push({line:mapping.line,archivePath:mapping.archivePath,status,...(size!==undefined?{size}:{})});
 }
 // Lanes and clips with the media.map row whose source path equals the clip file, for choosing audio edits and removals.
 const scope=item=>({part:item.part,...(item.itemIndex!==undefined?{itemIndex:item.itemIndex}:{})});
 const rows=new Map();for(const [i,m] of show.mappings.entries())rows.set(m.sourcePath,[...(rows.get(m.sourcePath)??[]),{m,finding:findings[i]}]);
 const lanes=show.timelines.flatMap(t=>t.lanes.map(lane=>({...scope(t),...lane})));
 const clips=show.clips.map(c=>{
  const file=c.attributes.file,list=typeof file==='string'?rows.get(file)??[]:[];
  // Duplicate source rows are reported as a diagnostic; none of them is chosen here.
  const mapping=list.length===1?{line:list[0].m.line,archivePath:list[0].m.archivePath,sidecar:list[0].finding.status}:list.length?{ambiguousLines:list.map(r=>r.m.line)}:null;
  return {...scope(c),audioIndex:c.audioIndex,clipIndex:c.clipIndex,attributes:c.attributes,mapping};
 });
 const unmapped=await unmappedMediaEntries(root,new Set(show.mappings.map(m=>m.archivePath)));
 return {directory:root,showSha256:show.sha256,findings,lanes,clips,unmappedMediaEntries:unmapped,diagnostics:show.diagnostics,limitations:['Checks sidecar file metadata only; does not open media, compare contents, resolve original source paths, or test playback.','A matching path does not prove that ShowKontrol uses the sidecar or that the session is portable.','A clip mapping is an exact match of the clip file attribute to a media.map source path. Whether ShowKontrol resolves the clip through that row is unverified.','unmappedMediaEntries lists files below MEDIA/ that no media.map row names exactly; whether ShowKontrol uses or needs them is unknown.']};
}
