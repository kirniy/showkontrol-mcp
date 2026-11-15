import {writeFile} from 'node:fs/promises';
import path from 'node:path';

function milliseconds(seconds) {
 if (!Number.isFinite(seconds) || seconds < 0 || seconds > 359999.999) throw Error('Time must be between 0 and 359999.999 seconds');
 return Math.round(seconds * 1000);
}
function format(ms) {
 const hours=Math.floor(ms/3600000), minutes=Math.floor(ms/60000)%60, seconds=Math.floor(ms/1000)%60, fraction=ms%1000;
 const tail=`${String(seconds).padStart(2,'0')}.${String(fraction).padStart(3,'0')}`;
 return hours ? `${hours}:${String(minutes).padStart(2,'0')}:${tail}` : `${minutes}:${tail}`;
}
function cell(value) {
 const str=String(value);
 if(/[\r\n\0]/.test(str))throw Error('Names must be a single line without NUL');
 return /[",]/.test(str)?`"${str.replaceAll('"','""')}"`:str;
}
export function renderMarkerCsv({entries}) {
 if(!Array.isArray(entries)||!entries.length)throw Error('At least one marker or region is required');
 let markers=0,regions=0;const rows=['#,Name,Start,End,Length'];
 for(const entry of entries){
  if(!['marker','region'].includes(entry.kind))throw Error('Entry kind must be marker or region');
  if(typeof entry.name!=='string'||!entry.name.trim())throw Error('Entry name is required');
  const start=milliseconds(entry.seconds), title=cell(entry.name);
  if(entry.kind==='marker'){
   if(entry.endSeconds!==undefined)throw Error('Markers cannot have an end time');
   rows.push(`M${++markers},${title},${format(start)},,`);
  }else{
   const end=milliseconds(entry.endSeconds);
   if(end<=start)throw Error('Region end must be after start after rounding to milliseconds');
   rows.push(`R${++regions},${title},${format(start)},${format(end)},${format(end-start)}`);
  }
 }
 return rows.join('\r\n')+'\r\n';
}
export async function writeMarkerCsv({file,entries}) {
 if(typeof file!=='string'||!path.isAbsolute(file)||path.extname(file).toLowerCase()!=='.csv')throw Error('Use an absolute path ending in .csv');
 const csv=renderMarkerCsv({entries});await writeFile(file,csv,{encoding:'utf8',flag:'wx'});
 return {file,entries:entries.length,bytes:Buffer.byteLength(csv),note:'Import this file in the Cue Editor; marker and region import is not verified in the app.'};
}
