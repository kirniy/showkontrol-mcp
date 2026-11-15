import {mkdtemp,rm,link,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createProgramCopy,attachShowProgramCopy,editProgramItemGraphSettingCopy,inspectShowProgram} from './program.js';
import {embedProgramTimelineRemappedCopy} from './program-timeline-copy-remap.js';
import {copyProgramItemGraphRemappedCopy} from './program-graph-copy-remap.js';
import {inspectXml,readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {editCueGraphSettingCopy} from './timeline.js';
import {validateShow} from './validate-show.js';
import {cueActiveWarning,programGraphWarnings} from './program-graph-warnings.js';

const checksum=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
function object(value,required,optional=[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))throw Error('Unsupported composition input');
}
function donorInput(d,graph){
 object(d,graph?['donor','donorSha256','donorCueId']:['donor','donorSha256'],graph?['donorName','settings']:['donorName','remapCueIds','settings']);
 if(typeof d.donor!=='string'||!path.isAbsolute(d.donor)||!['.sktl','.skshow'].includes(path.extname(d.donor).toLowerCase())||!checksum(d.donorSha256))throw Error('Invalid donor path or SHA-256');
 if(d.donorName!==undefined&&(typeof d.donorName!=='string'||d.donorName.length>4096))throw Error('Invalid donor name');
 if(graph&&(typeof d.donorCueId!=='string'||!d.donorCueId||d.donorCueId.length>4096))throw Error('Invalid donor cue ID');
 if(!graph&&d.remapCueIds!==undefined&&typeof d.remapCueIds!=='boolean')throw Error('remapCueIds must be a boolean');
}
async function donorHash(d){return path.extname(d.donor).toLowerCase()==='.skshow'?(await readShowSnapshot({file:d.donor})).sha256:(await inspectXml({file:d.donor})).sha256;}
export async function composeProgramScheduleCopy(args){
 object(args,['source','destination','sha256','items'],['replaceExisting']);
 const {source,destination,sha256,items,replaceExisting=false}=args;
 if(typeof source!=='string'||typeof destination!=='string'||![source,destination].every(p=>path.isAbsolute(p)&&path.extname(p).toLowerCase()==='.skshow')||path.resolve(source)===path.resolve(destination)||!checksum(sha256))throw Error('Distinct absolute source and destination .skshow paths and source SHA-256 are required');
 if(typeof replaceExisting!=='boolean'||!Array.isArray(items)||items.length>100)throw Error('Expected at most 100 items and a boolean replaceExisting');
 let settingCount=0;const donors=[];
 for(const item of items){object(item,['start','name','notes'],['timeline','graph']);
  for(const [kind,d] of [['timeline',item.timeline],['graph',item.graph]])if(d!==undefined){donorInput(d,kind==='graph');donors.push(d);const settings=d.settings===undefined?[]:d.settings;if(!Array.isArray(settings))throw Error('Settings must be an array');settingCount+=settings.length;for(const s of settings){object(s,kind==='timeline'?['cueId','nodeId','key','value']:['nodeId','key','value']);if((kind==='timeline'&&(typeof s.cueId!=='string'||!s.cueId||s.cueId.length>4096))||typeof s.nodeId!=='string'||typeof s.key!=='string'||typeof s.value!=='string'||s.nodeId.length>256||s.key.length>256||s.value.length>4096)throw Error('Invalid setting');}}
 }
 if(settingCount>100)throw Error('At most 100 settings are supported');
 const original=await inspectShowProgram({file:source});if(original.sha256!==sha256)throw Error('Source changed since inspection');if(original.present&&!replaceExisting)throw Error('Show already has a Program; set replaceExisting to true');
 for(const d of donors)if(await donorHash(d)!==d.donorSha256)throw Error('Donor changed since inspection');
 const dir=await mkdtemp(path.join(path.dirname(destination),'.showkontrol-compose-'));
 try{
  let step=0;const next=()=>path.join(dir,`${step++}.skpr`);let program=next();let current=await createProgramCopy({destination:program,items:items.map(({start,name,notes})=>({start,name,notes}))});
  const mappings=[],warnings=new Set([current.note]);
  for(const [index,item] of items.entries()){
   const mapping={index};
   if(item.timeline){const {settings=[],...timeline}=item.timeline;let staged=timeline;
    if(settings.length){
     // Check the original donor, including references in its other show parts.
     await embedProgramTimelineRemappedCopy({source:program,destination:next(),sha256:current.sha256,index,...timeline,target:source,targetSha256:sha256});
     let xml;if(path.extname(timeline.donor).toLowerCase()==='.skshow'){const show=await readShowSnapshot({file:timeline.donor});if(show.sha256!==timeline.donorSha256)throw Error('Donor changed since inspection');if(!show.parts.every(p=>p.valid))throw Error('A part MD5 does not match');xml=readSnapshotPart({snapshot:show,name:timeline.donorName}).text;}else{const donor=await inspectXml({file:timeline.donor});if(donor.sha256!==timeline.donorSha256)throw Error('Donor changed since inspection');xml=donor.xml;}
     let file=path.join(dir,`${step++}.sktl`);await writeFile(file,xml,{flag:'wx'});let hash=(await inspectXml({file})).sha256;
     for(const setting of settings){const destination=path.join(dir,`${step++}.sktl`);const result=await editCueGraphSettingCopy({source:file,destination,format:'sktl',sha256:hash,...setting});file=destination;hash=result.sha256;warnings.add(result.note);}
     staged={donor:file,donorSha256:hash,remapCueIds:timeline.remapCueIds};
    }
    const destination=next();const r=await embedProgramTimelineRemappedCopy({source:program,destination,sha256:current.sha256,index,...staged,target:source,targetSha256:sha256});program=destination;current=r;mapping.timeline={nodes:r.mapping,cues:r.cueMapping};r.warnings.forEach(w=>warnings.add(w));}
   if(item.graph){const {settings=[],...graph}=item.graph;const destination=next();const r=await copyProgramItemGraphRemappedCopy({source:program,destination,sha256:current.sha256,index,...graph,target:source,targetSha256:sha256});program=destination;current=r;mapping.graph={nodes:r.mapping};r.warnings.filter(w=>w!==cueActiveWarning).forEach(w=>warnings.add(w));
    for(const s of settings){if(!Object.hasOwn(r.mapping,s.nodeId))throw Error('Setting donor node ID is absent from copied graph');const destination=next();current=await editProgramItemGraphSettingCopy({source:program,destination,sha256:current.sha256,index,nodeId:r.mapping[s.nodeId],key:s.key,value:s.value});program=destination;warnings.add(current.note);}
   }mappings.push(mapping);
  }
  for(const [index,item] of items.entries())if(item.graph)(await programGraphWarnings(program,current.sha256,index)).forEach(w=>warnings.add(w));
  const candidate=path.join(dir,'candidate.skshow');const attached=await attachShowProgramCopy({source,destination:candidate,sha256,program,programSha256:current.sha256,replaceExisting});
  const validation=await validateShow({file:candidate});if(validation.diagnostics.some(d=>d.severity==='error'))throw Error(`Final show validation failed: ${validation.diagnostics.filter(d=>d.severity==='error').map(d=>d.code).join(', ')}`);
  const final=await inspectShowProgram({file:candidate});if(final.sha256!==attached.sha256||final.programSha256!==current.sha256)throw Error('Final show checksum mismatch');
  if((await inspectShowProgram({file:source})).sha256!==sha256)throw Error('Source changed since inspection');for(const d of donors)if(await donorHash(d)!==d.donorSha256)throw Error('Donor changed since inspection');
  await link(candidate,destination);return {destination,sha256:attached.sha256,programSha256:current.sha256,items:final.items,mappings,warnings:[...warnings],validation};
 }finally{await rm(dir,{recursive:true,force:true});}
}
