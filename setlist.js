import {SaxesParser} from 'saxes';
import {readShowSnapshot,readSnapshotPart,editShowPart} from './xml-copy.js';

function parseSetlist(xml) {
 const parser=new SaxesParser(),stack=[],sets=[];let current,root=false;
 parser.on('opentag',tag=>{stack.push(tag.name);const path=stack.join('/');
  if(path==='sksetlist'){if(root||tag.attributes.version!=='2')throw Error('Expected a version 2 set list');root=true;}
  else if(path==='sksetlist/set'){current={name:tag.attributes.name,tracks:[]};sets.push(current);}
  else if(path==='sksetlist/set/entry'){if(!tag.attributes.track)throw Error('Set list entry has no track');current.tracks.push(tag.attributes.track);}
  else throw Error('Unsupported set list structure');
 });parser.on('text',s=>{if(s.trim())throw Error('Unsupported set list text');});parser.on('closetag',tag=>{if(tag.name==='set')current=null;stack.pop()});parser.write(xml).close();
 if(!root)throw Error('Expected a version 2 set list');return sets;
}
function escapeAttr(s){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');}
async function loadShow(file,name){
 if(!name||!name.toLowerCase().endsWith('.skls'))throw Error('Select a .skls part');
 const show=await readShowSnapshot({file});if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 const xml=readSnapshotPart({snapshot:show,name}).text;return {show,xml,sets:parseSetlist(xml)};
}
export async function inspectShowSetlist({file,name}){const {show,sets}=await loadShow(file,name);return {file,name,sha256:show.sha256,sets};}
export async function addShowSetlistTrackCopy({source,destination,sha256,name,setName,trackName}){
 if(typeof setName!=='string'||!setName||typeof trackName!=='string'||!trackName)throw Error('Set name and track name are required');
 const {show,xml,sets}=await loadShow(source,name);if(show.sha256!==sha256)throw Error('Source changed since inspection');
 const selected=sets.filter(s=>s.name===setName);if(selected.length!==1)throw Error('Set name must occur exactly once');
 if(selected[0].tracks.includes(trackName))throw Error('Track already exists in this set');
 let tracks=0;
 for(const part of show.parts.filter(p=>p.name.toLowerCase().endsWith('.sktl'))){
  const text=readSnapshotPart({snapshot:show,name:part.name}).text;let root;const parser=new SaxesParser();parser.on('opentag',tag=>{if(!root)root=tag});parser.write(text).close();
  if(root?.name==='sktimeline'&&root.attributes.version==='1'&&root.attributes.name===trackName)tracks++;
 }
 if(tracks!==1)throw Error('Track name must identify exactly one timeline in the show');
 const matches=[...xml.matchAll(/<set\b(?:[^"'<>]|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/set\s*>)/g)].filter(m=>{
  let first;const p=new SaxesParser();p.on('opentag',tag=>{if(!first)first=tag});p.write(m[0]).close();return first.attributes.name===setName;
 });
 if(matches.length!==1)throw Error('Unsupported or ambiguous set serialization');
 const match=matches[0],entry=`<entry track="${escapeAttr(trackName)}"/>`;
 const at=match[0].lastIndexOf('</set');
 const changed=at<0?match[0].replace(/\s*\/>$/,()=>`>${entry}</set>`):match[0].slice(0,at)+entry+match[0].slice(at);
 const modified=xml.slice(0,match.index)+changed+xml.slice(match.index+match[0].length);parseSetlist(modified);
 const result=await editShowPart({source,destination,sha256,name,edits:[{find:xml,replace:modified}]});
 return {...result,setName,trackName,note:'Added a track entry to an offline set list copy. Validate in ShowKontrol.'};
}

// Set and entry operations are restricted to the fixture's simple serialization.
export async function editShowSetlistCopy({source,destination,sha256,name,operation,setName,newSetName,index,toIndex}){
 const {show,xml,sets}=await loadShow(source,name);if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(!['create_set','remove_set','move_set','remove_track','move_track'].includes(operation))throw Error('Unsupported set list operation');
 const setElements=[...xml.matchAll(/<set\b(?:[^"'<>]|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/set\s*>)/g)];
 if(setElements.length!==sets.length)throw Error('Unsupported set serialization');
 let modified;
 if(operation==='create_set'){
  if(typeof newSetName!=='string'||!newSetName.trim()||/[\x00-\x1f\ufffe\uffff]/u.test(newSetName))throw Error('A valid new set name is required');
  if(sets.some(s=>s.name===newSetName))throw Error('Set name already exists');
  const close=[...xml.matchAll(/<\/sksetlist\s*>/g)];if(close.length!==1)throw Error('Unsupported set list serialization');
  modified=xml.slice(0,close[0].index)+`<set name="${escapeAttr(newSetName)}"></set>`+xml.slice(close[0].index);
 }else{
  if(typeof setName!=='string'||sets.filter(s=>s.name===setName).length!==1)throw Error('Set name must occur exactly once');
  const selectedIndex=sets.findIndex(s=>s.name===setName),selected=setElements[selectedIndex];
  if(operation==='remove_set'){
   // Active is a positional index; changing set positions would alter its meaning.
   throw Error('Removing sets is unsupported until active-set index behavior is verified');
  }else if(operation==='move_set'){
   throw Error('Reordering sets is unsupported until active-set index behavior is verified');
  }else{
   const entries=[...selected[0].matchAll(/<entry\b(?:[^"'<>]|"[^"]*"|'[^']*')*?\/>/g)];
   if(entries.length!==sets[selectedIndex].tracks.length)throw Error('Unsupported entry serialization');
   if(!Number.isInteger(index)||index<0||index>=entries.length)throw Error('Entry index is outside the set');
   const values=entries.map(m=>m[0]);const [entry]=values.splice(index,1);
   if(operation==='move_track'){
    if(!Number.isInteger(toIndex)||toIndex<0||toIndex>=entries.length)throw Error('Destination index is outside the set');
    values.splice(toIndex,0,entry);
   }
   // Preserve whitespace or other untouched material between entry elements.
   let body=selected[0], cursor=0, changed='';
   for(let i=0;i<entries.length;i++){changed+=body.slice(cursor,entries[i].index)+(values[i]??'');cursor=entries[i].index+entries[i][0].length;}
   changed+=body.slice(cursor);modified=xml.slice(0,selected.index)+changed+xml.slice(selected.index+selected[0].length);
  }
 }
 parseSetlist(modified);
 const result=await editShowPart({source,destination,sha256,name,edits:[{find:xml,replace:modified}]});
 return {...result,operation,note:'Changed an offline set list copy. Validate in ShowKontrol.'};
}
