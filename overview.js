import {readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parsePatch} from './patch.js';
import {parseTimeline} from './timeline.js';
import {parseSetlist} from './setlist.js';
import {inspectProgramBytes} from './program.js';

// All summaries come from one captured archive; no raw part contents are returned.
export async function inspectShowOverview({file}){
 const snapshot=await readShowSnapshot({file});
 if(!snapshot.parts.every(part=>part.valid))throw Error('A part MD5 does not match');
 const parts=snapshot.parts.map(({name,md5,valid,bytes})=>({name,md5,valid,size:bytes.length}));
 const timelines=[],setlists=[];let patch=null,program;
 const programs=snapshot.parts.filter(part=>part.name.toLowerCase()==='content/program.skpr');
 if(programs.length){
  const names=new Set();for(const part of snapshot.parts){const key=part.name.toLowerCase();if(names.has(key))throw Error('Duplicate part name');names.add(key);}
  if(programs[0].name!=='content/Program.skpr')throw Error('Program part name is not canonical');
  try{
   program=inspectProgramBytes(programs[0].bytes);
   if(program.items.length>1000||Buffer.byteLength(JSON.stringify(program.items))>1024*1024)throw Error('Program overview exceeds output limit');
  }catch(error){throw Error(`Cannot summarize content/Program.skpr: ${error.message}`);}
 }
 for(const part of snapshot.parts){
  const name=part.name;
  if(name!=='patch.skf'&&!/\.(?:sktl|skls)$/i.test(name))continue;
  const text=readSnapshotPart({snapshot,name}).text;
  try{
   if(name==='patch.skf'){
    const parsed=parsePatch(text);
    patch={name:parsed.name,nodes:parsed.nodes.map(({id,type,title,kind})=>({id,type,title,kind})),connectionCount:parsed.connections.length};
   }else if(/\.sktl$/i.test(name)){
    const parsed=parseTimeline(text);
    timelines.push({part:name,name:parsed.attributes.name??'',cueCount:parsed.cueElements.filter(cue=>cue.path==='sktimeline/cue').length,layerCount:parsed.layers.length});
   }else setlists.push({part:name,sets:parseSetlist(text)});
  }catch(error){throw Error(`Cannot summarize ${name}: ${error.message}`);}
 }
 return {file,sha256:snapshot.sha256,parts,timelines,setlists,patch,...(program?{program}: {})};
}
