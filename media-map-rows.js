import {SaxesParser} from 'saxes';
import {nameKey,checkSourcePath,checkSidecarName} from './session-media-copy.js';

const MAX_OPERATIONS=100,MAX_LOCATIONS=5;
const FIELDS={remove_mapping:['action','line','sourcePath','archivePath'],repoint_mapping:['action','line','sourcePath','archivePath','newSourcePath','newArchivePath']};

// Select existing media.map rows by line and both exact values, and plan removals and new values for them.
// New values may not reuse any value of the inspected map, so the result never depends on operation order.
export function planMappingOperations(inventory,operations){
 if(!Array.isArray(operations)||operations.length>MAX_OPERATIONS)throw Error(`Mapping operations must be an array of at most ${MAX_OPERATIONS} entries`);
 const byLine=new Map(inventory.mappings.map(m=>[m.line,m])),touched=new Map();
 const sources=new Map(inventory.mappings.map(m=>[m.sourcePath,m.line])),archives=new Map(inventory.mappings.map(m=>[nameKey(m.archivePath),m.archivePath]));
 const newSources=new Map(),newArchives=new Map();
 for(const [index,op] of operations.entries()){
  const where=`Mapping operation ${index}`;
  if(!op||typeof op!=='object'||Array.isArray(op)||!FIELDS[op.action]||Object.keys(op).some(k=>!FIELDS[op.action].includes(k)))throw Error(`${where}: action must be remove_mapping or repoint_mapping with only their fields`);
  if(!Number.isSafeInteger(op.line)||op.line<1)throw Error(`${where}: line must be a positive media.map line number`);
  const row=byLine.get(op.line);
  if(!row)throw Error(`${where}: media.map has no mapping on line ${op.line}`);
  if(row.sourcePath!==op.sourcePath||row.archivePath!==op.archivePath)throw Error(`${where}: media.map line ${op.line} maps ${JSON.stringify(row.sourcePath)} to ${JSON.stringify(row.archivePath)}, not ${JSON.stringify(op.sourcePath)} to ${JSON.stringify(op.archivePath)}; inspect the source again`);
  if(touched.has(op.line))throw Error(`${where}: media.map line ${op.line} is already selected by mapping operation ${touched.get(op.line).operationIndex}`);
  let next=null;
  if(op.action==='repoint_mapping'){
   const {newSourcePath,newArchivePath}=op;
   if(newSourcePath===undefined&&newArchivePath===undefined)throw Error(`${where}: supply newSourcePath, newArchivePath or both`);
   if(newSourcePath!==undefined){
    checkSourcePath(newSourcePath);
    if(sources.has(newSourcePath))throw Error(`${where}: newSourcePath is a source path of the inspected media.map (line ${sources.get(newSourcePath)}); only values the map does not use can be introduced`);
    if(newSources.has(newSourcePath))throw Error(`${where}: newSourcePath is also introduced by mapping operation ${newSources.get(newSourcePath)}`);
    newSources.set(newSourcePath,index);
   }
   if(newArchivePath!==undefined){
    if(typeof newArchivePath!=='string'||!newArchivePath.startsWith('MEDIA/'))throw Error(`${where}: newArchivePath must name one file directly in MEDIA/`);
    checkSidecarName(newArchivePath.slice(6));
    // A sidecar name used by the inspected map stays reserved, including the removed one: no aliasing or swaps.
    const key=nameKey(newArchivePath),clash=archives.get(key)??[...archives.entries()].find(([other])=>other.startsWith(key+'/'))?.[1];
    if(clash)throw Error(`${where}: ${newArchivePath} collides with ${clash} of the inspected media.map; names are compared without case after Unicode normalization`);
    if(newArchives.has(key))throw Error(`${where}: ${newArchivePath} is also introduced by mapping operation ${newArchives.get(key)}`);
    newArchives.set(key,index);
   }
   next={sourcePath:newSourcePath??row.sourcePath,archivePath:newArchivePath??row.archivePath};
  }
  touched.set(op.line,{operationIndex:index,action:op.action,row,next});
 }
 const rows=[];
 for(const m of inventory.mappings){
  const change=touched.get(m.line);
  if(!change)rows.push({sourcePath:m.sourcePath,archivePath:m.archivePath,sourceLine:m.line});
  else if(change.next)rows.push({...change.next,sourceLine:m.line,operationIndex:change.operationIndex});
 }
 for(const [i,row] of rows.entries())row.line=i+1;
 const changes=[...touched.values()].sort((a,b)=>a.operationIndex-b.operationIndex);
 return {rows,changes,edits:new Map([...touched].map(([line,c])=>[line,c.next]))};
}

// Rewrite only the selected rows. Every other row keeps its bytes and line break; a byte order mark is kept.
export function editMappingText(text,edits){
 if(!edits.size)return text;
 const bom=text.startsWith('\ufeff')?'\ufeff':'',tokens=text.slice(bom.length).split(/(\r?\n)/);let out=bom;
 for(let i=0;i<tokens.length;i+=2){
  const line=i/2+1,content=tokens[i],eol=tokens[i+1]??'';
  if(!edits.has(line)){out+=content+eol;continue;}
  const next=edits.get(line);
  if(next)out+=`${next.sourcePath}\t${next.archivePath}${eol}`;
 }
 return out;
}

// Values of changed rows that no final row keeps in the same column. A reference to one would be left unmapped.
export function vanishingValues(plan,finalRows){
 const sources=new Set(finalRows.map(r=>r.sourcePath)),archives=new Set(finalRows.map(r=>r.archivePath)),out=[];
 for(const change of plan.changes){
  const {row,operationIndex}=change;
  if(!sources.has(row.sourcePath))out.push({operationIndex,line:row.line,column:'sourcePath',value:row.sourcePath});
  if(!archives.has(row.archivePath))out.push({operationIndex,line:row.line,column:'archivePath',value:row.archivePath});
 }
 return out;
}

const fold=text=>text.normalize('NFC').toLowerCase();
const ENTITY=/&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi,NAMED={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
const decodeEntities=text=>text.replace(ENTITY,(raw,name,dec,hex)=>{
 if(name)return NAMED[name.toLowerCase()];
 const code=dec?Number(dec):parseInt(hex,16);
 return code<=0x10ffff?String.fromCodePoint(code):raw;
});
const decodeUtf8=bytes=>{try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return null;}};
// Literal and URI-encoded forms in either Unicode normalization; text is compared without case.
// Binary files are searched for UTF-8 and UTF-16 (both byte orders) forms.
function needles(value){
 const forms=new Set(),plain=[...new Set([value.normalize('NFC'),value.normalize('NFD')])];
 for(const form of plain){forms.add(form);try{forms.add(encodeURI(form));}catch{}}
 const utf16=plain.flatMap(v=>{const le=Buffer.from(v,'utf16le');return [le,Buffer.from(le).swap16()];});
 return {text:[...new Set([...forms].map(fold))],bytes:plain.map(v=>Buffer.from(v,'utf8')),utf16};
}
// A match counts unless a path character continues it, so /Music/a.wav is not found in /Old/Music/a.wav or /Music/a.wav.bak.
// Slashes, white space, quotes and punctuation that delimit values are boundaries; any other character, including non-ASCII, is a path character.
const BOUNDARY=/[\s/\\"'`=:,;()[\]{}<>|?#&*!]/u;
const bounded=(hay,needle)=>{
 for(let at=hay.indexOf(needle);at>=0;at=hay.indexOf(needle,at+1)){
  const before=at?hay[at-1]:'',after=hay[at+needle.length]??'';
  if((!before||BOUNDARY.test(before))&&(!after||BOUNDARY.test(after)))return true;
 }
 return false;
};

// Attribute values, text, CDATA, comments and processing instructions of an XML document, with entities decoded.
// Markup itself is not searched, so a short path such as /a does not match </audio>. Other text is searched whole.
function xmlStrings(text){
 if(!/^\s*</.test(text.replace(/^\ufeff/,'')))return null;
 const out=[],parser=new SaxesParser();
 parser.on('opentag',tag=>{for(const value of Object.values(tag.attributes))out.push(value);});
 for(const event of ['text','cdata','comment'])parser.on(event,value=>out.push(value));
 parser.on('processinginstruction',pi=>out.push(pi.body));
 try{parser.write(text).close();}catch{return null;}
 return out;
}
function matcher(targets){
 const prepared=targets.map(target=>({target,...needles(target.value)}));
 return {
  text(text){const hays=(xmlStrings(text)??[text,decodeEntities(text)]).map(fold);return prepared.filter(p=>p.text.some(n=>hays.some(h=>bounded(h,n)))).map(p=>p.target);},
  // Neighbouring bytes of a binary file are not characters, so any occurrence counts.
  bytes(bytes){return prepared.filter(p=>[...p.bytes,...p.utf16].some(n=>bytes.includes(n))).map(p=>p.target);},
  // ASCII in UTF-16 is also valid UTF-8 with NUL characters, so text files are searched for UTF-16 forms too.
  utf16(bytes){return prepared.filter(p=>p.utf16.some(n=>bytes.includes(n))).map(p=>p.target);},
 };
}
const scopeLabel=s=>`${s.part}${s.itemIndex===undefined?'':` item ${s.itemIndex}`}`;

// Search every archive part except media.map and MEDIA/ payloads, plus supplied working files, for the vanishing values.
// Clip and timeline attributes are reported by position. A part that is not UTF-8 text cannot be checked and fails.
export function findReferences({snapshot,inventory,targets,files=[]}){
 const found=new Map(targets.map(t=>[t,[]]));if(!targets.length)return [];
 const match=matcher(targets),note=(list,where)=>{for(const t of list)found.get(t).push(where);};
 const attrs=(attributes,label)=>{for(const [attribute,value] of Object.entries(attributes??{}))if(typeof value==='string')note(match.text(value),`${label} ${attribute}`);};
 for(const timeline of inventory.timelines)for(const [attribute,info] of Object.entries(timeline.mediaFields))if(info.value!==undefined)note(match.text(info.value),`${scopeLabel(timeline)} sktimeline ${attribute}`);
 for(const clip of inventory.clips)attrs(clip.attributes,`${scopeLabel(clip)} audio ${clip.audioIndex} clip ${clip.clipIndex}`);
 for(const timeline of inventory.timelines)for(const lane of timeline.lanes)attrs(lane.attributes,`${scopeLabel(timeline)} audio ${lane.audioIndex}`);
 for(const part of snapshot.parts){
  if(part.name==='media.map'||part.name.startsWith('MEDIA/'))continue;
  if(!part.valid)throw Error(`Archive part ${part.name} fails its MD5 check; references to changed media.map values cannot be checked`);
  const text=decodeUtf8(part.bytes);
  if(text===null)throw Error(`Archive part ${part.name} is not UTF-8 text; references to changed media.map values cannot be checked`);
  note(match.text(text),`part ${part.name}`);
 }
 // Working files outside MEDIA/ may hold unsaved state; binary ones are searched for the literal UTF-8 forms only.
 for(const file of files){
  const text=decodeUtf8(file.bytes);
  if(text===null)note(match.bytes(file.bytes),`working file ${file.rel} (bytes)`);
  else{note(match.text(text),`working file ${file.rel}`);note(match.utf16(file.bytes),`working file ${file.rel} (UTF-16)`);}
 }
 return targets.filter(t=>found.get(t).length).map(t=>({...t,locations:found.get(t)}));
}

export function assertUnreferenced(hits){
 if(!hits.length)return;
 const [first]=hits;
 throw Error(`Mapping operation ${first.operationIndex} would leave ${first.column} ${JSON.stringify(first.value)} of media.map line ${first.line} referenced without a mapping: ${first.locations.slice(0,MAX_LOCATIONS).join('; ')}${first.locations.length>MAX_LOCATIONS?`; and ${first.locations.length-MAX_LOCATIONS} more`:''}${hits.length>1?`. ${hits.length-1} more changed value${hits.length>2?'s are':' is'} also referenced`:''}. Re-point or remove the references in the same composition, or keep the row`);
}

export const mappingReceipts=plan=>plan.changes.map(({operationIndex,action,row,next})=>{
 const after=next&&plan.rows.find(r=>r.sourceLine===row.line);
 return {operationIndex,action,line:row.line,before:{sourcePath:row.sourcePath,archivePath:row.archivePath},after:after?{line:after.line,sourcePath:after.sourcePath,archivePath:after.archivePath}:null};
});
