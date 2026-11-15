import {SafeCallError} from './staged-live-graph.js';

// The tested action body addresses a node by title.
export async function setNodeBypass({id, bypassed}, call) {
  if (typeof id !== 'string' || !id.trim() || id === '.' || id === '..' || typeof bypassed !== 'boolean') throw Error('A valid node ID and boolean bypassed value are required');
  const list = await call('GET', '/nodes');
  if (!list || typeof list !== 'object' || !Array.isArray(list.nodes) || list.nodes.some(n => !n || typeof n !== 'object' || Array.isArray(n) || typeof n.id !== 'string' || !n.id.trim() || typeof n.title !== 'string' || !n.title.trim())) throw Error('Malformed /nodes response; no write was made');
  const matches = list.nodes.filter(n => n.id === id);
  if (matches.length !== 1) throw Error('Node ID must match exactly one node; no write was made');
  const title = matches[0].title;
  if (list.nodes.filter(n => n.title === title).length !== 1) throw Error('Node title must be unique; no write was made');
  const action = `app.node.bypass_${bypassed ? 'on' : 'off'}`;
  const warning = 'The action targets a title; changes or title matching rules inside ShowKontrol can cause a race or select another node. A matching readback may reflect a preexisting state and does not prove which node the action affected.';
  let response;
  try { response = await call('POST', `/actions/${action}`, {'appact.node':title}); }
  catch (error) { return {status:'write_unknown', id, bypassed, warning, detail:error instanceof SafeCallError ? error.message : 'The write failed or its response could not be read. Its outcome is unknown; no automatic retry.'}; }
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.ok !== true || response.action !== action) return {status:'write_unknown', id, bypassed, warning, detail:'The action response was unsuccessful or malformed; its outcome is unknown; no automatic retry.'};
  let result;
  try { result = await call('GET', `/nodes/${encodeURIComponent(id)}/params/node.bypassed`); }
  catch (error) { return {status:'readback_unknown', id, bypassed, warning, detail:error instanceof SafeCallError ? error.message : 'The write was sent but readback failed; no automatic retry.'}; }
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.key !== 'node.bypassed' || typeof result.value !== 'boolean') return {status:'readback_unknown', id, bypassed, warning, detail:'The write was sent but readback was malformed; no automatic retry.'};
  return {status:result.value === bypassed ? 'matched' : 'mismatch', id, bypassed, observed:result.value, warning};
}
