import {readShowSnapshot, readSnapshotPart} from './xml-copy.js';
import {parseTimeline} from './timeline.js';
import {storedStoppedWarnings} from './stored-stopped-warnings.js';
import {parseXmlSpans, selectXmlSpans} from './xml-spans.js';
import {maskOpaqueNodeText} from './opaque-node-text.js';
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

// Keep copy-time warnings only while the affected opaque setting remains in the
// final show. Later composition steps can replace settings or remove cues.
export async function survivingOpaqueWarnings(file, sha256, warnings) {
 if (!warnings.length) return [];
 const snapshot = await readShowSnapshot({file});
 if (snapshot.sha256 !== sha256) throw Error('Composed show changed during warning scan');
 const roots = new Map();
 return warnings.filter(w => {
  const {part, cueId, nodeId, key} = w.scope;
  if (!roots.has(part)) roots.set(part, parseXmlSpans(readSnapshotPart({snapshot, name:part}).text));
  const root = roots.get(part);
  const nodes = selectXmlSpans(root, ['sktimeline', {name:'cue', attributes:{id:cueId}}, 'graph', {name:'node', attributes:{id:nodeId}}]);
  if (nodes.length !== 1) return false;
  const xml = readSnapshotPart({snapshot, name:part}).text;
  return maskOpaqueNodeText(xml, nodes[0], true).keys.includes(key);
 });
}
