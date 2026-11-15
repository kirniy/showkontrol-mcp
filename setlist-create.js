import {open,unlink,mkdtemp,rmdir,link} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {SaxesParser} from 'saxes';
import {inspectXml,readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseXmlSpans} from './xml-spans.js';
import {parseSetlist} from './setlist.js';

const escapeAttr=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;').replaceAll('\t','&#x9;').replaceAll('\n','&#xA;').replaceAll('\r','&#xD;');
const validName=s=>typeof s==='string'&&!!s.trim()&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(s);

// Creates the single-set version-2 form observed in the app-saved fixture.
export async function createShowSetlistCopy({source,destination,sha256,name,setName,tracks=[]}){
 if(typeof source!=='string'||typeof destination!=='string'||!path.isAbsolute(source)||!path.isAbsolute(destination)||path.resolve(source)===path.resolve(destination)||!source.toLowerCase().endsWith('.skshow')||!destination.toLowerCase().endsWith('.skshow'))throw Error('Source and destination must be different absolute .skshow paths');
 if(typeof name!=='string'||!/^content\/[A-Za-z0-9_-]+\.skls$/i.test(name))throw Error('A safe content/*.skls part name is required');
 if(!validName(setName))throw Error('A valid set name is required');
 if(!Array.isArray(tracks)||tracks.some(t=>!validName(t))||new Set(tracks).size!==tracks.length)throw Error('Track names must be valid and unique');
 const snapshot=await readShowSnapshot({file:source});
 if(snapshot.sha256!==sha256)throw Error('Source changed since inspection');
 if(!snapshot.parts.every(p=>p.valid))throw Error('A part MD5 does not match');
 const names=new Set();for(const part of snapshot.parts){const key=part.name.toLowerCase();if(names.has(key))throw Error('Duplicate part name');names.add(key);}
 if(names.has(name.toLowerCase()))throw Error('Part name already exists');
 if(snapshot.parts.some(p=>p.name.toLowerCase().endsWith('.skls')))throw Error('Show already has a set list');
 const counts=new Map(tracks.map(t=>[t,0]));
 for(const part of snapshot.parts.filter(p=>p.name.toLowerCase().endsWith('.sktl'))){
  const xml=readSnapshotPart({snapshot,name:part.name}).text;let root;const parser=new SaxesParser();parser.on('opentag',tag=>{if(!root)root=tag});parser.write(xml).close();
  if(root?.name==='sktimeline'&&root.attributes.version==='1'&&counts.has(root.attributes.name))counts.set(root.attributes.name,counts.get(root.attributes.name)+1);
 }
 if([...counts.values()].some(n=>n!==1))throw Error('Each track name must identify exactly one timeline in the show');
 const content=`<?xml version="1.0" encoding="UTF-8"?><sksetlist version="2" active="0"><set name="${escapeAttr(setName)}">${tracks.map(t=>`<entry track="${escapeAttr(t)}"/>`).join('')}</set></sksetlist>`;
 if(JSON.stringify(parseSetlist(content))!==JSON.stringify([{name:setName,tracks}]))throw Error('Set list parse validation failed');
 const {xml,sha256:actual}=await inspectXml({file:source});if(actual!==sha256)throw Error('Source changed since inspection');
 const root=parseXmlSpans(xml);if(root.name!=='skshow'||root.selfClosing)throw Error('Unsupported show wrapper');
 const bytes=Buffer.from(content),md5=createHash('md5').update(bytes).digest('hex');
 const part=`<part name="${escapeAttr(name)}" md5="${md5}">${bytes.toString('base64')}</part>`;
 const output=xml.slice(0,root.closeStart)+part+xml.slice(root.closeStart);parseXmlSpans(output);
 const limit=process.env.SHOWKONTROL_OFFLINE_MAX_BYTES??String(128*1024*1024);
 if(!/^\d+$/.test(limit)||!Number.isSafeInteger(Number(limit))||Number(limit)<1)throw Error('Invalid SHOWKONTROL_OFFLINE_MAX_BYTES');
 if(Buffer.byteLength(output)>Number(limit))throw Error('XML output exceeds offline size limit');
 let handle,tempDir,tempFile;
 try{
  tempDir=await mkdtemp(path.join(path.dirname(destination),'.sk-setlist-'));
  tempFile=path.join(tempDir,'show.skshow');
  handle=await open(tempFile,'wx',0o600);await handle.writeFile(output,'utf8');await handle.close();handle=null;
  const result=await readShowSnapshot({file:tempFile});const added=readSnapshotPart({snapshot:result,name});
  if(!result.parts.every(p=>p.valid)||added.text!==content||result.parts.length!==snapshot.parts.length+1)throw Error('Set list roundtrip validation failed');
  for(const old of snapshot.parts){
   const matches=result.parts.filter(p=>p.name===old.name);
   if(matches.length!==1||matches[0].md5!==old.md5||!matches[0].bytes.equals(old.bytes))throw Error('Unrelated part changed');
  }
  if((await inspectXml({file:source})).sha256!==sha256)throw Error('Source changed since inspection');
  await link(tempFile,destination);
 }finally{
  if(handle)await handle.close().catch(()=>{});
  if(tempFile)await unlink(tempFile).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(tempDir)await rmdir(tempDir);
 }
 return {destination,name,md5,setName,tracks,note:'Created an offline set list copy. Validate in ShowKontrol.'};
}
