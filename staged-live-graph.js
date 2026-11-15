// Create nodes before connections. A failed write may still have taken effect.
export async function createStagedLiveGraph({nodes, connections}, call) {
  if (!nodes.length && !connections.length) throw Error('nodes and connections cannot both be empty');
  const refs = new Set();
  for (const node of nodes) {
    if (!node.ref.trim() || !node.request.trim() || !node.title.trim()) throw Error('each node needs a nonempty ref, request and title');
    if (refs.has(node.ref)) throw Error(`duplicate ref: ${node.ref}`);
    refs.add(node.ref);
  }
  for (const {from, to} of connections) for (const endpoint of [from, to]) {
    if ('node' in endpoint && !refs.has(endpoint.node)) throw Error(`unknown node ref: ${endpoint.node}`);
  }
  const mapping = Object.create(null);
  const seenIds = new Set();
  const completedNodes = [], completedConnections = [];
  const partial = (stage, index, error) => ({status:'partial', completedNodes, completedConnections, failedStage:{stage, index}, error, outcomeUnknown:'The failed write may have taken effect. Inspect the live nodes and connections before deciding what to do next. No writes were retried or rolled back.'});
  for (const [index, {ref, request, title, params}] of nodes.entries()) {
    let result;
    try { result = await call('POST', '/nodes', {request, title, ...(params !== undefined ? {params} : {}), dryRun:false}); }
    catch { return partial('node', index, 'Node write failed or its response could not be read.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.error || result.success === false || result.ok === false || result.dryRun === true || typeof result.id !== 'string' || !result.id.trim()) return partial('node', index, 'Node write returned an invalid or unsuccessful response.');
    if (seenIds.has(result.id)) return partial('node', index, 'Node write returned an ID already returned for another node.');
    seenIds.add(result.id);
    mapping[ref] = result.id;
    completedNodes.push({ref, id:result.id});
  }
  const translate = endpoint => ({node:'existingNode' in endpoint ? endpoint.existingNode : mapping[endpoint.node], ...(endpoint.pin !== undefined ? {pin:endpoint.pin} : {})});
  for (const [index, {from, to}] of connections.entries()) {
    const connection = {from:translate(from), to:translate(to)};
    let result;
    try { result = await call('POST', '/connections', {...connection, dryRun:false}); }
    catch { return partial('connection', index, 'Connection write failed or its response could not be read.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.error || result.success === false || result.ok !== true || result.dryRun === true) return partial('connection', index, 'Connection write returned an invalid or unsuccessful response.');
    if (result.wire?.from?.node !== connection.from.node || result.wire?.to?.node !== connection.to.node) return partial('connection', index, 'Connection response did not match or identify the requested node IDs.');
    for (const side of ['from', 'to']) {
      const pin = connection[side].pin;
      if (pin !== undefined && result.wire[side][typeof pin === 'number' ? 'index' : 'pin'] !== pin) return partial('connection', index, `Connection response did not match or identify the requested ${side} pin.`);
    }
    completedConnections.push(connection);
  }
  return {status:'complete', completedNodes, completedConnections};
}
