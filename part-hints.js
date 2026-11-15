import {readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseTimeline} from './timeline.js';

const MAX_LISTED=10;
const MESSAGES=new Set(['Select a .sktl part','Select .sktl parts','Select timeline parts','A .sktl donor part name is required','Part name must match exactly one part']);
// Each part-name argument and the arguments naming the show file it selects from, in order of preference.
const PART_ARGUMENTS=[['name',['file','source']],['sourceName',['template','source']],['templateName',['template']],['donorName',['donor']]];
const isShow=value=>typeof value==='string'&&value.toLowerCase().endsWith('.skshow');

async function timelineParts(file){
 const snapshot=await readShowSnapshot({file});
 return snapshot.parts.filter(part=>part.valid&&/\.sktl$/i.test(part.name)).map(part=>{
  let track=null;try{track=parseTimeline(readSnapshotPart({snapshot,name:part.name}).text).attributes.name??null;}catch{}
  return {part:part.name,track};
 });
}
function hintFor(argument,name,timelines){
 const quote=list=>list.map(t=>JSON.stringify(t.part)).join(', ');
 const exact=timelines.filter(t=>t.part===name).length;
 if(exact===1)return undefined;
 if(exact>1)return `${argument}: the show has ${exact} parts named ${JSON.stringify(name)}.`;
 const byTrack=timelines.filter(t=>t.track===name),byCase=timelines.filter(t=>t.part.toLowerCase()===name.toLowerCase());
 if(byTrack.length)return `${argument}: ${JSON.stringify(name)} is the track name of ${quote(byTrack)}; pass the part name.`;
 if(byCase.length)return `${argument}: part names are case-sensitive: ${quote(byCase)}.`;
 if(!timelines.length)return `${argument}: the show has no valid .sktl parts.`;
 return `${argument}: timeline parts are ${quote(timelines.slice(0,MAX_LISTED))}${timelines.length>MAX_LISTED?` and ${timelines.length-MAX_LISTED} more`:''}.`;
}
// Timeline tools select a show part by its path (content/Intro.sktl); set-list and rename tools take track
// names. When a call fails on a part name, name the parts that would match instead.
export async function partNameHint(error,args){
 if(!MESSAGES.has(error?.message??''))return undefined;
 const hints=[];
 for(const [argument,files] of PART_ARGUMENTS){
  const name=args?.[argument],file=files.map(key=>args?.[key]).find(isShow);
  if(typeof name!=='string'||!file)continue;
  try{const hint=hintFor(argument,name,await timelineParts(file));if(hint)hints.push(hint);}catch{}
 }
 return hints.length?hints.join(' '):undefined;
}
