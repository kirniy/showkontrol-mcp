// REAPER text project generator. ShowKontrol imports marker positions from RPP.
// This format does not represent ShowKontrol cue action graphs.
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
function label(s) {
 if (/[\r\n\0"`]/.test(s)) throw Error('Names cannot contain quotes, backticks, line breaks, or NUL');
 return `"${s}"`;
}
export function renderRpp({markers = [], tracks = [], mediaTracks = [], projectName}) {
 if (!Array.isArray(markers) || !Array.isArray(tracks) || !Array.isArray(mediaTracks) || (!markers.length && !tracks.length && !mediaTracks.length)) throw Error('Provide at least one marker or track');
 const names = new Set();
 if (projectName) label(projectName);
 const lines=['<REAPER_PROJECT 0.1 "7.0" 0'];
 for (const [i,m] of markers.entries()) {
  if (!Number.isFinite(m.seconds) || m.seconds < 0) throw Error('Marker seconds must be non-negative and finite');
  if (typeof m.name !== 'string' || !m.name.trim()) throw Error('Marker name is required');
  const name=label(m.name);
  const key=`${m.seconds}\0${m.name}`; if(names.has(key))throw Error('Duplicate marker time and name'); names.add(key);
  lines.push(`  MARKER ${i+1} ${m.seconds} ${name} 0`);
 }
 for (const track of tracks) {
  if (!track.name || !Array.isArray(track.cues) || !track.cues.length) throw Error('Each track needs a name and at least one cue');
  lines.push('  <TRACK', `    NAME ${label(track.name)}`);
  for (const cue of track.cues) {
   if (!Number.isFinite(cue.seconds) || cue.seconds < 0 || !Number.isFinite(cue.duration) || cue.duration <= 0) throw Error('Cue seconds must be non-negative and duration must be positive');
   if (!cue.name || /[\r\n\0]/.test(cue.name)) throw Error('Cue name is required and must be one line');
   label(cue.name);
   lines.push('    <ITEM', `      POSITION ${cue.seconds}`, `      LENGTH ${cue.duration}`, `      NAME ${label(cue.name)}`, '      <NOTES', `        |${cue.name}`, '      >', '    >');
  }
  lines.push('  >');
 }
 for (const track of mediaTracks) {
  if (typeof track.name !== 'string' || !track.name.trim() || !['audio','video'].includes(track.kind) || !Array.isArray(track.items) || !track.items.length) throw Error('Each media track needs a name, kind, and at least one item');
  lines.push('  <TRACK', `    NAME ${label(track.name)}`);
  if (track.nativeColor !== undefined) {
   if (!Number.isInteger(track.nativeColor) || track.nativeColor < 0 || track.nativeColor > 0x1ffffff) throw Error('Track nativeColor must be an integer from 0 to 33554431');
   lines.push(`    PEAKCOL ${track.nativeColor}`);
  }
  for (const item of track.items) {
   if (!Number.isFinite(item.seconds) || item.seconds < 0 || !Number.isFinite(item.duration) || item.duration <= 0) throw Error('Media item seconds must be non-negative and duration must be positive');
   if (typeof item.file !== 'string' || !item.file.trim()) throw Error('Media item file path is required');
   const offset = item.sourceOffset ?? 0, fadeIn = item.fadeIn ?? 0, fadeOut = item.fadeOut ?? 0, volume = item.takeVolume ?? 1;
   if (![offset,fadeIn,fadeOut,volume].every(n=>Number.isFinite(n) && n>=0)) throw Error('Media offset, fade durations and take volume must be non-negative finite numbers');
   if (fadeIn > item.duration || fadeOut > item.duration) throw Error('Fade durations must not exceed item duration');
   const ext = path.extname(item.file).toLowerCase();
   const sourceType=track.kind==='video'?'VIDEO':({'.wav':'WAVE','.wave':'WAVE','.mp3':'MP3','.flac':'FLAC'}[ext]);
   if (!sourceType) throw Error('Audio source must be WAV, MP3, or FLAC');
   const takeName=item.name ?? path.basename(item.file);
   if(typeof takeName!=='string'||!takeName.trim())throw Error('Media item name cannot be empty');
   lines.push('    <ITEM', `      POSITION ${item.seconds}`, `      LENGTH ${item.duration}`, '      LOOP 0', `      FADEIN 0 ${fadeIn} 0 1 0 0`, `      FADEOUT 0 ${fadeOut} 0 1 0 0`, `      NAME ${label(takeName)}`, `      VOLPAN 1 0 ${volume} -1`, `      SOFFS ${offset}`, '      PLAYRATE 1 1 0 -1 0 0.0025', `      <SOURCE ${sourceType}`, `        FILE ${label(item.file)}`, '      >', '    >');
  }
  lines.push('  >');
 }
 lines.push('>',''); return lines.join('\n');
}
export async function writeRpp({file, markers = [], tracks = [], mediaTracks = [], projectName}) {
 if (!path.isAbsolute(file) || path.extname(file).toLowerCase()!=='.rpp') throw Error('Use an absolute path ending in .rpp');
 const text=renderRpp({markers,tracks,mediaTracks,projectName});
 await writeFile(file,text,{encoding:'utf8',flag:'wx'});
 return {file,markers:markers.length,tracks:tracks.length,mediaTracks:mediaTracks.length,bytes:Buffer.byteLength(text),note:'Import this file in the Cue Editor; it does not contain cue action graphs.'};
}
