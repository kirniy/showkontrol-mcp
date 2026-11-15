// Resolve client-local references through node previews, then validate the patch.
// The injected call function must reject HTTP failures.
export async function buildLiveGraphPlan({nodes, connections}, call) {
  if (!Array.isArray(nodes) || !Array.isArray(connections) || typeof call !== 'function') throw Error('nodes and connections must be arrays and call must be a function');
  const refs = new Set();
  for (const node of nodes) {
    if (!node || typeof node.ref !== 'string' || !node.ref.trim() || typeof node.request !== 'string' || !node.request.trim() || typeof node.title !== 'string' || !node.title.trim()) throw Error('each node needs a nonempty ref, request and title');
    if (refs.has(node.ref)) throw Error(`duplicate ref: ${node.ref}`);
    refs.add(node.ref);
  }
  for (const connection of connections) {
    for (const endpoint of [connection?.from, connection?.to]) {
      if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint) || Object.keys(endpoint).some(key => !['node', 'existingNode', 'pin'].includes(key)) || (Object.hasOwn(endpoint, 'node') === Object.hasOwn(endpoint, 'existingNode'))) throw Error('endpoint must specify exactly one of node or existingNode');
      if (Object.hasOwn(endpoint, 'existingNode')) {
        if (typeof endpoint.existingNode !== 'string' || !endpoint.existingNode.trim()) throw Error('existingNode must be a nonempty ID');
      } else if (!refs.has(endpoint.node)) throw Error(`unknown node ref: ${String(endpoint.node)}`);
    }
  }
  const mapping = Object.create(null);
  const titles = new Set();
  const previews = [];
  const planNodes = [];
  for (const {ref, request, title, params} of nodes) {
    const node = {request, ...(title !== undefined ? {title} : {}), ...(params !== undefined ? {params} : {})};
    const preview = await call('POST', '/nodes', {...node, dryRun:true});
    if (!preview || preview.error || preview.success === false || preview.dryRun !== true || typeof preview.title !== 'string' || !preview.title.trim()) throw Error(`invalid node preview for ref: ${ref}`);
    const finalTitle = preview.title;
    if (titles.has(finalTitle)) throw Error(`duplicate final node title: ${finalTitle}`);
    titles.add(finalTitle);
    mapping[ref] = finalTitle;
    previews.push({ref, title:finalTitle});
    planNodes.push(node);
  }
  const translateEndpoint = endpoint => ({node: Object.hasOwn(endpoint, 'existingNode') ? endpoint.existingNode : mapping[endpoint.node], ...(endpoint.pin !== undefined ? {pin:endpoint.pin} : {})});
  const translated = connections.map(({from, to}) => ({
    from: translateEndpoint(from),
    to: translateEndpoint(to),
  }));
  const validation = await call('PUT', '/patch', {dryRun:true, nodes:planNodes, connections:translated});
  if (validation?.error || validation?.success === false || validation?.ok !== true || validation?.dryRun !== true) throw Error('patch validation failed');
  return {nodes:planNodes, connections:translated, mapping, previews, validation};
}
