import {mkdtemp,rm,link} from 'node:fs/promises';
import path from 'node:path';
import {inspectShow,inspectXml} from './xml-copy.js';
import {validateShow} from './validate-show.js';
import {composeMultiTrackShowCopy} from './compose-multi-show.js';
import {composeProgramScheduleCopy} from './program-compose.js';
import {composeProgramEditsCopy} from './program-edit-compose.js';
import {inspectCueGraph} from './timeline.js';

const checksum=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const digest=async file=>(await inspectXml({file})).sha256;

// Record every external file reference accepted by the two composition APIs.
function collectReferences(value,refs=[]){
 if(Array.isArray(value)){for(const item of value)collectReferences(item,refs);return refs;}
 if(!object(value))return refs;
 for(const [file,hash] of [['file','sha256'],['template','templateSha256'],['donor','donorSha256']]){
  if(typeof value[file]==='string'&&value[hash]!==undefined)refs.push({file:value[file],sha256:value[hash]});
 }
 for(const child of Object.values(value))collectReferences(child,refs);
 return refs;
}
async function checkReferences(refs){for(const ref of refs)if(!checksum(ref.sha256)||await digest(ref.file)!==ref.sha256)throw Error('Donor changed since inspection');}

export async function composeFullShowCopy(args){
 if(!object(args)||Object.keys(args).some(k=>!['source','destination','sha256','tracks','patchOperations','setlistOperations','program'].includes(k)))throw Error('Unsupported composition input');
 const {source,destination,sha256,tracks=[],patchOperations,setlistOperations,program}=args;
 if(typeof source!=='string'||typeof destination!=='string'||![source,destination].every(p=>path.isAbsolute(p)&&path.extname(p).toLowerCase()==='.skshow')||path.resolve(source)===path.resolve(destination)||!checksum(sha256))throw Error('Distinct absolute source and destination .skshow paths and source SHA-256 are required');
 if(!Array.isArray(tracks)||tracks.length>20)throw Error('Expected at most 20 tracks');
 if(patchOperations!==undefined&&(!Array.isArray(patchOperations)||!patchOperations.length||patchOperations.length>100))throw Error('Expected 1 to 100 patch operations');
 if(setlistOperations!==undefined&&(!Array.isArray(setlistOperations)||!setlistOperations.length||setlistOperations.length>100))throw Error('Expected 1 to 100 set list operations');
 if(program!==undefined&&(!object(program)||(Object.hasOwn(program,'operations')
  ? Object.keys(program).some(k=>k!=='operations')||!Array.isArray(program.operations)||program.operations.length>100
  : Object.keys(program).some(k=>!['items','replaceExisting'].includes(k))||!Array.isArray(program.items)||program.items.length>100||(program.replaceExisting!==undefined&&typeof program.replaceExisting!=='boolean'))))throw Error('Invalid Program composition');
 const hasComposition=!!(tracks.length||patchOperations?.length||setlistOperations?.length);
 if(!hasComposition&&program===undefined)throw Error('Composition must make a change');
 const refs=collectReferences({tracks,patchOperations,program});
 if((await inspectShow({file:source})).sha256!==sha256)throw Error('Source changed since inspection');
 await checkReferences(refs);
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-full-'));let published=false,result;
 try{
  let current=source,hash=sha256,multi;
  if(hasComposition){multi=await composeMultiTrackShowCopy({source,destination:path.join(dir,'composed.skshow'),sha256,tracks,patchOperations,setlistOperations});current=path.join(dir,'composed.skshow');hash=multi.sha256;}
  let programResult;
  if(program!==undefined&&Object.hasOwn(program,'operations')){
   programResult=await composeProgramEditsCopy({source:current,destination:path.join(dir,'program.skshow'),sha256:hash,operations:program.operations});current=path.join(dir,'program.skshow');hash=programResult.sha256;
  }else if(program!==undefined){
   const items=[];
   for(const item of program.items){
    if(!object(item))throw Error('Invalid Program item');
    const converted={...item};
    for(const kind of ['timeline','graph']){
     const donor=item[kind];if(!object(donor)||!Object.hasOwn(donor,'stagedShow'))continue;
     const selector=donor.stagedShow;
     if(!object(selector)||Object.keys(selector).some(k=>!['trackIndex','cueIndex','cueId'].includes(k))||!Number.isSafeInteger(selector.trackIndex)||selector.trackIndex<0||selector.trackIndex>=tracks.length||['donor','donorSha256','donorName','donorCueId'].some(k=>Object.hasOwn(donor,k)))throw Error('Invalid or ambiguous staged-show donor selector');
     const track=multi?.tracks[selector.trackIndex];const name=track?.existingPartName??track?.partName;
     let cueId;
     if(kind==='timeline'){if(selector.cueIndex!==undefined||selector.cueId!==undefined)throw Error('Timeline selector cannot specify a cue');}
     else {if((selector.cueIndex===undefined)===(selector.cueId===undefined))throw Error('Graph selector requires exactly one cue reference');
      if(selector.cueIndex!==undefined){if(!Number.isSafeInteger(selector.cueIndex)||selector.cueIndex<0||!track?.cues?.[selector.cueIndex])throw Error('Invalid staged cue index');cueId=track.cues[selector.cueIndex].id;}
      else {if(typeof selector.cueId!=='string'||!selector.cueId||selector.cueId.length>4096)throw Error('Invalid staged cue ID');cueId=selector.cueId;}
     }
     const {stagedShow,...options}=donor;
     if(kind==='timeline'&&options.settings!==undefined){
      if(!Array.isArray(options.settings))throw Error('Settings must be an array');
      const graphs=new Map();
      options.settings=await Promise.all(options.settings.map(async setting=>{
       if(!object(setting))throw Error('Timeline setting requires either cueIndex and nodeIndex or cueId and nodeId');
       const indexed=Object.hasOwn(setting,'cueIndex')&&Object.hasOwn(setting,'nodeIndex');
       const identified=Object.hasOwn(setting,'cueId')&&Object.hasOwn(setting,'nodeId');
       if(indexed===identified||indexed&&(Object.hasOwn(setting,'cueId')||Object.hasOwn(setting,'nodeId'))||identified&&(Object.hasOwn(setting,'cueIndex')||Object.hasOwn(setting,'nodeIndex')))throw Error('Timeline setting requires either cueIndex and nodeIndex or cueId and nodeId');
       if(identified)return setting;
       if(!Number.isSafeInteger(setting.cueIndex)||setting.cueIndex<0||!track?.cues?.[setting.cueIndex])throw Error('Invalid staged timeline cue index');
       if(!Number.isSafeInteger(setting.nodeIndex)||setting.nodeIndex<0)throw Error('Invalid staged timeline node index');
       const resolvedCueId=track.cues[setting.cueIndex].id;
       if(!graphs.has(resolvedCueId))graphs.set(resolvedCueId,inspectCueGraph({file:current,format:'skshow',name,cueId:resolvedCueId}));
       const inspected=await graphs.get(resolvedCueId);if(inspected.sha256!==hash)throw Error('Staged show changed since composition');
       const nodeId=inspected.graph.nodes[setting.nodeIndex]?.id;if(typeof nodeId!=='string'||!nodeId)throw Error('Invalid staged timeline node index');
       const {cueIndex,nodeIndex,...rest}=setting;return {...rest,cueId:resolvedCueId,nodeId};
      }));
     }
     if(kind==='graph'&&options.settings!==undefined){
      if(!Array.isArray(options.settings))throw Error('Settings must be an array');
      let nodes;
      options.settings=await Promise.all(options.settings.map(async setting=>{
       if(!object(setting)||(Object.hasOwn(setting,'nodeIndex')===Object.hasOwn(setting,'nodeId')))throw Error('Graph setting requires exactly one node selector');
       if(!Object.hasOwn(setting,'nodeIndex'))return setting;
       if(!Number.isSafeInteger(setting.nodeIndex)||setting.nodeIndex<0)throw Error('Invalid staged graph node index');
       if(!nodes){const inspected=await inspectCueGraph({file:current,format:'skshow',name,cueId});if(inspected.sha256!==hash)throw Error('Staged show changed since composition');nodes=inspected.graph.nodes;}
       const nodeId=nodes[setting.nodeIndex]?.id;if(typeof nodeId!=='string'||!nodeId)throw Error('Invalid staged graph node index');
       const {nodeIndex,...rest}=setting;return {...rest,nodeId};
      }));
     }
     converted[kind]={...options,donor:current,donorSha256:hash,donorName:name,...(kind==='graph'?{donorCueId:cueId}:{})};
    }
    items.push(converted);
   }
   programResult=await composeProgramScheduleCopy({source:current,destination:path.join(dir,'program.skshow'),sha256:hash,items,replaceExisting:program.replaceExisting});current=path.join(dir,'program.skshow');hash=programResult.sha256;
  }
  const final=await inspectShow({file:current});if(final.sha256!==hash)throw Error('Final show checksum mismatch');if(hash===sha256)throw Error('Composition must make a change');
  const validation=await validateShow({file:current});if(validation.diagnostics.some(d=>d.severity==='error'))throw Error(`Final show validation failed: ${validation.diagnostics.filter(d=>d.severity==='error').map(d=>d.code).join(', ')}`);
  if((await inspectShow({file:source})).sha256!==sha256)throw Error('Source changed since inspection');await checkReferences(refs);
  await link(current,destination);published=true;
  result={destination,sha256:hash,tracks:multi?.tracks??[],setlistOperations:multi?.setlistOperations??[],warnings:multi?.warnings??[],...(multi?.cleanupWarnings?{cleanupWarnings:multi.cleanupWarnings}:{}),...(programResult?{program:{programSha256:programResult.programSha256,items:programResult.items,...(programResult.mappings!==undefined?{mappings:programResult.mappings}:{}),...(programResult.createdCues!==undefined?{createdCues:programResult.createdCues}:{}),...(programResult.copiedCueGraphs!==undefined?{copiedCueGraphs:programResult.copiedCueGraphs}:{}),warnings:programResult.warnings}}:{}),validation:{...validation,file:destination,note:`${validation.note} Validation was performed before publication.`}};
 }finally{try{await rm(dir,{recursive:true,force:true});}catch(error){if(!published)throw error;result.cleanupWarnings=[...(result.cleanupWarnings??[]),`Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`];}}
 return result;
}
