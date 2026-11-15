import {readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseTimeline} from './timeline.js';
import {inspectProgramBytes} from './program.js';
import {parseXmlSpans} from './xml-spans.js';

const MAX_ITEMS=10000, MAX_TEXT_BYTES=2*1024*1024, MAX_VALUE_CHARS=4096;
const MEDIA_FIELDS=['media','mediaWave','mediaGrid','mediaStructS','mediaStructE','mediaStructL'];

// Report exact strings and archive membership only. Never open a referenced path.
export async function inspectShowMedia({file}){
 const snapshot=await readShowSnapshot({file});
 const diagnostics=[], mappings=[], clips=[], timelines=[];let references=0;
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
 // An exact string match is evidence only, not proof of a native media link.
 const mappedAttributes=attributes=>{
  const found=[];
  for(const [attribute,value] of Object.entries(attributes)){
   const lines=mappingIndex.get(value);if(!lines)continue;
   references+=lines.length;if(references>MAX_ITEMS)throw Error('Media inventory exceeds reference limit');
   found.push({attribute,lines});
  }
  return found;
 };
 const addClips=(timeline,scope)=>{
  const root=timeline.attributes,mediaFields={};
  for(const key of MEDIA_FIELDS)if(Object.hasOwn(root,key)){
   const value=root[key];mediaFields[key]=value.length>MAX_VALUE_CHARS?{length:value.length,valueOmitted:true}:{length:value.length,value};
  }
  timelines.push({...scope,mediaFields,attributeMappings:mappedAttributes(root),audioLanes:timeline.audio.length,clipCount:timeline.audioClips.length});
  if(timelines.length>MAX_ITEMS)throw Error('Timeline count exceeds inventory item limit');
  const laneClips=new Map();
  for(const clip of timeline.audioClips){
   const clipIndex=laneClips.get(clip.audioIndex)??0;laneClips.set(clip.audioIndex,clipIndex+1);
   const attributeMappings=mappedAttributes(clip.attributes);
   const mappingLines=attributeMappings.find(match=>match.attribute==='file')?.lines??[];
   clips.push({...scope,...clip,clipIndex,mappingLines,attributeMappings});
   if(clips.length>MAX_ITEMS)throw Error('Clip count exceeds inventory item limit');
  }
 };
 const isLimitError=error=>['Clip count exceeds inventory item limit','Timeline count exceeds inventory item limit','Media inventory exceeds reference limit'].includes(error.message);
 for(const part of snapshot.parts.filter(p=>/\.sktl$/i.test(p.name))){
  if(!part.valid){diagnostics.push({code:'invalid_timeline_checksum',part:part.name});continue;}
  if(partsByName.get(part.name).length!==1){if(!diagnostics.some(d=>d.code==='duplicate_timeline_part'&&d.part===part.name))diagnostics.push({code:'duplicate_timeline_part',part:part.name});continue;}
  if(part.bytes.length>MAX_TEXT_BYTES)throw Error(`Timeline exceeds inventory text limit: ${part.name}`);
  try{
   const timeline=parseTimeline(readSnapshotPart({snapshot,name:part.name}).text);
   addClips(timeline,{part:part.name});
  }catch(error){if(isLimitError(error))throw error;diagnostics.push({code:'invalid_timeline',part:part.name,message:error.message});}
 }
 const programName='content/Program.skpr';
 const programs=snapshot.parts.filter(p=>p.name.toLowerCase()===programName.toLowerCase());
 if(programs.length>1)diagnostics.push({code:'duplicate_program_part',part:programName,count:programs.length});
 else if(programs.length===1){
  const part=programs[0];
  if(part.name!==programName)diagnostics.push({code:'invalid_program_part_name',part:part.name});
  else if(!part.valid)diagnostics.push({code:'invalid_program_checksum',part:part.name});
  else if(part.bytes.length>MAX_TEXT_BYTES)throw Error('Program exceeds inventory text limit');
  else {
   let xml,root;
   try{inspectProgramBytes(part.bytes);xml=readSnapshotPart({snapshot,name:part.name}).text;root=parseXmlSpans(xml);}
   catch(error){diagnostics.push({code:'invalid_program',part:part.name,message:error.message});}
   if(root)for(const [itemIndex,item] of root.children.entries()){
    const node=item.children.find(child=>child.name==='sktimeline');if(!node)continue;
    try{addClips(parseTimeline(xml.slice(node.start,node.end)),{part:part.name,itemIndex});}
    catch(error){if(isLimitError(error))throw error;diagnostics.push({code:'invalid_timeline',part:part.name,itemIndex,message:error.message});}
   }
  }
 }
 const result={file,sha256:snapshot.sha256,mapParts,archiveParts,mappings,clips,diagnostics,timelines};
 if(Buffer.byteLength(JSON.stringify(result,null,2))>MAX_TEXT_BYTES)throw Error('Media inventory exceeds output limit');
 return result;
}
