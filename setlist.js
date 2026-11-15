import {SaxesParser} from 'saxes';
import {readShowSnapshot,readSnapshotPart,editShowPart} from './xml-copy.js';
import {hasXmlReference} from './xml-references.js';

export function parseSetlist(xml) {
 const parser=new SaxesParser(),stack=[],sets=[];let current,root=false;
 parser.on('opentag',tag=>{stack.push(tag.name);const path=stack.join('/');
  if(path==='sksetlist'){if(root||tag.attributes.version!=='2')throw Error('Expected a version 2 set list');root=true;}
  else if(path==='sksetlist/set'){current={name:tag.attributes.name,tracks:[]};sets.push(current);}
  else if(path==='sksetlist/set/entry'){if(!tag.attributes.track)throw Error('Set list entry has no track');current.tracks.push(tag.attributes.track);}
  else throw Error('Unsupported set list structure');
 });parser.on('text',s=>{if(s.trim())throw Error('Unsupported set list text');});parser.on('closetag',tag=>{if(tag.name==='set')current=null;stack.pop()});parser.write(xml).close();
 if(!root)throw Error('Expected a version 2 set list');return sets;
}
function escapeAttr(s){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;').replaceAll('\t','&#x9;').replaceAll('\n','&#xA;').replaceAll('\r','&#xD;');}
function setEntrySpans(xml){
 const parser=new SaxesParser(),stack=[],sets=[];let current,entry;
 parser.on('opentag',tag=>{
  stack.push(tag.name);const path=stack.join('/');
  if(path==='sksetlist/set'){current={start:xml.lastIndexOf('<',parser.position-1),entries:[]};sets.push(current);}
  if(path==='sksetlist/set/entry')entry={start:xml.lastIndexOf('<',parser.position-1)};
 });
 parser.on('closetag',tag=>{
  const path=stack.join('/');
  if(path==='sksetlist/set/entry'){entry.end=parser.position;current.entries.push(entry);entry=null;}
  if(path==='sksetlist/set'){current.end=parser.position;current=null;}
  stack.pop();
 });
 parser.write(xml).close();return sets;
}
function setlistRootSpan(xml){
 const parser=new SaxesParser();let depth=0,root;
 parser.on('opentag',tag=>{
  if(depth===0)root={start:xml.lastIndexOf('<',parser.position-1),openEnd:parser.position,selfClosing:tag.isSelfClosing};
  depth++;
 });
 parser.on('closetag',()=>{
  depth--;if(depth===0)root.closeStart=root.selfClosing?null:xml.lastIndexOf('<',parser.position-1);
 });
 parser.write(xml).close();return root;
}
// The root active attribute is a zero-based set index (static R27 evidence; see remove_set).
function readActiveSet(xml,count){
 const root=setlistRootSpan(xml),opening=xml.slice(root.start,root.openEnd);
 const attrs=[...opening.matchAll(/\s+([^\s=\/<>]+)\s*=\s*(["'])(.*?)\2/gs)];
 const activeMatch=attrs.find(match=>match[1]==='active');
 if(!activeMatch||!/^(0|[1-9]\d*)$/.test(activeMatch[3]))throw Error('Unsupported active-set index');
 const active=Number(activeMatch[3]);
 if(!Number.isSafeInteger(active)||active>=count)throw Error('Unsupported active-set index');
 const valueOffset=activeMatch.index+activeMatch[0].lastIndexOf(activeMatch[2]+activeMatch[3]+activeMatch[2])+1;
 return {root,active,opening:next=>opening.slice(0,valueOffset)+next+opening.slice(valueOffset+activeMatch[3].length)};
}
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
 const modified=xml.slice(0,match.index)+changed+xml.slice(match.index+match[0].length);
 const expected=structuredClone(sets);expected[sets.indexOf(selected[0])].tracks.push(trackName);
 if(JSON.stringify(parseSetlist(modified))!==JSON.stringify(expected))throw Error('Set list edit did not produce the expected track order');
 const result=await editShowPart({source,destination,sha256,name,edits:[{find:xml,replace:modified}]});
 return {...result,setName,trackName,note:'Added a track entry to an offline set list copy. Validate in ShowKontrol.'};
}

// Set and entry operations are restricted to the fixture's simple serialization.
export async function editShowSetlistCopy({source,destination,sha256,name,operation,setName,newSetName,index,toIndex,allowContentRemoval}){
 const {show,xml,sets}=await loadShow(source,name);if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(!['create_set','remove_set','move_set','remove_track','move_track'].includes(operation))throw Error('Unsupported set list operation');
 let modified,expectedSets,moved;
 if(operation==='create_set'){
  if(typeof newSetName!=='string'||!newSetName.trim()||/[\x00-\x1f\ufffe\uffff]/u.test(newSetName))throw Error('A valid new set name is required');
  if(sets.some(s=>s.name===newSetName))throw Error('Set name already exists');
  const root=setlistRootSpan(xml),entry=`<set name="${escapeAttr(newSetName)}"></set>`;
  if(root.selfClosing){
   const opening=xml.slice(root.start,root.openEnd).replace(/\s*\/>$/, '>');
   modified=xml.slice(0,root.start)+opening+entry+'</sksetlist>'+xml.slice(root.openEnd);
  }else modified=xml.slice(0,root.closeStart)+entry+xml.slice(root.closeStart);
  expectedSets=[...sets,{name:newSetName,tracks:[]}];
 }else{
  if(typeof setName!=='string'||!setName||sets.filter(s=>s.name===setName).length!==1)throw Error('Set name must occur exactly once');
  const selectedIndex=sets.findIndex(s=>s.name===setName);
  if(operation==='remove_set'){
   if(sets.length<=1)throw Error('Cannot remove the last set; active-set behavior is unverified');
   if(allowContentRemoval!==undefined&&typeof allowContentRemoval!=='boolean')throw Error('allowContentRemoval must be a boolean');
   if(sets[selectedIndex].tracks.length&&allowContentRemoval!==true)throw Error('Removing a populated set requires allowContentRemoval');
   const pattern=new RegExp(setName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
   for(const part of show.parts.filter(p=>p.name!==name&&/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(p.name))){
    const text=readSnapshotPart({snapshot:show,name:part.name}).text;
    if(hasXmlReference(text,pattern))throw Error(`Set name has a reference in ${part.name}`);
   }
   const activeSet=readActiveSet(xml,sets.length);
   const spans=setEntrySpans(xml);if(spans.length!==sets.length)throw Error('Unsupported set serialization');
   const nextActive=Math.min(sets.length-2,activeSet.active>=selectedIndex?Math.max(0,activeSet.active-1):activeSet.active);
   const root=activeSet.root,changedOpening=activeSet.opening(nextActive);
   const target=spans[selectedIndex];
   modified=xml.slice(0,root.start)+changedOpening+xml.slice(root.openEnd,target.start)+xml.slice(target.end);
   expectedSets=structuredClone(sets);expectedSets.splice(selectedIndex,1);
  }else if(operation==='move_set'){
   if(index!==undefined||newSetName!==undefined||allowContentRemoval!==undefined)throw Error('move_set takes setName and toIndex only');
   if(toIndex===undefined)throw Error('move_set requires toIndex');
   if(!Number.isInteger(toIndex)||toIndex<0||toIndex>=sets.length)throw Error('Destination index is outside the set list');
   if(toIndex===selectedIndex)throw Error('The set is already at the destination index');
   const activeSet=readActiveSet(xml,sets.length);
   const spans=setEntrySpans(xml);if(spans.length!==sets.length)throw Error('Unsupported set serialization');
   // order[i] is the source position of the set that ends up at position i.
   const order=sets.map((_,i)=>i);order.splice(selectedIndex,1);order.splice(toIndex,0,selectedIndex);
   const nextActive=order.indexOf(activeSet.active),root=activeSet.root;
   // Whole set elements trade places; material between and around them stays in its slot.
   let cursor=root.openEnd,changed=xml.slice(0,root.start)+activeSet.opening(nextActive);
   for(let i=0;i<spans.length;i++){changed+=xml.slice(cursor,spans[i].start)+xml.slice(spans[order[i]].start,spans[order[i]].end);cursor=spans[i].end;}
   modified=changed+xml.slice(cursor);
   expectedSets=order.map(i=>structuredClone(sets[i]));
   const check=readActiveSet(modified,sets.length),after=setEntrySpans(modified);
   const slots=(text,start,list)=>list.map((span,i)=>text.slice(i?list[i-1].end:start,span.start)).concat(text.slice(list.at(-1).end));
   if(check.active!==nextActive||after.length!==spans.length||after.some((span,i)=>modified.slice(span.start,span.end)!==xml.slice(spans[order[i]].start,spans[order[i]].end))||JSON.stringify(slots(modified,check.root.openEnd,after))!==JSON.stringify(slots(xml,root.openEnd,spans)))throw Error('Set move did not preserve the set elements and active set');
   moved={setName,fromIndex:selectedIndex,toIndex,active:{before:activeSet.active,after:nextActive}};
  }else{
   const spans=setEntrySpans(xml);if(spans.length!==sets.length)throw Error('Unsupported set serialization');
   const entries=spans[selectedIndex].entries;
   if(entries.length!==sets[selectedIndex].tracks.length)throw Error('Unsupported entry serialization');
   if(index===undefined)throw Error(`${operation} requires index`);
   if(!Number.isInteger(index)||index<0||index>=entries.length)throw Error('Entry index is outside the set');
   const values=entries.map(m=>xml.slice(m.start,m.end));const [entry]=values.splice(index,1);
   expectedSets=structuredClone(sets);const [track]=expectedSets[selectedIndex].tracks.splice(index,1);
   if(operation==='move_track'){
    if(toIndex===undefined)throw Error('move_track requires toIndex');
    if(!Number.isInteger(toIndex)||toIndex<0||toIndex>=entries.length)throw Error('Destination index is outside the set');
    values.splice(toIndex,0,entry);expectedSets[selectedIndex].tracks.splice(toIndex,0,track);
   }
   // Preserve whitespace or other untouched material between entry elements.
   let cursor=0,changed='';
   for(let i=0;i<entries.length;i++){changed+=xml.slice(cursor,entries[i].start)+(values[i]??'');cursor=entries[i].end;}
   modified=changed+xml.slice(cursor);
  }
 }
 const resultSets=parseSetlist(modified);
 if(expectedSets&&JSON.stringify(resultSets)!==JSON.stringify(expectedSets))throw Error('Set list edit did not produce the expected track order');
 const result=await editShowPart({source,destination,sha256,name,edits:[{find:xml,replace:modified}]});
 return {...result,operation,...(moved?{move:moved}:{}),note:operation==='remove_set'?'Changed an offline set list copy. Literal references in supported XML parts were checked; encoded, computed, external and binary references and ShowKontrol acceptance are not verified.':'Changed an offline set list copy. Validate in ShowKontrol.'};
}
