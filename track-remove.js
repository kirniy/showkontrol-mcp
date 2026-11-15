import {writeFile,link,unlink} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {inspectXml,readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseXmlSpans} from './xml-spans.js';
import {parseSetlist} from './setlist.js';
import {inspectProgramBytes} from './program.js';
import {hasXmlReference} from './xml-references.js';

const escapeRegex=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function descendants(root){return [root,...root.children.flatMap(descendants)];}

// Removes one wrapper part only. Other parts are left byte-for-byte unchanged.
export async function removeShowTrackCopy({source,destination,sha256,name,allowContentRemoval}){
 if(typeof source!=='string'||typeof destination!=='string'||!path.isAbsolute(source)||!path.isAbsolute(destination)||path.extname(source).toLowerCase()!=='.skshow'||path.extname(destination).toLowerCase()!=='.skshow'||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute .skshow paths');
 if(typeof name!=='string'||!name.toLowerCase().endsWith('.sktl'))throw Error('An exact timeline part name is required');
 if(typeof allowContentRemoval!=='boolean')throw Error('allowContentRemoval must be an explicit boolean');
 if(!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('A source SHA-256 is required');
 const raw=await inspectXml({file:source}),show=await readShowSnapshot({file:source});
 if(raw.sha256!==sha256||show.sha256!==sha256)throw Error('Source changed since inspection');
 if(show.parts.some(p=>!p.valid))throw Error('A part MD5 does not match');
 if(new Set(show.parts.map(p=>p.name.toLowerCase())).size!==show.parts.length)throw Error('Duplicate part names');
 const wrapper=parseXmlSpans(raw.xml);
 if(wrapper.name!=='skshow'||wrapper.children.some(n=>n.name!=='part')||wrapper.children.length!==show.parts.length)throw Error('Unsupported show wrapper');
 const selected=show.parts.find(p=>p.name===name);if(!selected)throw Error('Timeline part name must match exactly');
 const decoded=[];
 for(const part of show.parts.filter(p=>/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(p.name))){
  const xml=readSnapshotPart({snapshot:show,name:part.name}).text,root=parseXmlSpans(xml);
  if(/\.sktl$/i.test(part.name)&&(root.name!=='sktimeline'||root.attributes.version!=='1'||!root.attributes.name))throw Error('Unsupported timeline structure');
  if(/\.skls$/i.test(part.name))parseSetlist(xml);
  if(/\.skpr$/i.test(part.name))inspectProgramBytes(part.bytes);
  decoded.push({part,xml,root});
 }
 const target=decoded.find(d=>d.part===selected),track=target.root.attributes.name;
 let cursor=target.root.openEnd;for(const child of target.root.children){if(target.xml.slice(cursor,child.start).trim())throw Error('Unsupported timeline mixed content');cursor=child.end;}
 if(!target.root.selfClosing&&target.xml.slice(cursor,target.root.closeStart).trim())throw Error('Unsupported timeline mixed content');
 for(const child of target.root.children)if(child.name==='cue')for(const graph of child.children.filter(n=>n.name==='graph'))if(graph.children.some(n=>n.name==='cue'))throw Error('Unsupported nested cue');
 if(decoded.some(d=>d!==target&&/\.sktl$/i.test(d.part.name)&&d.root.attributes.name.toLowerCase()===track.toLowerCase()))throw Error('Duplicate track name');
 const nodes=descendants(target.root),ids=[];
 for(const node of nodes.filter(n=>n.name==='cue'||n.name==='node')){
  if(typeof node.attributes.id!=='string'||!node.attributes.id||node.attributes.id.length>1024)throw Error('Unsupported cue or node identifier');
  ids.push(node.attributes.id);
 }
 if(new Set(ids).size!==ids.length)throw Error('Duplicate cue or node identifier');
 if(nodes.some(n=>n.name==='cue'&&!target.root.children.includes(n)))throw Error('Unsupported nested cue');
 if(target.root.children.length&&!allowContentRemoval)throw Error('Timeline contains content; set allowContentRemoval to true');
 const patterns=[new RegExp(escapeRegex(track),'i'),...ids.map(id=>new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(id)}([^A-Za-z0-9_]|$)`))];
 for(const item of decoded.filter(d=>d!==target))for(const pattern of patterns)if(hasXmlReference(item.xml,pattern))throw Error(`Track or content has a reference in ${item.part.name}`);
 const spans=wrapper.children.filter(n=>n.attributes.name===name);if(spans.length!==1)throw Error('Ambiguous timeline part');
 const output=raw.xml.slice(0,spans[0].start)+raw.xml.slice(spans[0].end);parseXmlSpans(output);
 const temp=path.join(path.dirname(destination),`.showkontrol-remove-${randomUUID()}.tmp`);let created=false;
 try{await writeFile(temp,output,{flag:'wx'});created=true;const check=await readShowSnapshot({file:temp});
  if(check.parts.length!==show.parts.length-1||check.parts.some(p=>!p.valid)||show.parts.filter(p=>p!==selected).some(p=>!check.parts.some(q=>q.name===p.name&&q.md5===p.md5&&q.bytes.equals(p.bytes))))throw Error('Removal verification failed');
  if((await inspectXml({file:source})).sha256!==sha256)throw Error('Source changed since inspection');
  await link(temp,destination);
 }finally{if(created)await unlink(temp);}
 return {destination,sha256:createHash('sha256').update(output).digest('hex'),part:name,trackName:track,note:'Offline copy only. Literal references in supported XML were checked; encoded, computed, external and binary references and ShowKontrol acceptance are not verified.'};
}
