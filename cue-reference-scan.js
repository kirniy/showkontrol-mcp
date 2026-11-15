import {readShowSnapshot} from './xml-copy.js';
import {parseXmlSpans,selectXmlSpans} from './xml-spans.js';
import {SaxesParser} from 'saxes';

const MAX_NODE_IDS=1000, MAX_RESULTS=500, MAX_IDENTIFIER_LENGTH=1024;


// Match all IDs at each position, including IDs that are prefixes of another ID.
// Text aggregation mirrors hasXmlReference: settings join mixed content, while
// separate sibling fields outside settings have a separator between them.
function findReferences(xml,pattern,idSet){
 const found=new Set(),stack=[],parser=new SaxesParser();
 const scan=value=>{
  for(const match of value.matchAll(pattern)){
   const longest=match[1];
   for(let length=1;length<=longest.length;length++){
    const id=longest.slice(0,length);
    if(idSet.has(id)&&(!value[match.index+length]||!/^[A-Za-z0-9_]$/.test(value[match.index+length])))found.add(id);
   }
  }
 };
 parser.on('opentag',tag=>{
  for(const value of Object.values(tag.attributes))scan(value);
  stack.push({text:'',inSetting:tag.name==='setting'||(stack.at(-1)?.inSetting??false),children:0});
 });
 parser.on('text',text=>{if(stack.length)stack.at(-1).text+=text;});
 parser.on('cdata',text=>{if(stack.length)stack.at(-1).text+=text;});
 parser.on('closetag',()=>{
  const node=stack.pop();scan(node.text);
  if(stack.length){const parent=stack.at(-1);if(parent.children&&!parent.inSetting)parent.text+='\0';parent.text+=node.text;parent.children++;}
 });
 parser.write(xml).close();return found;
}

// This scan identifies literal references only. It cannot prove that a cue is unused.
export async function scanCueReferences({file,name,cueId,sha256}) {
 if(typeof name!=='string'||name.length>MAX_IDENTIFIER_LENGTH||!name.toLowerCase().endsWith('.sktl')||typeof cueId!=='string'||!cueId||cueId.length>MAX_IDENTIFIER_LENGTH)throw Error('Select a timeline and cue ID');
 const snapshot=await readShowSnapshot({file});
 if(sha256!==undefined&&snapshot.sha256!==sha256)throw Error('Source changed since inspection');
 if(snapshot.parts.some(p=>!p.valid))throw Error('A part MD5 does not match');
 if(snapshot.parts.filter(p=>p.name===name).length!==1)throw Error('Part name must match exactly one part');
 if(snapshot.parts.some(p=>p.name.length>MAX_IDENTIFIER_LENGTH))throw Error('Part name exceeds scan limit');
 const decoded=[],diagnostics=[];let diagnosticsTotal=0;
 const diagnostic=(part,reason)=>{diagnosticsTotal++;if(diagnostics.length<MAX_RESULTS)diagnostics.push({part,reason});};
 for(const part of snapshot.parts){
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(part.bytes);}catch{diagnostic(part.name,'Part is not UTF-8 text');continue;}
  try{decoded.push({name:part.name,text,root:parseXmlSpans(text)});}catch{diagnostic(part.name,'Part is not valid supported XML');}
 }
 const target=decoded.find(p=>p.name===name);
 if(!target||target.root.name!=='sktimeline')throw Error('Target timeline is not valid supported XML');
 const matches=selectXmlSpans(target.root,['sktimeline',{name:'cue',attributes:{id:cueId}}]);
 if(matches.length!==1)throw Error('Target cue must occur exactly once');
 // A repeated direct cue ID in any readable timeline makes the target ambiguous.
 let count=0;
 for(const part of decoded)if(part.root.name==='sktimeline')count+=selectXmlSpans(part.root,['sktimeline',{name:'cue',attributes:{id:cueId}}]).length;
 if(count!==1)throw Error('Duplicate direct cue ID');
 const cue=matches[0];
 const nodeIds=[...new Set(cue.children.filter(n=>n.name==='graph').flatMap(g=>g.children.filter(n=>n.name==='node').map(n=>n.attributes.id)).filter(id=>typeof id==='string'&&id.length))];
 if(nodeIds.length>MAX_NODE_IDS)throw Error('Cue graph exceeds node ID scan limit');
 if(nodeIds.some(id=>id.length>MAX_IDENTIFIER_LENGTH))throw Error('Node ID exceeds scan limit');
 const identifiers=[{type:'cue',id:cueId},...nodeIds.map(id=>({type:'node',id}))];
 const idSet=new Set(identifiers.map(item=>item.id));
 const alternatives=[...idSet].sort((a,b)=>b.length-a.length).map(id=>id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
 const pattern=new RegExp(`(?<![A-Za-z0-9_])(?=(${alternatives})(?![A-Za-z0-9_]))`,'g');
 const references=[];let referencesTotal=0;
 for(const part of decoded){
  const text=part===target?part.text.slice(0,cue.start)+part.text.slice(cue.end):part.text;
  const found=findReferences(text,pattern,idSet);
  for(const identifier of identifiers)if(found.has(identifier.id)){
   referencesTotal++;if(references.length<MAX_RESULTS)references.push({part:part.name,type:identifier.type,id:identifier.id});
  }
 }
 return {file,sha256:snapshot.sha256,name,cueId,nodeIds,references,referencesTotal,referencesTruncated:referencesTotal>references.length,diagnostics,diagnosticsTotal,diagnosticsTruncated:diagnosticsTotal>diagnostics.length,complete:false,note:'Literal XML references only; encoded, computed, external and binary references may be missed.'};
}
