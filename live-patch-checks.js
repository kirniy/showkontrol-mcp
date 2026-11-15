import {isDeepStrictEqual} from 'node:util';

// PatchRoute returns nodes in request order. Do not attribute results if that
// contract cannot be checked against the returned envelope and IDs.
export function checkLivePatchParameters(nodes, response) {
  const returned = response?.nodes;
  const valid = response?.ok === true && response?.dryRun === false && Array.isArray(returned) && returned.length === nodes.length && returned.every(node => node && typeof node === 'object' && !Array.isArray(node) && typeof node.id === 'string' && node.id.length > 0) && new Set(returned.map(node => node.id)).size === returned.length;
  if (!valid) return {complete:false, reason:'invalid_response_or_node_mapping'};
  let issueCount = 0;
  const issues = [];
  let detailsTruncated = false;
  for (const [index, node] of nodes.entries()) {
    for (const [key, requested] of Object.entries(node.params ?? {})) {
      const matches = Array.isArray(returned[index].params) ? returned[index].params.filter(param => param?.key === key) : null;
      let kind;
      if (!matches || matches.length > 1 || (matches.length === 1 && !Object.hasOwn(matches[0], 'value'))) kind = 'ambiguous';
      else if (!matches.length) kind = 'missing';
      else if (!isDeepStrictEqual(requested, matches[0].value)) kind = 'mismatch';
      if (kind) {
        issueCount++;
        const id = returned[index].id;
        if (issues.length < 100) {
          if (id.length > 200 || key.length > 200) detailsTruncated = true;
          issues.push({nodeIndex:index, returnedId:id.slice(0,200), key:key.slice(0,200), kind});
        }
      }
    }
  }
  return {complete:true, issueCount, issues, truncated:issueCount > issues.length || detailsTruncated};
}
