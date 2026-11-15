import {readShowSnapshot,readSnapshotPart} from './xml-copy.js';
import {parseTimeline} from './timeline.js';

const MAX_LISTED=10;
// Timeline tools select a show part by its path (content/Intro.sktl); set-list and rename tools take track
// names. When a call fails on the part name, name the parts that would match instead.
export async function partNameHint(error,args){
 if(!/^(Select a \.sktl part|Part name must match exactly one part)$/.test(error?.message??''))return undefined;
 const file=[args?.file,args?.source].find(value=>typeof value==='string'&&value.toLowerCase().endsWith('.skshow'));
 const name=typeof args?.name==='string'?args.name:undefined;
 if(!file||name===undefined)return undefined;
 let timelines;
 try{
  const snapshot=await readShowSnapshot({file});
  timelines=snapshot.parts.filter(part=>part.valid&&/\.sktl$/i.test(part.name)).map(part=>{
   let track=null;try{track=parseTimeline(readSnapshotPart({snapshot,name:part.name}).text).attributes.name??null;}catch{}
   return {part:part.name,track};
  });
 }catch{return undefined;}
 const exact=timelines.filter(t=>t.part===name).length;
 if(exact>1)return `The show has ${exact} parts named ${JSON.stringify(name)}.`;
 const byTrack=timelines.filter(t=>t.track===name),byCase=timelines.filter(t=>t.part!==name&&t.part.toLowerCase()===name.toLowerCase());
 const quote=list=>list.map(t=>JSON.stringify(t.part)).join(', ');
 if(byTrack.length)return `${JSON.stringify(name)} is the track name of ${quote(byTrack)}; pass the part name.`;
 if(byCase.length)return `Part names are case-sensitive: ${quote(byCase)}.`;
 if(!timelines.length)return 'The show has no valid .sktl parts.';
 return `Timeline parts: ${quote(timelines.slice(0,MAX_LISTED))}${timelines.length>MAX_LISTED?` and ${timelines.length-MAX_LISTED} more`:''}.`;
}
