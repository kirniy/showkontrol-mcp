import {open, writeFile, link, unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {parseXmlSpans} from './xml-spans.js';
import {prepareShowProgram} from './xml-copy.js';

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
  const {start,name,notes}=node.attributes;if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(start)||!Number.isFinite(Number(start))||Number(start)>86399999)throw Error('Invalid item start');text(name,'name');text(notes,'notes');
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
export async function attachShowProgramCopy({source,destination,sha256,program,programSha256,replaceExisting=false}){
 if(!path.isAbsolute(destination)||path.extname(destination).toLowerCase()!=='.skshow'||path.resolve(source)===path.resolve(destination)||path.resolve(program)===path.resolve(destination))throw Error('Destination must be a different absolute .skshow path');
 if(!/^[a-f0-9]{64}$/.test(sha256||'')||!/^[a-f0-9]{64}$/.test(programSha256||''))throw Error('Source and Program SHA-256 values are required');
 const input=await snapshot(program);if(input.sha256!==programSha256)throw Error('Program changed since inspection');
 const bytes=input.bytes,show=await prepareShowProgram({file:source,bytes,replaceExisting});if(show.sha256!==sha256)throw Error('Source changed since inspection');
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
