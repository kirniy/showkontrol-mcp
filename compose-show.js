import {cloneMediaTrackCopy} from './clone-media-track.js';
import {mkdtemp, link, rm} from 'node:fs/promises';
import path from 'node:path';
import {inspectShow} from './xml-copy.js';
import {createShowTrackCopy, addShowTimelineCueCopy, copyCueGraphInShow, editCueGraphSettingCopy, inspectShowTimeline, editTimelineAudioClipCopy, addTimelineAudioLaneCopy, addTimelineAudioClipCopy, removeTimelineAudioClipCopy, removeTimelineAudioLaneCopy, editTimelineCueCopy, deleteTimelineCueCopy, readTrackTemplateDonor} from './timeline.js';
import {addShowSetlistTrackCopy, editShowSetlistCopy, inspectShowSetlist} from './setlist.js';
import {assembleMixedCueGraphShowCopy} from './cue-graph-mixed.js';
import {editTimelineLayerCopy} from './layers.js';
import {copyPatchSettingToCueShowCopy} from './patch-setting-to-cue.js';
import {compositionWarnings, survivingOpaqueWarnings} from './composition-warnings.js';

// Check audio removal selectors against the timeline before the audio stage and order them so earlier removals do not shift later ones.
async function planAudioRemovals({file, name, audioClips, audioClipEdits, audioClipRemovals, audioLaneRemovals}) {
 if (!audioClipRemovals?.length && !audioLaneRemovals?.length) return {clips: [], lanes: []};
 const {audioClips: clips, audio} = await inspectShowTimeline({file, name});
 const counts = audio.map((_, index) => clips.filter(c => c.audioIndex === index).length);
 const lanes = new Set(), removedClips = new Set();
 for (const item of audioLaneRemovals || []) {
  if (item.audioIndex >= audio.length) throw Error(`Audio lane removal selects missing lane ${item.audioIndex}`);
  if (lanes.has(item.audioIndex)) throw Error(`Audio lane ${item.audioIndex} is removed twice`);
  lanes.add(item.audioIndex);
 }
 for (const item of audioClipRemovals || []) {
  const key = `${item.audioIndex}/${item.clipIndex}`;
  if (item.audioIndex >= audio.length || item.clipIndex >= counts[item.audioIndex]) throw Error(`Audio clip removal selects missing clip ${key}`);
  if (lanes.has(item.audioIndex)) throw Error(`Audio clip ${key} is in a removed lane; use removeClips on the lane removal`);
  if (removedClips.has(key)) throw Error(`Audio clip ${key} is removed twice`);
  removedClips.add(key);
 }
 for (const edit of audioClipEdits || []) if (lanes.has(edit?.audioIndex) || removedClips.has(`${edit?.audioIndex}/${edit?.clipIndex}`)) throw Error(`Audio clip ${edit?.audioIndex}/${edit?.clipIndex} is both edited and removed`);
 for (const item of audioClips || []) if (item?.audioIndex !== undefined && lanes.has(item.audioIndex)) throw Error(`Audio clip is added to removed lane ${item.audioIndex}`);
 const byIndex = (a, b) => b.audioIndex - a.audioIndex || (b.clipIndex ?? 0) - (a.clipIndex ?? 0);
 return {clips: (audioClipRemovals || []).map((item, order) => ({...item, order})).sort(byIndex), lanes: (audioLaneRemovals || []).map((item, order) => ({...item, order})).sort(byIndex)};
}

// Compose only structures supported by the existing offline writers.
export async function composeShowCopy({source, destination, sha256, templateName, templateDonor, mediaClone, trackName, partName, existingPartName, cues, donor, set, layerOperations, audioClipEdits, audioLanes, audioClips, audioClipRemovals, audioLaneRemovals, cueRemovals, cueEdits, graphSettingEdits}) {
 if (!path.isAbsolute(source) || !path.isAbsolute(destination) || path.resolve(source) === path.resolve(destination)) throw Error('Source and destination must be different absolute paths');
 const existing = existingPartName !== undefined;
 const cloning = mediaClone !== undefined;
 if (cloning && (!mediaClone || typeof mediaClone !== 'object' || Array.isArray(mediaClone) || Object.keys(mediaClone).some(k => !['templateName','cueMode','allowOpaqueNodeText'].includes(k)) || typeof mediaClone.templateName !== 'string' || !mediaClone.templateName || (mediaClone.cueMode !== undefined && !['copy','remove'].includes(mediaClone.cueMode)) || (mediaClone.allowOpaqueNodeText !== undefined && typeof mediaClone.allowOpaqueNodeText !== 'boolean'))) throw Error('Invalid mediaClone');
 if (existing ? typeof existingPartName !== 'string' || !existingPartName || templateName !== undefined || templateDonor !== undefined || cloning || trackName !== undefined || partName !== undefined || set !== undefined : ([templateName !== undefined, templateDonor !== undefined, cloning].filter(Boolean).length !== 1) || (templateName !== undefined && (typeof templateName !== 'string' || !templateName)) || typeof trackName !== 'string' || !trackName || typeof partName !== 'string' || !partName) throw Error('Choose existingPartName alone or one track template mode with trackName and partName');
 if (existing) partName = existingPartName;
 if (layerOperations !== undefined && (!Array.isArray(layerOperations) || layerOperations.some(op => !op || typeof op !== 'object' || Array.isArray(op) || !['append', 'rename', 'move', 'remove'].includes(op.operation) || typeof op.layerName !== 'string' || !op.layerName || (['append', 'rename'].includes(op.operation) ? typeof op.newName !== 'string' || !op.newName.trim() || op.targetIndex !== undefined : op.newName !== undefined || (op.operation === 'move' ? !Number.isSafeInteger(op.targetIndex) || op.targetIndex < 0 : op.targetIndex !== undefined))))) throw Error('Layer operations require a valid operation, layer name and operation-specific fields');
 if (audioLanes !== undefined && (!Array.isArray(audioLanes) || audioLanes.length > 100)) throw Error('Audio lanes must be an array of at most 100 entries');
 if (audioClips !== undefined && (!Array.isArray(audioClips) || audioClips.length > 100)) throw Error('Audio clips must be an array of at most 100 entries');
 if (audioClipEdits !== undefined && (!Array.isArray(audioClipEdits) || audioClipEdits.length > 100)) throw Error('Audio clip edits must be an array of at most 100 entries');
 if (audioClipRemovals !== undefined && (!Array.isArray(audioClipRemovals) || audioClipRemovals.length > 100 || audioClipRemovals.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['audioIndex', 'clipIndex'].includes(k)) || !Number.isSafeInteger(item.audioIndex) || item.audioIndex < 0 || !Number.isSafeInteger(item.clipIndex) || item.clipIndex < 0))) throw Error('Audio clip removals must be an array of at most 100 {audioIndex, clipIndex} entries');
 if (audioLaneRemovals !== undefined && (!Array.isArray(audioLaneRemovals) || audioLaneRemovals.length > 100 || audioLaneRemovals.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['audioIndex', 'removeClips'].includes(k)) || !Number.isSafeInteger(item.audioIndex) || item.audioIndex < 0 || (item.removeClips !== undefined && typeof item.removeClips !== 'boolean')))) throw Error('Audio lane removals must be an array of at most 100 {audioIndex, removeClips?} entries');
 if (cueRemovals !== undefined && (!Array.isArray(cueRemovals) || cueRemovals.length > 100 || cueRemovals.some(item => !item || typeof item !== 'object' || Array.isArray(item) || ((typeof item.cueId !== 'string' || !item.cueId) && (typeof item.sourceCueId !== 'string' || !item.sourceCueId)) || (item.cueId !== undefined && item.sourceCueId !== undefined) || (item.deleteGraph !== undefined && typeof item.deleteGraph !== 'boolean') || Object.keys(item).some(key => !['cueId', 'sourceCueId', 'deleteGraph'].includes(key))))) throw Error('Cue removals must be an array of at most 100 entries with a cue ID and optional deleteGraph boolean');
 if (!existing && !(cloning && mediaClone.cueMode === 'copy') && cueRemovals?.length) throw Error('New tracks contain no existing cues to remove');
 if (cueEdits !== undefined && (!Array.isArray(cueEdits) || cueEdits.length > 100)) throw Error('Cue edits must be an array of at most 100 entries');
 if (graphSettingEdits !== undefined && (!Array.isArray(graphSettingEdits) || graphSettingEdits.length > 100)) throw Error('Graph setting edits must be an array of at most 100 entries');
 if (!existing && !(cloning && mediaClone.cueMode === 'copy') && graphSettingEdits?.length) throw Error('New tracks contain no existing cue graphs to edit');
 if (!existing && !(cloning && mediaClone.cueMode === 'copy') && cueEdits?.length) throw Error('New tracks contain no existing cues to edit');
 if (cues === undefined) cues = [];
 if (!Array.isArray(cues) || cues.length > 100) throw Error('Provide at most 100 cues');
 if (existing && !cues.length && !layerOperations?.length && !audioClipEdits?.length && !audioLanes?.length && !audioClips?.length && !audioClipRemovals?.length && !audioLaneRemovals?.length && !cueRemovals?.length && !cueEdits?.length && !graphSettingEdits?.length) throw Error('Existing track requires at least one edit or new cue');
 const validDonor = value => value === undefined || value === null || (typeof value === 'object' && path.isAbsolute(value.file || '') && value.sha256 && value.name && value.cueId && (value.allowOpaqueNodeText === undefined || typeof value.allowOpaqueNodeText === 'boolean'));
 if (!validDonor(donor) || cues.some(cue => !validDonor(cue?.donor))) throw Error('Donor requires an absolute file path, SHA-256, timeline name and cue ID');
 for (const cue of cues) {
  if (cue?.mixedGraph !== undefined && cue.donor !== undefined) throw Error('A cue cannot specify both a donor and mixed graph');
  for (const settings of [cue?.settings, cue?.postPatchSettings]) if (settings !== undefined && (!Array.isArray(settings) || settings.some(setting => !setting || typeof setting.key !== 'string' || !setting.key || typeof setting.value !== 'string' || (cue.mixedGraph !== undefined ? !Number.isInteger(setting.nodeIndex) || setting.nodeIndex < 0 || setting.nodeId !== undefined : typeof setting.nodeId !== 'string' || !setting.nodeId || setting.nodeIndex !== undefined)))) throw Error('Cue settings require a graph node reference, key and string value');
  if (cue?.patchSettings !== undefined && (!Array.isArray(cue.patchSettings) || cue.patchSettings.some(setting => !setting || typeof setting.key !== 'string' || !setting.key || typeof setting.template !== 'string' || !path.isAbsolute(setting.template) || !['skf', 'skshow'].includes(setting.templateFormat) || typeof setting.templateSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(setting.templateSha256) || typeof setting.templateNodeId !== 'string' || !setting.templateNodeId || (setting.allowOpaqueNodeText !== undefined && typeof setting.allowOpaqueNodeText !== 'boolean') || (cue.mixedGraph !== undefined ? !Number.isInteger(setting.nodeIndex) || setting.nodeIndex < 0 || setting.nodeId !== undefined : typeof setting.nodeId !== 'string' || !setting.nodeId || setting.nodeIndex !== undefined)))) throw Error('Cue patch settings require a graph node reference and patch template');
  if ((cue?.settings?.length || cue?.patchSettings?.length || cue?.postPatchSettings?.length) && cue.mixedGraph === undefined && !(cue.donor === undefined ? donor : cue.donor)) throw Error('Cue settings require a donor or mixed graph');
 }
 if (set && (!set.name || !set.setName)) throw Error('Set requires a set list part name and set name');
 if (set?.createIfMissing !== undefined && typeof set.createIfMissing !== 'boolean') throw Error('createIfMissing must be a boolean');
 const initial = await inspectShow({file: source});
 if (initial.sha256 !== sha256) throw Error('Source changed since inspection');
 const dir = await mkdtemp(path.join(path.dirname(destination), '.showkontrol-compose-'));
 let current = source, currentHash = sha256, published = false, result, index = 0, cloneReceipt;
 const added = [], opaqueWarnings = [];
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
  else if (cloning) cloneReceipt = await step(next => cloneMediaTrackCopy({source: current, destination: next, sha256: currentHash, ...mediaClone, trackName, partName}));
  else await step(next => createShowTrackCopy({source: current, destination: next, sha256: currentHash, templateName, templateDonor, trackName, partName}));
  if (cloneReceipt) opaqueWarnings.push(...cloneReceipt.warnings);
  for (const operation of layerOperations || []) await step(next => editTimelineLayerCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, operation: operation.operation, layerName: operation.layerName, newName: operation.newName, targetIndex: operation.targetIndex}));
  // Existing-audio selectors refer to the timeline before any audio operation. Added lanes and clips are appended, so they do not shift these indices; removals run last, in descending order.
  const audioPlan = await planAudioRemovals({file: current, name: partName, audioClips, audioClipEdits, audioClipRemovals, audioLaneRemovals});
  const addedAudioLanes = [];
  for (const lane of audioLanes || []) {
   const created = await step(next => addTimelineAudioLaneCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, laneName: lane?.laneName, follow: lane?.follow}));
   addedAudioLanes.push({laneName: created.laneName, audioIndex: created.audioIndex});
  }
  for (const item of audioClips || []) {
   if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['audioIndex','laneName','clip'].includes(k)) || ((item.audioIndex !== undefined) === (item.laneName !== undefined))) throw Error('Audio clip needs exactly one audioIndex or new laneName selector');
   const audioIndex = item.laneName !== undefined ? addedAudioLanes.find(lane => lane.laneName === item.laneName)?.audioIndex : item.audioIndex;
   if (audioIndex === undefined) throw Error('Audio clip laneName must select a lane added in this composition');
   await step(next => addTimelineAudioClipCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, audioIndex, clip: item.clip}));
  }
  const editedAudioClips = [];
  for (const edit of audioClipEdits || []) {
   const edited = await step(next => editTimelineAudioClipCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, audioIndex: edit?.audioIndex, clipIndex: edit?.clipIndex, attributes: edit?.attributes}));
   editedAudioClips.push({audioIndex: edited.audioIndex, clipIndex: edited.clipIndex, attributes: edited.attributes, previous: edited.previous});
  }
  const removedAudioClips = [], removedAudioLanes = [];
  for (const {audioIndex, clipIndex, order} of audioPlan.clips) {
   const removed = await step(next => removeTimelineAudioClipCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, audioIndex, clipIndex}));
   removedAudioClips[order] = {audioIndex, clipIndex, attributes: removed.removed};
  }
  for (const {audioIndex, removeClips, order} of audioPlan.lanes) {
   const removed = await step(next => removeTimelineAudioLaneCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, audioIndex, removeClips}));
   removedAudioLanes[order] = {audioIndex, attributes: removed.removed, clips: removed.removedClips};
  }
  for (const lane of addedAudioLanes) lane.audioIndex -= audioPlan.lanes.filter(r => r.audioIndex < lane.audioIndex).length;
  const resolveId = (item, field, sourceField, mapping) => {
   if (cloning) {
    if (item?.[field] !== undefined || typeof item?.[sourceField] !== 'string' || !Object.hasOwn(mapping || {}, item[sourceField])) throw Error(`Clone requires a valid ${sourceField} selector`);
    return mapping[item[sourceField]];
   }
   if (item?.[sourceField] !== undefined) throw Error(`${sourceField} requires mediaClone`);
   return item?.[field];
  };
  for (const removal of cueRemovals || []) await step(next => deleteTimelineCueCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, cueId: resolveId(removal, 'cueId', 'sourceCueId', cloneReceipt?.cueMapping), deleteGraph: removal.deleteGraph}));
  for (const edit of cueEdits || []) await step(next => editTimelineCueCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, cueId: resolveId(edit, 'cueId', 'sourceCueId', cloneReceipt?.cueMapping), layer: edit?.layer, startMs: edit?.startMs, lengthMs: edit?.lengthMs, label: edit?.label}));
  for (const edit of graphSettingEdits || []) {
   const cueId = resolveId(edit, 'cueId', 'sourceCueId', cloneReceipt?.cueMapping), nodeId = resolveId(edit, 'nodeId', 'sourceNodeId', cloneReceipt?.nodeMapping);
   await step(next => editCueGraphSettingCopy({source: current, destination: next, sha256: currentHash, format: 'skshow', name: partName, cueId, nodeId, key: edit?.key, value: edit?.value}));
  }
  for (const cue of cues) {
   const {layer, startMs, lengthMs, label} = cue || {};
   const created = await step(next => addShowTimelineCueCopy({source: current, destination: next, sha256: currentHash, name: partName, layer, startMs, lengthMs, label}));
   const item = {id: created.id, layer, startMs, lengthMs, label};
   const selectedDonor = cue?.donor === undefined ? donor : cue.donor;
   if (cue?.mixedGraph !== undefined) {
    const assembled = await step(next => assembleMixedCueGraphShowCopy({...cue.mixedGraph, source: current, destination: next, sha256: currentHash, name: partName, cueId: created.id}));
    opaqueWarnings.push(...assembled.warnings.filter(w => w.code === 'opaque_node_references_unverified'));
    item.nodeIds = assembled.nodeIds;
    for (const {nodeIndex, key, value} of cue.settings || []) {
     if (nodeIndex >= assembled.nodeIds.length) throw Error(`Mixed graph has no node at index: ${nodeIndex}`);
     await step(next => editCueGraphSettingCopy({source: current, destination: next, format: 'skshow', sha256: currentHash, name: partName, cueId: created.id, nodeId: assembled.nodeIds[nodeIndex], key, value}));
    }
   } else if (selectedDonor) {
    const copied = await step(next => copyCueGraphInShow({source: current, destination: next, sha256: currentHash, name: partName, sourceName: selectedDonor.name, sourceCueId: selectedDonor.cueId, targetCueId: created.id, template: selectedDonor.file, templateSha256: selectedDonor.sha256, allowOpaqueNodeText: selectedDonor.allowOpaqueNodeText}));
    opaqueWarnings.push(...copied.warnings.filter(w => w.code === 'opaque_node_references_unverified'));
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
    const {template, templateFormat, templateSha256, templateNodeId, key, allowOpaqueNodeText} = setting;
    const copiedSetting = await step(next => copyPatchSettingToCueShowCopy({source: current, destination: next, sha256: currentHash, name: partName, cueId: created.id, nodeId, template, templateFormat, templateSha256, templateNodeId, key, allowOpaqueNodeText}));
    opaqueWarnings.push(...(copiedSetting.warnings || []).filter(w => w.code === 'opaque_node_references_unverified'));
   }
   for (const setting of cue.postPatchSettings || []) {
    let nodeId;
    if (cue.mixedGraph !== undefined) {
     if (setting.nodeIndex >= item.nodeIds.length) throw Error(`Mixed graph has no node at index: ${setting.nodeIndex}`);
     nodeId = item.nodeIds[setting.nodeIndex];
    } else {
     if (!Object.hasOwn(item.idMap, setting.nodeId)) throw Error(`Donor graph has no node ID: ${setting.nodeId}`);
     nodeId = item.idMap[setting.nodeId];
    }
    await step(next => editCueGraphSettingCopy({source: current, destination: next, format: 'skshow', sha256: currentHash, name: partName, cueId: created.id, nodeId, key: setting.key, value: setting.value}));
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
  const warnings = [...await compositionWarnings(current, currentHash, [partName]), ...await survivingOpaqueWarnings(current, currentHash, opaqueWarnings)];
  if (templateDonor !== undefined) await readTrackTemplateDonor(templateDonor);
  await link(current, destination); published = true;
  if (cloneReceipt) { const {warnings: ignored, ...receipt} = cloneReceipt; cloneReceipt = receipt; }
  result = {destination, sha256: currentHash, ...(existing ? {existingPartName} : {trackName, partName}), cues: added, audioLanes: addedAudioLanes, ...(editedAudioClips.length ? {audioClipEdits: editedAudioClips} : {}), ...(removedAudioClips.length || removedAudioLanes.length ? {audioRemovals: {clips: removedAudioClips, lanes: removedAudioLanes}} : {}), ...(cloneReceipt ? {mediaClone: {...cloneReceipt, destination}} : {}), warnings, ...(set ? {set} : {}), note: 'Offline copy uses fixture-supported structures only. Media authoring and ShowKontrol compatibility are not validated.'};
 } finally {
  try { await rm(dir, {recursive: true, force: true}); }
  catch (error) { if (!published) throw error; result.cleanupWarning = `Published copy is valid, but temporary directory cleanup failed: ${dir}: ${error.message}`; }
 }
 return result;
}
