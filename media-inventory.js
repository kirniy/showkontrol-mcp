import {readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseTimeline} from './timeline.js';

const MAX_ITEMS=10000, MAX_TEXT_BYTES=2*1024*1024;

// Report exact strings and archive membership only. Never open a referenced path.
export async function inspectShowMedia({file}){
 const snapshot=await readShowSnapshot({file});
 const diagnostics=[], mappings=[], clips=[];let references=0;
 const partsByName=new Map();
 for(const part of snapshot.parts){const group=partsByName.get(part.name)||[];group.push(part);partsByName.set(part.name,group);}
 const maps=partsByName.get('media.map')||[];
 const summary=p=>({name:p.name,md5:p.md5,valid:p.valid,size:p.bytes.length});
 const mapParts=maps.map(summary);
 const archiveParts=snapshot.parts.filter(p=>p.name.startsWith('MEDIA/')).map(summary);
 if(maps.length>1) diagnostics.push({code:'duplicate_media_map',count:maps.length});
 if(maps.length===1){
  const part=maps[0];
  if(!part.valid) diagnostics.push({code:'invalid_media_map_checksum'});
  else if(part.bytes.length>MAX_TEXT_BYTES) throw Error('media.map exceeds inventory text limit');
  else {
   let text;
   try{text=readSnapshotPart({snapshot,name:'media.map'}).text;}catch{diagnostics.push({code:'invalid_media_map_utf8'});}
   if(text!==undefined){
    const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);if(lines.length>MAX_ITEMS+1)throw Error('media.map exceeds inventory item limit');
    for(let i=0;i<lines.length;i++){
     const line=lines[i];if(i===lines.length-1&&line==='')continue;
     const fields=line.split('\t');
     if(fields.length!==2||!fields[0]||!fields[1]||!fields[1].startsWith('MEDIA/')){diagnostics.push({code:'malformed_mapping',line:i+1,raw:line});continue;}
     const [sourcePath,archivePath]=fields;
     const matches=partsByName.get(archivePath)||[];
     references+=matches.length;if(references>MAX_ITEMS)throw Error('Media inventory exceeds reference limit');
     mappings.push({line:i+1,sourcePath,archivePath,archiveMatches:matches.map(summary)});
    }
    for(const [field,code] of [['sourcePath','duplicate_source'],['archivePath','duplicate_archive_path']]){
     const groups=new Map();for(const m of mappings){const list=groups.get(m[field])||[];list.push(m.line);groups.set(m[field],list);}
     for(const [value,lines] of groups)if(lines.length>1)diagnostics.push({code,value,lines});
    }
   }
  }
 }
 const mappingIndex=new Map();
 for(const m of mappings)for(const value of new Set([m.sourcePath,m.archivePath])){const lines=mappingIndex.get(value)||[];lines.push(m.line);mappingIndex.set(value,lines);}
 for(const part of snapshot.parts.filter(p=>/\.sktl$/i.test(p.name))){
  if(!part.valid){diagnostics.push({code:'invalid_timeline_checksum',part:part.name});continue;}
  if(partsByName.get(part.name).length!==1){if(!diagnostics.some(d=>d.code==='duplicate_timeline_part'&&d.part===part.name))diagnostics.push({code:'duplicate_timeline_part',part:part.name});continue;}
  if(part.bytes.length>MAX_TEXT_BYTES)throw Error(`Timeline exceeds inventory text limit: ${part.name}`);
  try{
   const timeline=parseTimeline(readSnapshotPart({snapshot,name:part.name}).text);
   for(const clip of timeline.audioClips){
    const value=clip.attributes.file;
    const mappingLines=typeof value==='string'?(mappingIndex.get(value)||[]):[];
    references+=mappingLines.length;if(references>MAX_ITEMS)throw Error('Media inventory exceeds reference limit');
    clips.push({part:part.name,...clip,mappingLines});
    if(clips.length>MAX_ITEMS)throw Error('Clip count exceeds inventory item limit');
   }
  }catch(error){if(error.message==='Clip count exceeds inventory item limit'||error.message==='Media inventory exceeds reference limit')throw error;diagnostics.push({code:'invalid_timeline',part:part.name,message:error.message});}
 }
 const result={file,sha256:snapshot.sha256,mapParts,archiveParts,mappings,clips,diagnostics};
 if(Buffer.byteLength(JSON.stringify(result,null,2))>MAX_TEXT_BYTES)throw Error('Media inventory exceeds output limit');
 return result;
}
