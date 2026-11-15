import path from 'node:path';
import {mkdtemp,link,rm} from 'node:fs/promises';
import {readShowSnapshot,readSnapshotPart,writeShowMediaMapCopy} from './xml-copy.js';
import {inspectShowMedia} from './media-inventory.js';
import {MAP_DIAGNOSTICS,nameKey,checkSourcePath,checkSidecarName,appendMappingRows} from './session-media-copy.js';
import {planMappingOperations,editMappingText,vanishingValues,findReferences,assertUnreferenced,mappingReceipts} from './media-map-rows.js';

const MAX_MAPPINGS=100;

// Append literal source-to-MEDIA rows to the media.map of a show copy, or create the part when asked. No media file is read or copied.
export async function addMediaMappingsCopy({source,destination,sha256,mappings,createMediaMap=false}){
 if(typeof source!=='string'||!path.isAbsolute(source)||typeof destination!=='string'||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(typeof sha256!=='string')throw Error('Supply the inspected show SHA-256');
 if(!Array.isArray(mappings)||!mappings.length||mappings.length>MAX_MAPPINGS)throw Error(`Provide 1 to ${MAX_MAPPINGS} mappings`);
 if(typeof createMediaMap!=='boolean')throw Error('createMediaMap must be a boolean');
 const inventory=await inspectShowMedia({file:source});
 if(inventory.sha256!==sha256)throw Error('Source changed since inspection');
 // Creation is explicit, so a caller that expected an existing map never gets a new one.
 if(inventory.mapParts.length>1)throw Error('The show must contain at most one media.map part');
 if(!inventory.mapParts.length&&!createMediaMap)throw Error('The show has no media.map part; set createMediaMap to true to create one');
 if(inventory.mapParts.length&&createMediaMap)throw Error('The show already has a media.map part; omit createMediaMap to append to it');
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
 // A created map gets the session composer's form: UTF-8 without a byte order mark, LF after every row.
 const text=createMediaMap?'':readSnapshotPart({snapshot,name:'media.map'}).text;
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-media-map-'));let published=false,result;
 try{
  const staged=path.join(dir,'mapped.skshow'),written=await writeShowMediaMapCopy({source,destination:staged,sha256,text:appendMappingRows(text,rows)});
  // An existing map must never be replaced by one holding only the new rows.
  if(written.added!==createMediaMap)throw Error('Staged media.map part does not match the plan');
  // Parse the staged copy back: every earlier row is kept and the new rows follow in order.
  const after=await inspectShowMedia({file:staged});
  if(after.sha256!==written.sha256)throw Error('Staged show changed during verification');
  const expected=[...inventory.mappings,...rows];
  if(after.diagnostics.some(d=>MAP_DIAGNOSTICS.includes(d.code))||after.mappings.length!==expected.length||after.mappings.some((m,i)=>m.sourcePath!==expected[i].sourcePath||m.archivePath!==expected[i].archivePath))throw Error('Staged media.map rows do not match the plan');
  await link(staged,destination);published=true;
  const added=after.mappings.slice(inventory.mappings.length).map(m=>({line:m.line,sourcePath:m.sourcePath,archivePath:m.archivePath,
   archiveParts:m.archiveMatches.map(({name,valid,size})=>({name,valid,size})),
   clips:after.clips.filter(c=>c.attributes.file===m.sourcePath).map(c=>({part:c.part,...(c.itemIndex===undefined?{}:{itemIndex:c.itemIndex}),audioIndex:c.audioIndex,clipIndex:c.clipIndex}))}));
  result={destination,sha256:written.sha256,md5:written.md5,mediaMap:{created:createMediaMap,rowsBefore:inventory.mappings.length,rowsAfter:after.mappings.length},mappings:added,
   note:createMediaMap?'A media.map part holding only the new rows was added as the last part of the wrapper; every other part and the wrapper text around it are byte-identical. The part position and row form follow the session composer, not an app-saved file, and whether ShowKontrol reads a map added to a show without one is unverified. No media file is read or copied, and no MEDIA/ sidecar or archive part is created. Whether ShowKontrol loads, relinks or plays the mapped media is unverified.':'Only literal media.map rows were appended; every other part is byte-identical. No media file is read or copied, and no MEDIA/ sidecar or archive part is created. Whether ShowKontrol loads, relinks or plays the mapped media is unverified.'};
 }finally{
  try{await rm(dir,{recursive:true,force:true});}catch(error){if(!published)throw error;result.cleanupWarning=`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`;}
 }
 return result;
}

// Remove or re-point existing media.map rows of a show copy. A value that leaves the map must not be referenced by any other part.
export async function editMediaMappingsCopy({source,destination,sha256,operations}){
 if(typeof source!=='string'||!path.isAbsolute(source)||typeof destination!=='string'||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(typeof sha256!=='string')throw Error('Supply the inspected show SHA-256');
 if(!Array.isArray(operations)||!operations.length)throw Error('Provide at least one mapping operation');
 const inventory=await inspectShowMedia({file:source});
 if(inventory.sha256!==sha256)throw Error('Source changed since inspection');
 if(inventory.mapParts.length!==1)throw Error('The show must contain exactly one media.map part');
 const problems=[...new Set(inventory.diagnostics.filter(d=>MAP_DIAGNOSTICS.includes(d.code)).map(d=>d.code))];
 if(problems.length)throw Error(`media.map rows cannot be selected unambiguously: ${problems.join(', ')}`);
 const plan=planMappingOperations(inventory,operations);
 const snapshot=await readShowSnapshot({file:source});if(snapshot.sha256!==sha256)throw Error('Source changed since inspection');
 // Only media.map changes, so references are checked in the source parts.
 assertUnreferenced(findReferences({snapshot,inventory,targets:vanishingValues(plan,plan.rows)}),'This tool changes only media.map: first re-point or remove those references in another copy (for example with showkontrol_edit_timeline_audio_clip_copy), or keep the row');
 const text=editMappingText(readSnapshotPart({snapshot,name:'media.map'}).text,plan.edits);
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-media-map-'));let published=false,result;
 try{
  const staged=path.join(dir,'mapped.skshow'),written=await writeShowMediaMapCopy({source,destination:staged,sha256,text});
  const after=await inspectShowMedia({file:staged});
  if(after.sha256!==written.sha256)throw Error('Staged show changed during verification');
  if(after.diagnostics.some(d=>MAP_DIAGNOSTICS.includes(d.code))||after.mappings.length!==plan.rows.length||after.mappings.some((m,i)=>m.line!==plan.rows[i].line||m.sourcePath!==plan.rows[i].sourcePath||m.archivePath!==plan.rows[i].archivePath))throw Error('Staged media.map rows do not match the plan');
  await link(staged,destination);published=true;
  // MEDIA/ archive parts are never removed. Report those no row names any more.
  const mapped=new Set(after.mappings.map(m=>m.archivePath)),released=new Set(plan.changes.map(c=>c.row.archivePath));
  const unmappedArchiveParts=after.archiveParts.filter(p=>!mapped.has(p.name)).map(({name,valid,size})=>({name,valid,size,reason:released.has(name)?'mapping_changed':'unmapped_in_source'}));
  const warnings=plan.rows.length?[]:[{code:'media_map_empty',message:'Every row was removed. The media.map part is kept with no rows; whether ShowKontrol accepts an empty media.map is unverified.'}];
  result={destination,sha256:written.sha256,md5:written.md5,operations:mappingReceipts(plan),mediaMap:{rowsBefore:inventory.mappings.length,rowsAfter:plan.rows.length},unmappedArchiveParts,warnings,
   note:'Only the selected media.map rows were removed or rewritten; other rows, every other part and the wrapper are byte-identical. No media file or MEDIA/ archive part is read, created or removed. Whether ShowKontrol loads, relinks or plays media through the changed rows, or needs a removed row, is unverified.'};
 }finally{
  try{await rm(dir,{recursive:true,force:true});}catch(error){if(!published)throw error;result.cleanupWarning=`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`;}
 }
 return result;
}
