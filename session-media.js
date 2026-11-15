import path from 'node:path';
import {lstat,realpath} from 'node:fs/promises';
import {inspectShowMedia} from './media-inventory.js';

// Inspect only regular sidecar files below the selected session, without following symlinks.
export async function inspectSessionMedia({directory}) {
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('Session directory must be an absolute path');
 const root=await realpath(directory), archive=path.join(root,'session.skshow');
 const show=await inspectShowMedia({file:archive});
 const findings=[];
 for(const mapping of show.mappings){
  const segments=mapping.archivePath.split('/');
  if(segments[0]!=='MEDIA'||segments.length<2||segments.some(s=>!s||s==='.'||s==='..'||s.includes('\\')||s.includes('\0'))){
   findings.push({line:mapping.line,archivePath:mapping.archivePath,status:'unsafe_path'});continue;
  }
  let current=root,status='regular_file',size;
  try{
   for(let i=0;i<segments.length;i++){
    current=path.join(current,segments[i]);const info=await lstat(current);
    if(info.isSymbolicLink()){status='symlink';break;}
    if(i<segments.length-1&&!info.isDirectory()){status='not_directory';break;}
    if(i===segments.length-1){if(!info.isFile())status='not_regular_file';else size=info.size;}
   }
  }catch(error){status=error.code==='ENOENT'||error.code==='ENOTDIR'?'missing':'unreadable';}
  findings.push({line:mapping.line,archivePath:mapping.archivePath,status,...(size!==undefined?{size}:{})});
 }
 return {directory:root,showSha256:show.sha256,findings,diagnostics:show.diagnostics,limitations:['Checks sidecar file metadata only; does not open media, compare contents, resolve original source paths, or test playback.','A matching path does not prove that ShowKontrol uses the sidecar or that the session is portable.']};
}
