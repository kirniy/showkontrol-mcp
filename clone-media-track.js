import path from 'node:path';
import {link,unlink,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {embedProgramTimelineRemappedCopy} from './program-timeline-copy-remap.js';
import {randomUUID} from 'node:crypto';
import {inspectXml,readShowSnapshot,readSnapshotPart,addShowPart} from './xml-copy.js';
import {parseXmlSpans} from './xml-spans.js';
import {parseTimeline} from './timeline.js';
import {hasXmlReference} from './xml-references.js';

const descendants=n=>[n,...n.children.flatMap(descendants)];
const escapeRegex=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export async function cloneMediaTrackCopy({source,destination,sha256,templateName,trackName,partName,cueMode="remove",allowOpaqueNodeText}) {
 if(allowOpaqueNodeText!==undefined&&typeof allowOpaqueNodeText!=='boolean')throw Error('allowOpaqueNodeText must be a boolean');
 if(!["remove","copy"].includes(cueMode))throw Error("cueMode must be remove or copy");
 if(!path.isAbsolute(source||'')||!path.isAbsolute(destination||'')||path.extname(source).toLowerCase()!=='.skshow'||path.extname(destination).toLowerCase()!=='.skshow'||path.resolve(source)===path.resolve(destination))throw Error('Source and destination must be different absolute .skshow paths');
 if(!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('A source SHA-256 is required');
 if(!/^[A-Za-z0-9 _-]*[A-Za-z0-9_-][A-Za-z0-9 _-]*$/.test(trackName||'')||!/^content\/[A-Za-z0-9_-]+\.sktl$/.test(partName||''))throw Error('Invalid track or part name');
 if(typeof templateName!=='string'||!templateName.toLowerCase().endsWith('.sktl'))throw Error('Select an exact timeline part name');
 const raw=await inspectXml({file:source}),show=await readShowSnapshot({file:source});
 if(raw.sha256!==sha256||show.sha256!==sha256)throw Error('Source changed since inspection');
 if(show.parts.some(p=>!p.valid))throw Error('A part MD5 does not match');
 if(new Set(show.parts.map(p=>p.name.toLowerCase())).size!==show.parts.length)throw Error('Duplicate part names');
 const wrapper=parseXmlSpans(raw.xml);if(wrapper.name!=='skshow'||wrapper.children.some(n=>n.name!=='part')||wrapper.children.length!==show.parts.length)throw Error('Unsupported show wrapper');
 if(show.parts.some(p=>p.name.toLowerCase()===partName.toLowerCase()))throw Error('Part name already exists');
 let xml;const trackNames=[];
 for(const part of show.parts.filter(p=>/\.sktl$/i.test(p.name))){const text=readSnapshotPart({snapshot:show,name:part.name}).text;const info=parseTimeline(text);if(!info.attributes.name)throw Error('Timeline name is missing');trackNames.push(info.attributes.name.toLowerCase());if(part.name===templateName)xml=text;}
 if(new Set(trackNames).size!==trackNames.length)throw Error('Duplicate track names');
 if(trackNames.includes(trackName.toLowerCase()))throw Error('Track name already exists');
 if(xml===undefined)throw Error('Timeline template was not found');
 const templateInfo=parseTimeline(xml);if(!templateInfo.attributes.media&&!templateInfo.audioClips.length)throw Error('Template has no media field or audio clips');
 const root=parseXmlSpans(xml),direct=root.children.filter(n=>n.name==='cue'),all=descendants(root);
 if(root.selfClosing||all.some(n=>n.name==='cue'&&!direct.includes(n)))throw Error('Unsupported nested cue');
 const removed=new Set(direct.flatMap(descendants));
 for(const cue of direct){if(cue.children.filter(n=>n.name==='graph').length>1)throw Error('Ambiguous cue graphs');}
 for(const n of all){if((n.name==='graph'||n.name==='node')&&!removed.has(n))throw Error('Unsupported graph or node outside cue');if(n.name==='graph'&&!direct.some(c=>c.children.includes(n)))throw Error('Unsupported nested graph');if(n.name==='node'&&!direct.some(c=>c.children.some(g=>g.name==='graph'&&g.children.includes(n))))throw Error('Unsupported nested node');}
 const ids=[];for(const n of removed){if((n.name==='cue'||n.name==='node')&&!n.attributes.id)throw Error('Unsupported cue or node identifier');if(n.attributes.id){if(!['cue','node','graph'].includes(n.name)||n.attributes.id.length>1024)throw Error('Unsupported internal identifier');ids.push(n.attributes.id);}}
 if(ids.length>1001||new Set(ids).size!==ids.length)throw Error('Duplicate or excessive cue or node identifiers');
 // Unknown identity-bearing attributes are unsafe to duplicate, even when their semantics are unknown.
 for(const n of all.filter(n=>!removed.has(n)))for(const key of Object.keys(n.attributes))if((/(?:id|uuid|guid|ref|reference)$/i.test(key)&&!['mediaGrid','grid'].includes(key)))throw Error('Unsupported identity or reference attribute in preserved XML');
 let changed=xml,cueMapping={},nodeMapping={},warnings=[];
 if(cueMode==='remove'){
  for(const cue of [...direct].reverse())changed=changed.slice(0,cue.start)+changed.slice(cue.end);
  for(const id of ids)if(hasXmlReference(changed,new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(id)}(?![A-Za-z0-9_])`)))throw Error('Preserved XML references a removed cue or node');
 }else{
  // Only known identity fields can be copied. The remapper validates graph paths and endpoints.
  for(const n of all)for(const key of Object.keys(n.attributes))if(/(?:id|uuid|guid|ref|reference)$/i.test(key)&&!(['cue','node'].includes(n.name)&&key==='id')&&!['mediaGrid','grid'].includes(key))throw Error('Unsupported identity or reference attribute');
  const nodes=[...removed].filter(n=>n.name==='node').map(n=>n.attributes.id);
  for(const part of show.parts.filter(p=>p.name!==templateName&&/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(p.name))){const text=readSnapshotPart({snapshot:show,name:part.name}).text;for(const id of nodes)if(hasXmlReference(text,new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(id)}(?![A-Za-z0-9_])`)))throw Error('Node ID occurs outside the template');}
  const dir=await mkdtemp(path.join(os.tmpdir(),'showkontrol-clone-'));
  try{const program='<skprogram version="1"><item start="0" name="Clone" notes=""/></skprogram>',input=path.join(dir,'in.skpr'),output=path.join(dir,'out.skpr');await writeFile(input,program);const result=await embedProgramTimelineRemappedCopy({source:input,destination:output,sha256:createHash('sha256').update(program).digest('hex'),index:0,donor:source,donorName:templateName,donorSha256:sha256,target:source,targetSha256:sha256,remapCueIds:true,allowOpaqueNodeText});warnings=result.warnings.filter(w=>w.code==='opaque_node_references_unverified').map(w=>({...w,scope:{part:partName,cueId:w.scope.cueId,nodeId:w.scope.nodeId,key:w.scope.key}}));const staged=await readFile(output,'utf8'),stagedRoot=parseXmlSpans(staged),timeline=stagedRoot.children[0].children.find(n=>n.name==='sktimeline');if(!timeline)throw Error('Clone verification failed');changed=xml.slice(0,root.start)+staged.slice(timeline.start,timeline.end)+xml.slice(root.end);cueMapping=result.cueMapping;nodeMapping=result.mapping;}finally{await rm(dir,{recursive:true,force:true});}
 }
 const changedRoot=parseXmlSpans(changed);const opening=changed.slice(changedRoot.start,changedRoot.openEnd);const matches=[...opening.matchAll(/\sname\s*=\s*(["'])(.*?)\1/g)];if(matches.length!==1)throw Error('Unsupported timeline name serialization');
 const m=matches[0],at=changedRoot.start+m.index+m[0].indexOf(m[1])+1;changed=changed.slice(0,at)+trackName+changed.slice(at+m[2].length);
 const parsed=parseTimeline(changed);if(parsed.attributes.name!==trackName||(cueMode==='remove'&&parsed.cueElements.length)|| (cueMode==='copy'&&parsed.cueElements.length!==direct.length))throw Error('Clone verification failed');
 const temp=path.join(path.dirname(destination),`.showkontrol-clone-${randomUUID()}.tmp`);let made=false;
 try{await addShowPart({source,destination:temp,sha256,name:partName,text:changed});made=true;const check=await readShowSnapshot({file:temp});if(check.parts.length!==show.parts.length+1||check.parts.some(p=>!p.valid)||show.parts.some(p=>!check.parts.some(q=>q.name===p.name&&q.md5===p.md5&&q.bytes.equals(p.bytes)))||!check.parts.find(p=>p.name===partName)?.bytes.equals(Buffer.from(changed)))throw Error('Clone verification failed');if((await inspectXml({file:source})).sha256!==sha256)throw Error('Source changed since inspection');await link(temp,destination);}finally{if(made)await unlink(temp);}
 return {destination,templateName,trackName,partName,removedCues:cueMode==='remove'?direct.length:0,cueMode,cueMapping,nodeMapping,warnings,note:'Offline clone only. Media fields and audio are copied, not validated. Encoded, computed, external and binary references may be missed. ShowKontrol acceptance and playback are not verified; the set list is unchanged.'};
}
