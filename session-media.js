import path from 'node:path';
import {lstat,realpath} from 'node:fs/promises';
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
 return {directory:root,showSha256:show.sha256,findings,diagnostics:show.diagnostics,limitations:['Checks sidecar file metadata only; does not open media, compare contents, resolve original source paths, or test playback.','A matching path does not prove that ShowKontrol uses the sidecar or that the session is portable.']};
}
