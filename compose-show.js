import {mkdtemp, link, rm} from 'node:fs/promises';
import path from 'node:path';
import {inspectShow} from './xml-copy.js';
import {createShowTrackCopy, addShowTimelineCueCopy, copyCueGraphInShow, editCueGraphSettingCopy, inspectShowTimeline, editTimelineAudioClipCopy, editTimelineCueCopy} from './timeline.js';
import {addShowSetlistTrackCopy, editShowSetlistCopy, inspectShowSetlist} from './setlist.js';
import {assembleMixedCueGraphShowCopy} from './cue-graph-mixed.js';
import {editTimelineLayerCopy} from './layers.js';
import {copyPatchSettingToCueShowCopy} from './patch-setting-to-cue.js';

// Compose only structures supported by the existing offline writers.
export async function composeShowCopy({source, destination, sha256, templateName, trackName, partName, existingPartName, cues, donor, set, layerOperations, audioClipEdits, cueEdits}) {
 if (!path.isAbsolute(source) || !path.isAbsolute(destination) || path.resolve(source) === path.resolve(destination)) throw Error('Source and destination must be different absolute paths');
 const existing = existingPartName !== undefined;
 if (existing ? typeof existingPartName !== 'string' || !existingPartName || templateName !== undefined || trackName !== undefined || partName !== undefined || set !== undefined : typeof templateName !== 'string' || !templateName || typeof trackName !== 'string' || !trackName || typeof partName !== 'string' || !partName) throw Error('Choose existingPartName alone or templateName, trackName and partName for a new track');
 if (existing) partName = existingPartName;
 if (layerOperations !== undefined && (!Array.isArray(layerOperations) || layerOperations.some(op => !op || !['append', 'rename'].includes(op.operation) || typeof op.layerName !== 'string' || !op.layerName || typeof op.newName !== 'string' || !op.newName.trim()))) throw Error('Layer operations require append or rename, a layer name and a new name');
 if (audioClipEdits !== undefined && (!Array.isArray(audioClipEdits) || audioClipEdits.length > 100)) throw Error('Audio clip edits must be an array of at most 100 entries');
 if (cueEdits !== undefined && (!Array.isArray(cueEdits) || cueEdits.length > 100)) throw Error('Cue edits must be an array of at most 100 entries');
 if (!existing && cueEdits?.length) throw Error('New tracks contain no existing cues to edit');
 if (!Array.isArray(cues) || cues.length < 1 || cues.length > 100) throw Error('Provide between 1 and 100 cues');
 const validDonor = value => value === undefined || value === null || (typeof value === 'object' && path.isAbsolute(value.file || '') && value.sha256 && value.name && value.cueId);
 if (!validDonor(donor) || cues.some(cue => !validDonor(cue?.donor))) throw Error('Donor requires an absolute file path, SHA-256, timeline name and cue ID');
 for (const cue of cues) {
  if (cue?.mixedGraph !== undefined && cue.donor !== undefined) throw Error('A cue cannot specify both a donor and mixed graph');
  if (cue?.settings !== undefined && (!Array.isArray(cue.settings) || cue.settings.some(setting => !setting || typeof setting.key !== 'string' || !setting.key || typeof setting.value !== 'string' || (cue.mixedGraph !== undefined ? !Number.isInteger(setting.nodeIndex) || setting.nodeIndex < 0 || setting.nodeId !== undefined : typeof setting.nodeId !== 'string' || !setting.nodeId || setting.nodeIndex !== undefined)))) throw Error('Cue settings require a graph node reference, key and string value');
  if (cue?.patchSettings !== undefined && (!Array.isArray(cue.patchSettings) || cue.patchSettings.some(setting => !setting || typeof setting.key !== 'string' || !setting.key || typeof setting.template !== 'string' || !path.isAbsolute(setting.template) || !['skf', 'skshow'].includes(setting.templateFormat) || typeof setting.templateSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(setting.templateSha256) || typeof setting.templateNodeId !== 'string' || !setting.templateNodeId || (cue.mixedGraph !== undefined ? !Number.isInteger(setting.nodeIndex) || setting.nodeIndex < 0 || setting.nodeId !== undefined : typeof setting.nodeId !== 'string' || !setting.nodeId || setting.nodeIndex !== undefined)))) throw Error('Cue patch settings require a graph node reference and patch template');
  if ((cue?.settings?.length || cue?.patchSettings?.length) && cue.mixedGraph === undefined && !(cue.donor === undefined ? donor : cue.donor)) throw Error('Cue settings require a donor or mixed graph');
 }
 if (set && (!set.name || !set.setName)) throw Error('Set requires a set list part name and set name');
 if (set?.createIfMissing !== undefined && typeof set.createIfMissing !== 'boolean') throw Error('createIfMissing must be a boolean');
 const initial = await inspectShow({file: source});
 if (initial.sha256 !== sha256) throw Error('Source changed since inspection');
 const dir = await mkdtemp(path.join(path.dirname(destination), '.showkontrol-compose-'));
 let current = source, currentHash = sha256, published = false, result, index = 0;
 const added = [];
 try {
  const step = async fn => {
   const next = path.join(dir, `${index++}.skshow`);
   const value = await fn(next);
   const info = await inspectShow({file: next});
   if (current !== source) await rm(current);
   current = next; currentHash = info.sha256;
   return value;
  };
  if (existing) await inspectShowTimeline({file: current, name: partName});
  else await step(next => createShowTrackCopy({source: current, destination: next, sha256: currentHash, templateName, trackName, partName}));
  for (const operation of layerOperations || []) await step(next => editTimelineLayerCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, operation: operation.operation, layerName: operation.layerName, newName: operation.newName}));
  for (const edit of audioClipEdits || []) await step(next => editTimelineAudioClipCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, audioIndex: edit?.audioIndex, clipIndex: edit?.clipIndex, attributes: edit?.attributes}));
  for (const edit of cueEdits || []) await step(next => editTimelineCueCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, cueId: edit?.cueId, layer: edit?.layer, startMs: edit?.startMs, lengthMs: edit?.lengthMs, label: edit?.label}));
  for (const cue of cues) {
   const {layer, startMs, lengthMs, label} = cue || {};
   const created = await step(next => addShowTimelineCueCopy({source: current, destination: next, sha256: currentHash, name: partName, layer, startMs, lengthMs, label}));
   const item = {id: created.id, layer, startMs, lengthMs, label};
   const selectedDonor = cue?.donor === undefined ? donor : cue.donor;
   if (cue?.mixedGraph !== undefined) {
    const assembled = await step(next => assembleMixedCueGraphShowCopy({...cue.mixedGraph, source: current, destination: next, sha256: currentHash, name: partName, cueId: created.id}));
    item.nodeIds = assembled.nodeIds;
    for (const {nodeIndex, key, value} of cue.settings || []) {
     if (nodeIndex >= assembled.nodeIds.length) throw Error(`Mixed graph has no node at index: ${nodeIndex}`);
     await step(next => editCueGraphSettingCopy({source: current, destination: next, format: 'skshow', sha256: currentHash, name: partName, cueId: created.id, nodeId: assembled.nodeIds[nodeIndex], key, value}));
    }
   } else if (selectedDonor) {
    const copied = await step(next => copyCueGraphInShow({source: current, destination: next, sha256: currentHash, name: partName, sourceName: selectedDonor.name, sourceCueId: selectedDonor.cueId, targetCueId: created.id, template: selectedDonor.file, templateSha256: selectedDonor.sha256}));
    item.idMap = copied.idMap;
    for (const {nodeId, key, value} of cue.settings || []) {
     if (!Object.hasOwn(copied.idMap, nodeId)) throw Error(`Donor graph has no node ID: ${nodeId}`);
     await step(next => editCueGraphSettingCopy({source: current, destination: next, format: 'skshow', sha256: currentHash, name: partName, cueId: created.id, nodeId: copied.idMap[nodeId], key, value}));
    }
   }
   for (const setting of cue.patchSettings || []) {
    let nodeId;
    if (cue.mixedGraph !== undefined) {
     if (setting.nodeIndex >= item.nodeIds.length) throw Error(`Mixed graph has no node at index: ${setting.nodeIndex}`);
     nodeId = item.nodeIds[setting.nodeIndex];
    } else {
     if (!Object.hasOwn(item.idMap, setting.nodeId)) throw Error(`Donor graph has no node ID: ${setting.nodeId}`);
     nodeId = item.idMap[setting.nodeId];
    }
    const {template, templateFormat, templateSha256, templateNodeId, key} = setting;
    await step(next => copyPatchSettingToCueShowCopy({source: current, destination: next, sha256: currentHash, name: partName, cueId: created.id, nodeId, template, templateFormat, templateSha256, templateNodeId, key}));
   }
   added.push(item);
  }
  if (set) {
   if (set.createIfMissing) {
    const {sets} = await inspectShowSetlist({file: current, name: set.name});
    const matches = sets.filter(item => item.name === set.setName);
    if (matches.length > 1) throw Error('Set name must occur exactly once');
    if (matches.length === 0) await step(next => editShowSetlistCopy({source: current, destination: next, sha256: currentHash, name: set.name, operation: 'create_set', newSetName: set.setName}));
   }
   await step(next => addShowSetlistTrackCopy({source: current, destination: next, sha256: currentHash, name: set.name, setName: set.setName, trackName}));
  }
  await link(current, destination); published = true;
  result = {destination, sha256: currentHash, ...(existing ? {existingPartName} : {trackName, partName}), cues: added, ...(set ? {set} : {}), note: 'Offline copy uses fixture-supported structures only. Media authoring and ShowKontrol compatibility are not validated.'};
 } finally {
  try { await rm(dir, {recursive: true, force: true}); }
  catch (error) { if (!published) throw error; result.cleanupWarning = `Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`; }
 }
 return result;
}
