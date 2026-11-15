const validEndpoint = endpoint => endpoint && typeof endpoint === 'object' && !Array.isArray(endpoint) &&
  typeof endpoint.node === 'string' && endpoint.node.length > 0 &&
  typeof endpoint.pin === 'string' && Number.isInteger(endpoint.index) && endpoint.index >= 0;

export async function verifyLiveConnections({connections}, call) {
  const response = await call('GET', '/connections');
  const wires = response && typeof response === 'object' && !Array.isArray(response) && Array.isArray(response.connections) ? response.connections : null;
  const valid = wires?.filter(wire => wire && typeof wire === 'object' && !Array.isArray(wire) && validEndpoint(wire.from) && validEndpoint(wire.to)) ?? [];
  const incomplete = !wires || valid.length !== wires.length;
  const matchesEndpoint = (expected, actual) => expected.node === actual.node &&
    (expected.pin === undefined || (typeof expected.pin === 'number' ? expected.pin === actual.index : expected.pin === actual.pin));
  return {
    complete: !incomplete,
    ...(incomplete ? {reason:'Malformed /connections response or connection endpoint; verification is incomplete.'} : {}),
    results: connections.map(expected => {
      const matching = valid.filter(wire => matchesEndpoint(expected.from, wire.from) && matchesEndpoint(expected.to, wire.to));
      const endpointMetadata = ({node,pin,index}) => ({node,pin,index});
      const matches = matching.slice(0,20).map(({from,to}) => ({from:endpointMetadata(from),to:endpointMetadata(to)}));
      const matchCount = matching.length;
      return {expected, status: incomplete ? 'incomplete' : matchCount === 0 ? 'missing' : matchCount === 1 ? 'present' : 'ambiguous', matchCount, truncated:matchCount > matches.length, matches};
    }),
    note:'Presence does not prove a new connection was created or that a signal executed.'
  };
}
