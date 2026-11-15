import {readFile,writeFile} from 'node:fs/promises';
import {SaxesParser} from 'saxes';
import path from 'node:path';
import {createHash} from 'node:crypto';
const MAX_BYTES=5*1024*1024;
function validate(xml) {
 if (/<!DOCTYPE/i.test(xml)) throw Error('DOCTYPE is not supported');
 const parser=new SaxesParser(); parser.write(xml).close();
}
async function load(file) {
 if (!path.isAbsolute(file)) throw Error('Use an absolute source path');
 const data=await readFile(file);if(data.length>MAX_BYTES)throw Error('XML file exceeds 5 MiB');
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
 if(Buffer.byteLength(xml)>MAX_BYTES)throw Error('XML output exceeds 5 MiB');
 validate(xml);await writeFile(destination,xml,{encoding:'utf8',flag:'wx'});
 return {destination,sha256:createHash('sha256').update(xml).digest('hex'),edits:edits.length,note:'XML syntax checked; ShowKontrol compatibility has not been checked.'};
}
function parts(xml) {
 const out=[];const re=/<part\b([^>]*)>([A-Za-z0-9+/=\s]*)<\/part\s*>/g;let m;
 while((m=re.exec(xml))){
  let attrs;const parser=new SaxesParser();parser.on('opentag',tag=>{attrs=tag.attributes});parser.write(`<part${m[1]}/>`).close();
  const name=attrs.name,md5=attrs.md5;
  if(typeof name!=='string'||/[&<>]/.test(name)||typeof md5!=='string'||!/^[a-fA-F0-9]{32}$/.test(md5))throw Error('Unsupported part attributes');
  const encoded=m[2].replace(/\s/g,'');const bytes=Buffer.from(encoded,'base64');
  if(bytes.toString('base64')!==encoded)throw Error(`Invalid base64 in ${name}`);
  const actual=createHash('md5').update(bytes).digest('hex');
  out.push({name,md5,valid:actual===md5.toLowerCase(),bytes,start:m.index,end:re.lastIndex,full:m[0],attrs:m[1]});
 }
 if ((xml.match(/<part(?:\s|>)/g)||[]).length !== out.length) throw Error('Unsupported part encoding or structure');
 return out;
}
export async function inspectShow({file}) {
 const xml=await load(file);const entries=parts(xml);
 if(!/^\s*(?:<\?xml[^>]*>\s*)?<skshow(?:\s|>)/.test(xml)||!entries.length)throw Error('Not a supported skshow wrapper');
 return {file,sha256:createHash('sha256').update(xml).digest('hex'),parts:entries.map(({name,md5,valid,bytes})=>({name,md5,valid,size:bytes.length}))};
}
export async function readShowPart({file,name}) {
 const xml=await load(file);const found=parts(xml).filter(p=>p.name===name);
 if(found.length!==1)throw Error('Part name must match exactly one part');
 if(!found[0].valid)throw Error('Part MD5 mismatch');
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(found[0].bytes)}catch{throw Error('Part is not UTF-8 text')}
 return {name,md5:found[0].md5,text};
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
 if(Buffer.byteLength(output)>MAX_BYTES)throw Error('XML output exceeds 5 MiB');
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
 if(Buffer.byteLength(output)>MAX_BYTES)throw Error('XML output exceeds 5 MiB');
 await writeFile(destination,output,{encoding:'utf8',flag:'wx'});return {destination,name,md5};
}
