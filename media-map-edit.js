import path from 'node:path';
import {mkdtemp,link,rm} from 'node:fs/promises';
import {readShowSnapshot,readSnapshotPart,writeShowMediaMapCopy} from './xml-copy.js';
import {inspectShowMedia} from './media-inventory.js';
import {MAP_DIAGNOSTICS,nameKey,checkSourcePath,checkSidecarName,appendMappingRows} from './session-media-copy.js';

const MAX_MAPPINGS=100;

// Append literal source-to-MEDIA rows to the existing media.map of a show copy. No media file is read or copied.
export async function addMediaMappingsCopy({source,destination,sha256,mappings}){
 if(typeof source!=='string'||!path.isAbsolute(source)||typeof destination!=='string'||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(typeof sha256!=='string')throw Error('Supply the inspected show SHA-256');
 if(!Array.isArray(mappings)||!mappings.length||mappings.length>MAX_MAPPINGS)throw Error(`Provide 1 to ${MAX_MAPPINGS} mappings`);
 const inventory=await inspectShowMedia({file:source});
 if(inventory.sha256!==sha256)throw Error('Source changed since inspection');
 if(inventory.mapParts.length!==1)throw Error('The show must contain exactly one media.map part; use showkontrol_compose_session_media_copy to create one in a session');
 const problems=[...new Set(inventory.diagnostics.filter(d=>MAP_DIAGNOSTICS.includes(d.code)).map(d=>d.code))];
 if(problems.length)throw Error(`media.map cannot be extended safely: ${problems.join(', ')}`);
 const sources=new Map(inventory.mappings.map(m=>[m.sourcePath,m.line])),keys=new Map(inventory.mappings.map(m=>[nameKey(m.archivePath),m.archivePath])),rows=[];
 for(const [index,item] of mappings.entries()){
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['sourcePath','archivePath'].includes(k)))throw Error(`Invalid mapping at index ${index}`);
  const {sourcePath,archivePath}=item;
  checkSourcePath(sourcePath);
  if(typeof archivePath!=='string'||!archivePath.startsWith('MEDIA/'))throw Error(`Mapping ${index}: archivePath must name one file directly in MEDIA/`);
  checkSidecarName(archivePath.slice(6));
  if(sources.has(sourcePath))throw Error(`Mapping ${index}: source is already mapped${sources.get(sourcePath)?` on media.map line ${sources.get(sourcePath)}`:' in this call'}: ${sourcePath}`);
  // Each new row needs its own sidecar name; names are compared as on a case-insensitive, normalizing volume.
  const key=nameKey(archivePath),clash=keys.get(key)??[...keys.entries()].find(([other])=>other.startsWith(key+'/'))?.[1];
  if(clash)throw Error(`Mapping ${index}: ${archivePath} collides with mapped ${clash}; names are compared without case after Unicode normalization`);
  sources.set(sourcePath,null);keys.set(key,archivePath);rows.push({sourcePath,archivePath});
 }
 const snapshot=await readShowSnapshot({file:source});if(snapshot.sha256!==sha256)throw Error('Source changed since inspection');
 const text=readSnapshotPart({snapshot,name:'media.map'}).text;
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-media-map-'));let published=false,result;
 try{
  const staged=path.join(dir,'mapped.skshow'),written=await writeShowMediaMapCopy({source,destination:staged,sha256,text:appendMappingRows(text,rows)});
  // Parse the staged copy back: every earlier row is kept and the new rows follow in order.
  const after=await inspectShowMedia({file:staged});
  if(after.sha256!==written.sha256)throw Error('Staged show changed during verification');
  const expected=[...inventory.mappings,...rows];
  if(after.diagnostics.some(d=>MAP_DIAGNOSTICS.includes(d.code))||after.mappings.length!==expected.length||after.mappings.some((m,i)=>m.sourcePath!==expected[i].sourcePath||m.archivePath!==expected[i].archivePath))throw Error('Staged media.map rows do not match the plan');
  await link(staged,destination);published=true;
  const added=after.mappings.slice(inventory.mappings.length).map(m=>({line:m.line,sourcePath:m.sourcePath,archivePath:m.archivePath,
   archiveParts:m.archiveMatches.map(({name,valid,size})=>({name,valid,size})),
   clips:after.clips.filter(c=>c.attributes.file===m.sourcePath).map(c=>({part:c.part,...(c.itemIndex===undefined?{}:{itemIndex:c.itemIndex}),audioIndex:c.audioIndex,clipIndex:c.clipIndex}))}));
  result={destination,sha256:written.sha256,md5:written.md5,mappings:added,note:'Only literal media.map rows were appended; every other part is byte-identical. No media file is read or copied, and no MEDIA/ sidecar or archive part is created. Whether ShowKontrol loads, relinks or plays the mapped media is unverified.'};
 }finally{
  try{await rm(dir,{recursive:true,force:true});}catch(error){if(!published)throw error;result.cleanupWarning=`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`;}
 }
 return result;
}
