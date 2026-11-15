import {mkdtemp,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {readShowSnapshot,readSnapshotPart,editShowPart,inspectShow} from './xml-copy.js';
import {parseXmlSpans} from './xml-spans.js';
import {parseSetlist} from './setlist.js';

function changeAttribute(xml,node,key,value){
 const opening=xml.slice(node.start,node.openEnd), re=/\s+([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g;
 const matches=[...opening.matchAll(re)].filter(m=>m[1]===key);
 if(matches.length!==1)throw Error(`Unsupported ${key} attribute serialization`);
 const m=matches[0], quote=m[2][0], escaped=value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;').replaceAll('\t','&#x9;').replaceAll('\n','&#xA;').replaceAll('\r','&#xD;');
 const at=node.start+m.index+m[0].indexOf(quote)+1;
 return {start:at,end:at+m[2].length-2,value:escaped};
}
function apply(xml,edits){for(const e of edits.sort((a,b)=>b.start-a.start))xml=xml.slice(0,e.start)+e.value+xml.slice(e.end);return xml;}
export async function renameShowTrackCopy({source,destination,sha256,oldName,newName}){
 if(!path.isAbsolute(source)||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute paths');
 if(typeof oldName!=='string'||!oldName||typeof newName!=='string'||!newName.trim()||/[\x00-\x1f\ufffe\uffff]/u.test(newName))throw Error('Valid track names are required');
 if(oldName===newName)throw Error('Track rename must make a change');
 const show=await readShowSnapshot({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 if(new Set(show.parts.map(p=>p.name)).size!==show.parts.length)throw Error('Duplicate part names');
 const timelines=show.parts.filter(p=>p.name.toLowerCase().endsWith('.sktl')).map(p=>{const xml=readSnapshotPart({snapshot:show,name:p.name}).text,root=parseXmlSpans(xml);if(root.name!=='sktimeline'||root.attributes.version!=='1'||typeof root.attributes.name!=='string'||!root.attributes.name)throw Error('Unsupported timeline structure');return {name:p.name,xml,root};});
 const selected=timelines.filter(t=>t.root.attributes.name===oldName);
 if(selected.length!==1)throw Error('Old track name must identify exactly one timeline');
 if(timelines.some(t=>t!==selected[0]&&t.root.attributes.name.toLowerCase()===oldName.toLowerCase()))throw Error('Old track name conflicts with another timeline');
 if(timelines.some(t=>t!==selected[0]&&t.root.attributes.name.toLowerCase()===newName.toLowerCase()))throw Error('Destination track name already exists');
 const changes=[{name:selected[0].name,xml:selected[0].xml,modified:apply(selected[0].xml,[changeAttribute(selected[0].xml,selected[0].root,'name',newName)])}];
 let entries=0;
 for(const part of show.parts.filter(p=>p.name.toLowerCase().endsWith('.skls'))){
  const xml=readSnapshotPart({snapshot:show,name:part.name}).text,before=parseSetlist(xml),root=parseXmlSpans(xml),edits=[];
  for(const set of root.children)for(const entry of set.children)if(entry.attributes.track===oldName){edits.push(changeAttribute(xml,entry,'track',newName));entries++;}
  if(edits.length){const modified=apply(xml,edits),expected=before.map(s=>({...s,tracks:s.tracks.map(t=>t===oldName?newName:t)}));if(JSON.stringify(parseSetlist(modified))!==JSON.stringify(expected))throw Error('Set list readback failed');changes.push({name:part.name,xml,modified});}
 }
 const check=parseXmlSpans(changes[0].modified);if(check.name!=='sktimeline'||check.attributes.name!==newName||check.attributes.version!=='1')throw Error('Timeline readback failed');
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-rename-'));let current=source,hash=sha256,published=false,result;
 try{
  for(let i=0;i<changes.length;i++){const next=path.join(dir,`${i}.skshow`),c=changes[i];await editShowPart({source:current,destination:next,sha256:hash,name:c.name,edits:[{find:c.xml,replace:c.modified}]});current=next;hash=(await inspectShow({file:current})).sha256;}
  if((await inspectShow({file:source})).sha256!==sha256)throw Error('Source changed since inspection');
  await link(current,destination);published=true;result={destination,sha256:hash,part:selected[0].name,oldName,newName,entries,note:'Offline copy only. Other references and ShowKontrol acceptance are not checked.'};
 }finally{try{await rm(dir,{recursive:true,force:true});}catch(e){if(!published)throw e;result.cleanupWarning=`Temporary directory cleanup failed: ${dir}: ${e.message}`;}}
 return result;
}
