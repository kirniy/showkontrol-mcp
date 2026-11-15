import {open,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {SaxesParser} from 'saxes';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseXmlSpans} from './xml-spans.js';
const DEFAULT_MAX_BYTES=128*1024*1024;
function maxBytes(){
 const value=process.env.SHOWKONTROL_OFFLINE_MAX_BYTES;
 if(value===undefined)return DEFAULT_MAX_BYTES;
 if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)throw Error('Invalid SHOWKONTROL_OFFLINE_MAX_BYTES');
 return Number(value);
}
function checkSize(size,limit,kind){if(size>limit)throw Error(`${kind} exceeds offline size limit of ${limit} bytes`);}
function validate(xml) {
 if (/<!DOCTYPE/i.test(xml)) throw Error('DOCTYPE is not supported');
 const parser=new SaxesParser(); parser.write(xml).close();
}
async function load(file) {
 if (!path.isAbsolute(file)) throw Error('Use an absolute source path');
 const limit=maxBytes(),handle=await open(file,constants.O_RDONLY|constants.O_NONBLOCK);let data;
 try{
  const info=await handle.stat();if(!info.isFile())throw Error('XML source must be a regular file');
  checkSize(info.size,limit,'XML file');
  const chunks=[];let total=0;
  while(total<=limit){
   const buffer=Buffer.allocUnsafe(Math.min(64*1024,limit-total+1));
   const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;
   total+=bytesRead;checkSize(total,limit,'XML file');chunks.push(buffer.subarray(0,bytesRead));
  }
  data=Buffer.concat(chunks,total);
 }finally{await handle.close();}
 const xml=new TextDecoder('utf-8',{fatal:true}).decode(data);validate(xml);return xml;
}
export async function inspectXml({file}) {
 const xml=await load(file);
 return {file,sha256:createHash('sha256').update(xml).digest('hex'),xml};
}
export async function editXmlCopy({source,destination,sha256,edits}) {
 if(!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Destination must be a different absolute path');
 let xml=await load(source);
 if(createHash('sha256').update(xml).digest('hex')!==sha256)throw Error('Source changed since inspection');
 for(const {find,replace} of edits){
  if(!find)throw Error('Search text cannot be empty');
  const pos=xml.indexOf(find);if(pos<0||xml.indexOf(find,pos+1)>=0)throw Error('Each search text must occur exactly once');
  xml=xml.slice(0,pos)+replace+xml.slice(pos+find.length);
 }
 checkSize(Buffer.byteLength(xml),maxBytes(),'XML output');
 validate(xml);await writeFile(destination,xml,{encoding:'utf8',flag:'wx'});
 return {destination,sha256:createHash('sha256').update(xml).digest('hex'),edits:edits.length,note:'XML syntax checked; ShowKontrol compatibility has not been checked.'};
}
function parts(xml) {
 const root=parseXmlSpans(xml);if(root.name!=='skshow')throw Error('Not a supported skshow wrapper');
 const out=[];
 for(const node of root.children.filter(child=>child.name==='part')){
  const {name,md5}=node.attributes;
  if(typeof name!=='string'||/[&<>]/.test(name)||typeof md5!=='string'||!/^[a-fA-F0-9]{32}$/.test(md5))throw Error('Unsupported part attributes');
  const content=xml.slice(node.openEnd,node.closeStart);
  if(node.selfClosing||node.children.length||!/^[A-Za-z0-9+/=\s]*$/.test(content))throw Error('Unsupported part encoding or structure');
  const encoded=content.replace(/\s/g,'');const bytes=Buffer.from(encoded,'base64');
  if(bytes.toString('base64')!==encoded)throw Error(`Invalid base64 in ${name}`);
  const actual=createHash('md5').update(bytes).digest('hex');
  out.push({name,md5,valid:actual===md5.toLowerCase(),bytes,start:node.start,end:node.end,attrs:xml.slice(node.start+5,node.openEnd-1)});
 }
 return out;
}
export async function readShowSnapshot({file}) {
 const xml=await load(file);const entries=parts(xml);
 if(!entries.length)throw Error('Not a supported skshow wrapper');
 return {file,sha256:createHash('sha256').update(xml).digest('hex'),parts:entries.map(({name,md5,valid,bytes})=>({name,md5,valid,bytes}))};
}
export async function inspectShow({file}) {
 const snapshot=await readShowSnapshot({file});
 return {file,sha256:snapshot.sha256,parts:snapshot.parts.map(({name,md5,valid,bytes})=>({name,md5,valid,size:bytes.length}))};
}
export function readSnapshotPart({snapshot,name}) {
 const found=snapshot.parts.filter(p=>p.name===name);
 if(found.length!==1)throw Error('Part name must match exactly one part');
 if(!found[0].valid)throw Error('Part MD5 mismatch');
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(found[0].bytes)}catch{throw Error('Part is not UTF-8 text')}
 return {name,md5:found[0].md5,text};
}
export async function readShowPart({file,name}) {
 return readSnapshotPart({snapshot:await readShowSnapshot({file}),name});
}
export async function editShowPart({source,destination,sha256,name,edits}) {
 if(!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Destination must be a different absolute path');
 const xml=await load(source);
 if(createHash('sha256').update(xml).digest('hex')!==sha256)throw Error('Source changed since inspection');
 const all=parts(xml);if(!all.every(p=>p.valid))throw Error('A part MD5 does not match');
 const found=all.filter(p=>p.name===name);if(found.length!==1)throw Error('Part name must match exactly one part');const part=found[0];
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(part.bytes)}catch{throw Error('Part is not UTF-8 text')}
 validate(text);
 for(const {find,replace} of edits){if(!find)throw Error('Search text cannot be empty');let at=text.indexOf(find);if(at<0||text.indexOf(find,at+1)>=0)throw Error('Each search text must occur exactly once');text=text.slice(0,at)+replace+text.slice(at+find.length)}
 validate(text);const bytes=Buffer.from(text,'utf8');const md5=createHash('md5').update(bytes).digest('hex');
 const md5Attr=/(\smd5\s*=\s*["'])[a-fA-F0-9]{32}(["'])/g;
 if([...part.attrs.matchAll(md5Attr)].length!==1)throw Error('Unsupported part checksum serialization');
 const attrs=part.attrs.replace(md5Attr,(_,a,b)=>a+md5+b);
 let parsedAttrs;const parser=new SaxesParser();parser.on('opentag',tag=>{parsedAttrs=tag.attributes});parser.write(`<part${attrs}/>`).close();
 if(parsedAttrs.md5!==md5)throw Error('Unsupported part checksum serialization');
 const replacement=`<part${attrs}>${bytes.toString('base64')}</part>`;const output=xml.slice(0,part.start)+replacement+xml.slice(part.end);validate(output);
 checkSize(Buffer.byteLength(output),maxBytes(),'XML output');
 await writeFile(destination,output,{encoding:'utf8',flag:'wx'});
 return {destination,name,md5,note:'Part and wrapper syntax checked; ShowKontrol compatibility has not been checked.'};
}

export async function addShowPart({source,destination,sha256,name,text}) {
 if(!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination))throw Error('Destination must be a different absolute path');
 if(!/^content\/[A-Za-z0-9_-]+\.sktl$/.test(name))throw Error('Unsupported timeline part name');
 const xml=await load(source);if(createHash('sha256').update(xml).digest('hex')!==sha256)throw Error('Source changed since inspection');
 const entries=parts(xml);if(!entries.length||!entries.every(p=>p.valid))throw Error('Missing parts or a part MD5 does not match');
 if(entries.some(p=>p.name.toLowerCase()===name.toLowerCase()))throw Error('Part name already exists');
 validate(text);const bytes=Buffer.from(text,'utf8');const md5=createHash('md5').update(bytes).digest('hex');
 const closings=[...xml.matchAll(/<\/skshow\s*>/g)];if(closings.length!==1||!/^\s*$/.test(xml.slice(closings[0].index+closings[0][0].length)))throw Error('Unsupported show wrapper');
 const patch=entries.find(p=>p.name==='patch.skf');
 if(!patch)throw Error('Show has no patch.skf part');
 const at=patch.start;const entry=`<part name="${name}" md5="${md5}">${bytes.toString('base64')}</part>`;
 const output=xml.slice(0,at)+entry+xml.slice(at);validate(output);
 checkSize(Buffer.byteLength(output),maxBytes(),'XML output');
 await writeFile(destination,output,{encoding:'utf8',flag:'wx'});return {destination,name,md5};
}

// Build a Program replacement while retaining the original wrapper and unrelated parts.
export async function prepareShowProgram({file,bytes,replaceExisting=false}) {
 const xml=await load(file), entries=parts(xml), root=parseXmlSpans(xml);
 if(!entries.length||!entries.every(p=>p.valid))throw Error('Missing parts or a part MD5 does not match');
 const names=new Set();for(const entry of entries){const key=entry.name.toLowerCase();if(names.has(key))throw Error('Duplicate part name');names.add(key);}
 const name='content/Program.skpr', existing=entries.find(p=>p.name.toLowerCase()===name.toLowerCase());
 if(existing&&existing.name!==name)throw Error('Program part name is not canonical');
 if(bytes===undefined)return {sha256:createHash('sha256').update(xml).digest('hex'),bytes:existing?.bytes};
 if(existing&&!replaceExisting)throw Error('Program part already exists; set replaceExisting to true');
 const md5=createHash('md5').update(bytes).digest('hex');
 let attrs=` name="${name}" md5="${md5}"`;
 if(existing){
  const md5Attr=/(\smd5\s*=\s*["'])[a-fA-F0-9]{32}(["'])/g;
  if([...existing.attrs.matchAll(md5Attr)].length!==1)throw Error('Unsupported part checksum serialization');
  attrs=existing.attrs.replace(md5Attr,(_,a,b)=>a+md5+b);
  let parsedAttrs;const parser=new SaxesParser();parser.on('opentag',tag=>{parsedAttrs=tag.attributes});parser.write(`<part${attrs}/>`).close();
  if(parsedAttrs.md5!==md5||parsedAttrs.name!==name)throw Error('Unsupported part checksum serialization');
 }
 const entry=`<part${attrs}>${bytes.toString('base64')}</part>`;
 if(root.selfClosing)throw Error('Unsupported show wrapper');
 const output=existing?xml.slice(0,existing.start)+entry+xml.slice(existing.end):xml.slice(0,root.closeStart)+entry+xml.slice(root.closeStart);
 validate(output);checkSize(Buffer.byteLength(output),maxBytes(),'XML output');
 const roundtrip=parts(output);if(!roundtrip.every(p=>p.valid)||roundtrip.length!==entries.length+(existing?0:1))throw Error('Program roundtrip verification failed');
 const actual=roundtrip.find(p=>p.name===name);if(!actual||!actual.bytes.equals(bytes))throw Error('Program roundtrip verification failed');
 for(const old of entries.filter(p=>p!==existing)){const next=roundtrip.find(p=>p.name===old.name);if(!next||next.md5!==old.md5||!next.bytes.equals(old.bytes))throw Error('Unrelated part changed');}
 return {sha256:createHash('sha256').update(xml).digest('hex'),output,md5};
}
