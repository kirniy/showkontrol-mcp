import {readShowSnapshot, readSnapshotPart} from './xml-copy.js';
import {parseTimeline} from './timeline.js';
import {storedStoppedWarnings} from './stored-stopped-warnings.js';
export {storedStoppedWarnings} from './stored-stopped-warnings.js';


export async function compositionWarnings(file, sha256, parts) {
 const snapshot = await readShowSnapshot({file});
 if (snapshot.sha256 !== sha256) throw Error('Composed show changed during warning scan');
 const warnings = [];
 for (const name of new Set(parts)) {
  const matches = snapshot.parts.filter(part => part.name === name);
  if (matches.length !== 1 || !matches[0].valid) throw Error(`Could not scan composed timeline: ${name}`);
  const xml = readSnapshotPart({snapshot, name}).text;
  if (/<!DOCTYPE/i.test(xml)) throw Error(`Could not scan composed timeline: ${name}`);
  parseTimeline(xml);
  warnings.push(...storedStoppedWarnings(xml, name));
 }
 return warnings;
}
