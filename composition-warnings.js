import {SaxesParser} from 'saxes';
import {readShowSnapshot, readSnapshotPart} from './xml-copy.js';
import {parseTimeline} from './timeline.js';
import {parseXmlSpans} from './xml-spans.js';

export function storedStoppedWarnings(xml, part, root = parseXmlSpans(xml)) {
 const warnings = [];
 for (const [cueIndex, cue] of root.children.filter(n => n.name === 'cue').entries()) {
  for (const graph of cue.children.filter(n => n.name === 'graph')) for (const node of graph.children.filter(n => n.name === 'node')) {
   const settings = node.children.filter(n => n.name === 'settings').flatMap(n => n.children.filter(s => s.name === 'setting' && s.attributes.key === 'node.stopped'));
   const stoppedSetting = settings.some(setting => {
    if (setting.children.length || Object.keys(setting.attributes).length !== 1) return false;
    let value = ''; const parser = new SaxesParser();
    parser.on('text', v => value += v); parser.on('cdata', v => value += v);
    parser.write(xml.slice(setting.start, setting.end)).close(); return value === 'true';
   });
   if (node.attributes.stopped === '1' || stoppedSetting) warnings.push({code:'stored_stopped_cue_node', severity:'warning', scope:{part, path:'sktimeline/cue/graph', cueIndex, ...(cue.attributes.id ? {cueId:cue.attributes.id} : {}), nodeId:node.attributes.id ?? null}, message:'A cue graph node explicitly stores a stopped value; other stored values may conflict. Its active state and effect on cue execution are not established'});
  }
 }
 return warnings;
}

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
