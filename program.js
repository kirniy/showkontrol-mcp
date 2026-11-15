import {open, writeFile, link, unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {parseXmlSpans} from './xml-spans.js';
import {prepareShowProgram,inspectXml,readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseTimeline} from './timeline.js';
import {SaxesParser} from 'saxes';
import {hasXmlReference} from './xml-references.js';

const hash=b=>createHash('sha256').update(b).digest('hex');
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;').replaceAll('\t','&#x9;').replaceAll('\n','&#xA;').replaceAll('\r','&#xD;');
function text(s,label){if(typeof s!=='string'||s.length>4096||/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|[\ud800-\udfff]/u.test(s))throw Error(`Invalid ${label}`);return s;}
function time(n){if(!Number.isInteger(n)||n<0||n>86399999)throw Error('start must be an integer from 0 to 86399999');return n;}
function whitespace(xml,node){let pos=node.openEnd;for(const c of node.children){if(xml.slice(pos,c.start).trim())throw Error('Unsupported mixed content');pos=c.end;}if(!node.selfClosing&&xml.slice(pos,node.closeStart).trim())throw Error('Unsupported mixed content');}
function parse(xml){
 const root=parseXmlSpans(xml);if(root.name!=='skprogram'||root.attributes.version!=='1'||Object.keys(root.attributes).length!==1)throw Error('Unsupported Program root');
 whitespace(xml,root);
 const items=root.children.map((node,index)=>{
  if(node.name!=='item'||Object.keys(node.attributes).sort().join(',')!=='name,notes,start')throw Error('Unsupported Program item');
  const {start,name,notes}=node.attributes;if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(start)||!Number.isFinite(Number(start))||Number(start)>=86400000)throw Error('Invalid item start');text(name,'name');text(notes,'notes');
  if(node.children.some(c=>!['graph','sktimeline'].includes(c.name))||new Set(node.children.map(c=>c.name)).size!==node.children.length)throw Error('Unsupported item children');
  whitespace(xml,node);
  return {index,start:Number(start),name,notes,hasGraph:node.children.some(c=>c.name==='graph'),hasTimeline:node.children.some(c=>c.name==='sktimeline'),node};
 });return {root,items};
}
async function snapshot(file){
 if(!path.isAbsolute(file)||path.extname(file).toLowerCase()!=='.skpr')throw Error('An absolute .skpr path is required');
 const limit=10*1024*1024,handle=await open(file,constants.O_RDONLY|constants.O_NONBLOCK);let bytes;
 try{
  const info=await handle.stat();if(!info.isFile())throw Error('Program source must be a regular file');if(info.size>limit)throw Error('Program exceeds 10 MiB');
  const chunks=[];let total=0;
  while(total<=limit){const buffer=Buffer.allocUnsafe(Math.min(65536,limit-total+1));const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>limit)throw Error('Program exceeds 10 MiB');chunks.push(buffer.subarray(0,bytesRead));}
  bytes=Buffer.concat(chunks,total);
 }finally{await handle.close();}
 const xml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);return {xml,bytes,sha256:hash(bytes),...parse(xml)};
}
const publicItems=items=>items.map(({node,...item})=>item);
export async function inspectProgram({file}){const s=await snapshot(file);return {file,sha256:s.sha256,items:publicItems(s.items),note:'Static format evidence only; application acceptance, item sorting, cues and media are not verified.'};}
function attr(xml,node,key,value){const opening=xml.slice(node.start,node.openEnd),re=/\s+([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g,matches=[...opening.matchAll(re)].filter(m=>m[1]===key);if(matches.length!==1)throw Error('Unsupported attribute serialization');const m=matches[0],at=node.start+m.index+m[0].indexOf(m[2])+1;return {start:at,end:at+m[2].length-2,value:escape(String(value))};}
export async function createProgramCopy({destination,source,sha256,operation,items}){
 if(!path.isAbsolute(destination)||path.extname(destination).toLowerCase()!=='.skpr')throw Error('Destination must be an absolute .skpr path');
 let xml,sourceSnapshot;
 if(items!==undefined&&(source!==undefined||operation!==undefined))throw Error('Items cannot be combined with source or operation');
 if(source===undefined){
  if(sha256!==undefined||operation!==undefined)throw Error('New Program must not specify sha256 or operation');
  if(items!==undefined&&(!Array.isArray(items)||items.length>1000))throw Error('Items must be an array of at most 1000 items');
  const serialized=(items??[]).map(item=>{if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='name,notes,start')throw Error('Invalid item');const {start,name,notes}=item;time(start);text(name,'name');text(notes,'notes');return `<item start="${start}" name="${escape(name)}" notes="${escape(notes)}" />`;}).join('');
  xml=`<?xml version="1.0" encoding="utf-8"?>\n<skprogram version="1">${serialized}</skprogram>\n`;
 }
 else{
  if(path.resolve(source)===path.resolve(destination))throw Error('Source and destination must differ');if(!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('A source SHA-256 is required');sourceSnapshot=await snapshot(source);if(sourceSnapshot.sha256!==sha256)throw Error('Source changed since inspection');
  if(!operation||!['add','edit','remove'].includes(operation.action))throw Error('Invalid operation');
  let {root,items}=sourceSnapshot;xml=sourceSnapshot.xml;
  if(operation.action==='add'){
   const {start,name,notes}=operation;time(start);text(name,'name');text(notes,'notes');const item=`<item start="${start}" name="${escape(name)}" notes="${escape(notes)}" />`;
   if(root.selfClosing)xml=xml.slice(0,root.openEnd-2)+'>'+item+'</skprogram>'+xml.slice(root.end);else xml=xml.slice(0,root.closeStart)+item+xml.slice(root.closeStart);
  }else{
   if(!Number.isInteger(operation.index)||operation.index<0||operation.index>=items.length)throw Error('Item index out of range');const item=items[operation.index];
   if(operation.action==='remove'){
    if(item.node.children.length&&!operation.allowContentRemoval)throw Error('Item contains graph or timeline content; set allowContentRemoval to remove it');xml=xml.slice(0,item.node.start)+xml.slice(item.node.end);
   }else{
    const edits=[];for(const key of ['start','name','notes'])if(operation[key]!==undefined){if(key==='start')time(operation[key]);else text(operation[key],key);edits.push(attr(xml,item.node,key,operation[key]));}if(!edits.length)throw Error('Edit requires start, name or notes');for(const e of edits.sort((a,b)=>b.start-a.start))xml=xml.slice(0,e.start)+e.value+xml.slice(e.end);
   }
  }
 }
 parse(xml);if(Buffer.byteLength(xml,'utf8')>10*1024*1024)throw Error('Program exceeds 10 MiB');const temp=path.join(path.dirname(destination),`.showkontrol-program-${randomUUID()}.tmp`);let created=false;
 try{await writeFile(temp,xml,{flag:'wx'});created=true;if(sourceSnapshot&&(await snapshot(source)).sha256!==sha256)throw Error('Source changed since inspection');await link(temp,destination);}finally{if(created)await unlink(temp);}
 return {destination,sha256:hash(Buffer.from(xml)),items:publicItems(parse(xml).items),note:'Static format evidence only; application acceptance, item sorting, cues and media are not verified.'};
}

const note='Static format evidence only; application acceptance, item sorting, cues and media are not verified.';
export function inspectProgramBytes(bytes){
 if(bytes.length>10*1024*1024)throw Error('Program exceeds 10 MiB');
 const xml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
 return {programSha256:hash(bytes),items:publicItems(parse(xml).items),note};
}
export async function inspectShowProgram({file}){
 const show=await prepareShowProgram({file});if(!show.bytes)return {file,sha256:show.sha256,present:false,note};
 return {file,sha256:show.sha256,present:true,...inspectProgramBytes(show.bytes)};
}
async function programItem({file,sha256,index}){
 if(!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('A source SHA-256 is required');
 if(!Number.isInteger(index)||index<0)throw Error('Item index out of range');
 let input;
 if(path.extname(file).toLowerCase()==='.skpr')input=await snapshot(file);
 else if(path.isAbsolute(file)&&path.extname(file).toLowerCase()==='.skshow'){
  const show=await prepareShowProgram({file});if(!show.bytes)throw Error('Show has no canonical Program part');
  if(show.bytes.length>10*1024*1024)throw Error('Program exceeds 10 MiB');
  const xml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(show.bytes);
  input={xml,sha256:show.sha256,...parse(xml)};
 }else throw Error('An absolute .skpr or .skshow path is required');
 if(input.sha256!==sha256)throw Error('Source changed since inspection');
 if(index>=input.items.length)throw Error('Item index out of range');
 return {input,item:input.items[index]};
}
async function programTimeline(args){
 const {input,item}=await programItem(args),node=item.node.children.find(c=>c.name==='sktimeline');
 if(!node)throw Error('Item has no embedded timeline');
 const element=input.xml.slice(node.start,node.end);
 const timeline=parseTimeline(element);
 return {input,item,element,timeline};
}
export async function inspectProgramTimeline({file,sha256,index}){
 const {item,timeline}=await programTimeline({file,sha256,index});
 // Preview data can be large and is not useful for identifying timeline content.
 const clean=attributes=>Object.fromEntries(Object.entries(attributes).filter(([key])=>!/preview/i.test(key)));
 const result={file,sha256,index,item:publicItems([item])[0],attributes:clean(timeline.attributes),layers:timeline.layers.map(clean),audio:timeline.audio.map(clean),audioClips:timeline.audioClips.map(c=>({...c,attributes:clean(c.attributes)})),cueElements:timeline.cueElements.map(c=>({...c,attributes:clean(c.attributes)})),note:'Static format evidence only; application acceptance, cues and media playback are unverified. Preview attributes are omitted.'};
 if(Buffer.byteLength(JSON.stringify(result,null,2),'utf8')>1024*1024)throw Error('Timeline inspection output exceeds 1 MiB');
 return result;
}
export async function inspectProgramItemGraph({file,sha256,index}){
 const {input,item}=await programItem({file,sha256,index});
 const graphNode=item.node.children.find(c=>c.name==='graph');
 if(!graphNode)throw Error('Item has no graph');
 const graph={nodes:[],connections:[]},stack=[],ids=new Set();let node,setting,settingText='',settingsSeen=false;
 const parser=new SaxesParser();
 parser.on('doctype',()=>{throw Error('DOCTYPE is not supported');});
 parser.on('opentag',tag=>{
  const parent=stack.at(-1);stack.push(tag.name);const depth=stack.length;
  if(depth===1){if(tag.name!=='graph')throw Error('Expected graph');}
  else if(depth===2&&parent==='graph'&&tag.name==='node'){
   if(!tag.attributes.id||!tag.attributes.type||ids.has(tag.attributes.id))throw Error('Graph node ID and type must be present and node IDs unique');
   ids.add(tag.attributes.id);node={...tag.attributes,settings:[]};settingsSeen=false;graph.nodes.push(node);
  }else if(depth===2&&parent==='graph'&&tag.name==='connection'){
   if(!tag.attributes.fromNode||!tag.attributes.toNode)throw Error('Connection endpoints are required');graph.connections.push({...tag.attributes});
  }else if(depth===3&&parent==='node'&&tag.name==='settings'){
   if(settingsSeen)throw Error('Multiple node settings elements');settingsSeen=true;
  }else if(depth===4&&parent==='settings'&&tag.name==='setting'){
   if(Object.keys(tag.attributes).join(',')!=='key'||!tag.attributes.key||node.settings.some(s=>s.key===tag.attributes.key))throw Error('Setting keys must be present and unique');
   setting={key:tag.attributes.key};settingText='';
  }else throw Error('Unsupported graph structure');
 });
 const content=s=>{if(setting)settingText+=s;else if(s.trim())throw Error('Unsupported graph text');};
 parser.on('text',content);parser.on('cdata',content);
 parser.on('closetag',tag=>{
  if(tag.name==='setting'){setting.value=settingText;node.settings.push(setting);setting=null;}
  if(tag.name==='node')node=null;stack.pop();
 });
 parser.write(input.xml.slice(graphNode.start,graphNode.end)).close();
 if(graph.connections.some(c=>!ids.has(c.fromNode)||!ids.has(c.toNode)))throw Error('Connection refers to an unknown node');
 const result={file,sha256,index,item:publicItems([item])[0],graph,note:'Static format evidence only; graph behavior, dependencies and ShowKontrol application acceptance are unverified.'};
 if(Buffer.byteLength(JSON.stringify(result,null,2),'utf8')>1024*1024)throw Error('Graph inspection output exceeds 1 MiB');
 return result;
}
export async function extractProgramTimelineCopy({source,destination,sha256,index}){
 if(typeof source!=='string'||!path.isAbsolute(destination)||path.extname(destination).toLowerCase()!=='.sktl'||path.resolve(source)===path.resolve(destination))throw Error('Destination must be a different absolute .sktl path');
 const {element}=await programTimeline({file:source,sha256,index});
 const bytes=Buffer.from(element,'utf8');
 const temp=path.join(path.dirname(destination),`.showkontrol-timeline-${randomUUID()}.tmp`);let created=false;
 try{
  await writeFile(temp,bytes,{flag:'wx'});created=true;
  await programTimeline({file:source,sha256,index});
  await link(temp,destination);
 }finally{if(created)await unlink(temp);}
 return {destination,sha256:hash(bytes),warnings:['Static format evidence only; application acceptance is unverified.','External references and media are unverified; media was not copied.','Runtime node IDs may change; IDs were not remapped.']};
}
export async function extractShowProgramCopy({source,destination,sha256}){
 if(!path.isAbsolute(destination)||path.extname(destination).toLowerCase()!=='.skpr'||path.resolve(source)===path.resolve(destination))throw Error('Destination must be a different absolute .skpr path');
 if(!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('A source SHA-256 is required');
 const show=await prepareShowProgram({file:source});if(show.sha256!==sha256)throw Error('Source changed since inspection');
 if(!show.bytes)throw Error('Show has no canonical Program part');
 const inspected=inspectProgramBytes(show.bytes);
 const temp=path.join(path.dirname(destination),`.showkontrol-program-${randomUUID()}.tmp`);let created=false;
 try{
  await writeFile(temp,show.bytes,{flag:'wx'});created=true;
  if((await prepareShowProgram({file:source})).sha256!==sha256)throw Error('Source changed since inspection');
  await link(temp,destination);
 }finally{if(created)await unlink(temp);}
 return {destination,name:'content/Program.skpr',sha256:inspected.programSha256,items:inspected.items,note};
}
function programDefinitions(xml,root){
 const ids=new Map();
 const visit=node=>{
  if((node.name==='node'||node.name==='cue')&&node.attributes.id){
   const id=node.attributes.id,definitions=ids.get(id)??[];definitions.push(xml.slice(node.start,node.end));ids.set(id,definitions);
  }
  for(const child of node.children)visit(child);
 };
 visit(root);return ids;
}
export async function attachShowProgramCopy({source,destination,sha256,program,programSha256,replaceExisting=false}){
 if(!path.isAbsolute(destination)||path.extname(destination).toLowerCase()!=='.skshow'||path.resolve(source)===path.resolve(destination)||path.resolve(program)===path.resolve(destination))throw Error('Destination must be a different absolute .skshow path');
 if(!/^[a-f0-9]{64}$/.test(sha256||'')||!/^[a-f0-9]{64}$/.test(programSha256||''))throw Error('Source and Program SHA-256 values are required');
 const input=await snapshot(program);if(input.sha256!==programSha256)throw Error('Program changed since inspection');
 const bytes=input.bytes,show=await prepareShowProgram({file:source,bytes,replaceExisting});if(show.sha256!==sha256)throw Error('Source changed since inspection');
 const archive=await readShowSnapshot({file:source});if(archive.sha256!==sha256)throw Error('Source changed since inspection');
 const old=archive.parts.find(p=>p.name==='content/Program.skpr');
 if(old){
  const oldXml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(old.bytes);
  const oldIds=programDefinitions(oldXml,parse(oldXml).root),newIds=programDefinitions(input.xml,input.root);
  for(const id of new Set([...oldIds.keys(),...newIds.keys()])){
   const before=oldIds.get(id)??[],after=newIds.get(id)??[];
   if((before.length>1||after.length>1)&&JSON.stringify([...before].sort())!==JSON.stringify([...after].sort()))throw Error('Program has ambiguous duplicate node or cue ID');
  }
  const removed=[...oldIds.keys()].filter(id=>!newIds.has(id));
  if(removed.length){
   const others=archive.parts.filter(p=>p.name!=='content/Program.skpr'&&/\.(?:skf|sktl|sksc|skls|skpr|skcp)$/i.test(p.name));
   for(const part of others){
    const xml=readSnapshotPart({snapshot:archive,name:part.name}).text;
    for(const id of removed){const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
     if(hasXmlReference(xml,new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`)))throw Error(`Removed Program ID is referenced in another show part: ${id}`);
    }
   }
  }
 }
 const temp=path.join(path.dirname(destination),`.showkontrol-program-${randomUUID()}.tmp`);let created=false;
 try{
  await writeFile(temp,show.output,{flag:'wx'});created=true;
  const verify=await prepareShowProgram({file:temp});if(verify.sha256!==hash(Buffer.from(show.output))||!verify.bytes?.equals(bytes))throw Error('Program roundtrip verification failed');
  if((await prepareShowProgram({file:source})).sha256!==sha256)throw Error('Source changed since inspection');
  if((await snapshot(program)).sha256!==programSha256)throw Error('Program changed since inspection');
  await link(temp,destination);
 }finally{if(created)await unlink(temp);}
 return {destination,name:'content/Program.skpr',sha256:hash(Buffer.from(show.output)),programSha256,md5:show.md5,note};
}

// Copy the donor root element verbatim. Media and cross-file references are not copied.
async function timelineDonor({donor,donorName}){
 if(!path.isAbsolute(donor))throw Error('Donor must be an absolute path');
 let xml,sha256;
 const ext=path.extname(donor).toLowerCase();
 if(ext==='.sktl'){
  if(donorName!==undefined)throw Error('Donor part name is only supported for a show');
  ({xml,sha256}=await inspectXml({file:donor}));
 }else if(ext==='.skshow'){
  if(typeof donorName!=='string'||!donorName.toLowerCase().endsWith('.sktl'))throw Error('A .sktl donor part name is required');
  const show=await readShowSnapshot({file:donor});
  if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
  const names=new Set();for(const part of show.parts){const key=part.name.toLowerCase();if(names.has(key))throw Error('Duplicate part name');names.add(key);}
  sha256=show.sha256;xml=readSnapshotPart({snapshot:show,name:donorName}).text;
 }else throw Error('Donor must be a .sktl or .skshow file');
 parseTimeline(xml);const root=parseXmlSpans(xml);
 return {sha256,xml,root,element:xml.slice(root.start,root.end)};
}
export async function embedProgramTimelineCopy({source,destination,sha256,index,donor,donorSha256,donorName,replaceExisting=false}){
 if(!path.isAbsolute(destination)||path.extname(destination).toLowerCase()!=='.skpr'||path.resolve(source)===path.resolve(destination)||path.resolve(donor)===path.resolve(destination))throw Error('Destination must be a different absolute .skpr path');
 if(!/^[a-f0-9]{64}$/.test(sha256||'')||!/^[a-f0-9]{64}$/.test(donorSha256||''))throw Error('Program and donor SHA-256 values are required');
 if(typeof replaceExisting!=='boolean')throw Error('replaceExisting must be a boolean');
 const input=await snapshot(source);if(input.sha256!==sha256)throw Error('Program changed since inspection');
 if(!Number.isInteger(index)||index<0||index>=input.items.length)throw Error('Item index out of range');
 const timeline=await timelineDonor({donor,donorName});if(timeline.sha256!==donorSha256)throw Error('Donor changed since inspection');
 const item=input.items[index].node,existing=item.children.find(c=>c.name==='sktimeline');
 if(existing&&!replaceExisting)throw Error('Item already has a timeline; set replaceExisting to true');
 let xml=input.xml;
 if(existing)xml=xml.slice(0,existing.start)+timeline.element+xml.slice(existing.end);
 else if(item.selfClosing){const opening=xml.slice(item.start,item.openEnd).replace(/\/\s*>$/, '>');xml=xml.slice(0,item.start)+opening+timeline.element+'</item>'+xml.slice(item.end);}
 else xml=xml.slice(0,item.closeStart)+timeline.element+xml.slice(item.closeStart);
 parse(xml);if(Buffer.byteLength(xml,'utf8')>10*1024*1024)throw Error('Program exceeds 10 MiB');
 const temp=path.join(path.dirname(destination),`.showkontrol-program-${randomUUID()}.tmp`);let created=false;
 try{
  await writeFile(temp,xml,{flag:'wx'});created=true;
  if((await snapshot(source)).sha256!==sha256)throw Error('Program changed since inspection');
  if((await timelineDonor({donor,donorName})).sha256!==donorSha256)throw Error('Donor changed since inspection');
  await link(temp,destination);
 }finally{if(created)await unlink(temp);}
 return {destination,sha256:hash(Buffer.from(xml)),items:publicItems(parse(xml).items),warnings:['Static format evidence only; application acceptance is unverified.','External references and media are unverified; media was not copied.','Runtime node IDs may change; IDs were not remapped.']};
}

// Preserve the donor graph as XML. Program and cue signal names can differ.
export async function copyProgramItemGraphCopy({source,destination,sha256,index,donor,donorSha256,donorName,donorCueId,replaceExisting=false}){
 if(!path.isAbsolute(destination)||path.extname(destination).toLowerCase()!=='.skpr'||path.resolve(source)===path.resolve(destination)||path.resolve(donor)===path.resolve(destination))throw Error('Destination must be a different absolute .skpr path');
 if(!/^[a-f0-9]{64}$/.test(sha256||'')||!/^[a-f0-9]{64}$/.test(donorSha256||''))throw Error('Program and donor SHA-256 values are required');
 if(typeof replaceExisting!=='boolean')throw Error('replaceExisting must be a boolean');
 if(typeof donorCueId!=='string'||!donorCueId)throw Error('Donor cue ID is required');
 const input=await snapshot(source);if(input.sha256!==sha256)throw Error('Program changed since inspection');
 if(!Number.isInteger(index)||index<0||index>=input.items.length)throw Error('Item index out of range');
 const timeline=await timelineDonor({donor,donorName});if(timeline.sha256!==donorSha256)throw Error('Donor changed since inspection');
 const cues=timeline.root.children.filter(c=>c.name==='cue'&&c.attributes.id===donorCueId);
 if(cues.length!==1)throw Error('Donor cue must match exactly one direct cue');
 const graphs=cues[0].children.filter(c=>c.name==='graph');if(graphs.length!==1)throw Error('Donor cue must contain exactly one direct graph');
 const graph=timeline.xml.slice(graphs[0].start,graphs[0].end),item=input.items[index].node,existing=item.children.find(c=>c.name==='graph');
 if(existing&&!replaceExisting)throw Error('Item already has a graph; set replaceExisting to true');
 let xml=input.xml;
 if(existing)xml=xml.slice(0,existing.start)+graph+xml.slice(existing.end);
 else if(item.selfClosing){const opening=xml.slice(item.start,item.openEnd).replace(/\/\s*>$/, '>');xml=xml.slice(0,item.start)+opening+graph+'</item>'+xml.slice(item.end);}
 else xml=xml.slice(0,item.closeStart)+graph+xml.slice(item.closeStart);
 parse(xml);if(Buffer.byteLength(xml,'utf8')>10*1024*1024)throw Error('Program exceeds 10 MiB');
 const temp=path.join(path.dirname(destination),`.showkontrol-program-${randomUUID()}.tmp`);let created=false;
 try{
  await writeFile(temp,xml,{flag:'wx'});created=true;
  if((await snapshot(source)).sha256!==sha256)throw Error('Program changed since inspection');
  if((await timelineDonor({donor,donorName})).sha256!==donorSha256)throw Error('Donor changed since inspection');
  await link(temp,destination);
 }finally{if(created)await unlink(temp);}
 return {destination,sha256:hash(Buffer.from(xml)),items:publicItems(parse(xml).items),warnings:['Inspect trigger settings and change cue.active to item.active as appropriate; settings were not changed.','Inspect dependencies and IDs for collisions and validity; IDs were not remapped.','Graph structure and ShowKontrol application acceptance are unverified.']};
}

// Edit only an existing direct node setting; retain all unrelated Program bytes.
export async function editProgramItemGraphSettingCopy({source,destination,sha256,index,nodeId,key,value}){
 if(typeof source!=='string'||!path.isAbsolute(destination)||path.extname(destination).toLowerCase()!=='.skpr'||path.resolve(source)===path.resolve(destination))throw Error('Destination must be a different absolute .skpr path');
 if(!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('A source SHA-256 is required');
 if(!/^[A-Za-z0-9_.:-]+$/.test(nodeId||'')||!/^[A-Za-z0-9_.:-]+$/.test(key||''))throw Error('Unsupported node ID or setting key');
 if(typeof value!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|[\ud800-\udfff]/u.test(value))throw Error('Invalid setting value');
 const input=await snapshot(source);if(input.sha256!==sha256)throw Error('Program changed since inspection');
 if(!Number.isInteger(index)||index<0||index>=input.items.length)throw Error('Item index out of range');
 const graph=input.items[index].node.children.find(c=>c.name==='graph');if(!graph)throw Error('Item has no graph');
 const descendants=(node,predicate)=>{const found=[];const visit=n=>{for(const c of n.children){if(predicate(c))found.push(c);visit(c);}};visit(node);return found;};
 const nodes=descendants(graph,n=>n.name==='node'&&n.attributes.id===nodeId);
 if(nodes.length!==1||!graph.children.includes(nodes[0]))throw Error('Node ID must occur exactly once as a direct graph node');
 const node=nodes[0],containers=node.children.filter(c=>c.name==='settings');if(containers.length!==1)throw Error('Node must have exactly one direct settings container');
 const settings=descendants(node,n=>n.name==='setting'&&n.attributes.key===key);
 if(settings.length!==1||!containers[0].children.includes(settings[0]))throw Error('Setting must occur exactly once as a direct node setting');
 const setting=settings[0],content=input.xml.slice(setting.openEnd,setting.closeStart);
 if(setting.children.length||content.includes('<')||Object.hasOwn(setting.attributes,'value'))throw Error('Unsupported setting serialization');
 const edits=[];
 if(key==='node.stopped'){
  if(!['true','false'].includes(value))throw Error('node.stopped value must be exactly true or false');
  if(setting.selfClosing||!['true','false'].includes(content))throw Error('Unsupported stopped setting value');
  if(Object.hasOwn(node.attributes,'stopped')){
   if(!['0','1'].includes(node.attributes.stopped))throw Error('Unsupported stopped attribute value');
   edits.push(attr(input.xml,node,'stopped',value==='true'?'1':'0'));
  }
 }
 const encoded=value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\r','&#xD;');
 if(setting.selfClosing){const opening=input.xml.slice(setting.start,setting.openEnd);edits.push({start:setting.start,end:setting.end,value:opening.replace(/\s*\/>$/,'>')+encoded+'</setting>'});}
 else edits.push({start:setting.openEnd,end:setting.closeStart,value:encoded});
 let xml=input.xml;for(const e of edits.sort((a,b)=>b.start-a.start))xml=xml.slice(0,e.start)+e.value+xml.slice(e.end);
 parse(xml);if(Buffer.byteLength(xml,'utf8')>10*1024*1024)throw Error('Program exceeds 10 MiB');
 const temp=path.join(path.dirname(destination),`.showkontrol-program-${randomUUID()}.tmp`);let created=false;
 try{await writeFile(temp,xml,{flag:'wx'});created=true;if((await snapshot(source)).sha256!==sha256)throw Error('Program changed since inspection');await link(temp,destination);}finally{if(created)await unlink(temp);}
 return {destination,sha256:hash(Buffer.from(xml)),index,nodeId,key,value,note:'Changed an existing Program item graph setting in an offline copy. Value semantics and ShowKontrol acceptance are unverified.'};
}
