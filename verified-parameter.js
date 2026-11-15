import {isDeepStrictEqual} from 'node:util';

const warning = 'The write and readback are not atomic. Another writer can change the value between requests or after readback. A match may have existed before the write and does not prove the write caused it.';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function setVerifiedParameter({node, key, value}, call) {
  if (typeof node !== 'string' || !/^n[0-9]+$/.test(node)) throw Error('A valid node ID is required');
  for (const part of [node, key]) if (typeof part !== 'string' || !part.trim() || part === '.' || part === '..') throw Error('A valid node ID and parameter key are required');
  const path = `/nodes/${encodeURIComponent(node)}/params/${encodeURIComponent(key)}`;
  let response;
  try { response = await call('PUT', path, {value}); }
  catch { return {status:'write_unknown', warning, detail:'The write failed or its response could not be read. Its outcome is unknown; no automatic retry.'}; }
  if (!object(response) || response.key !== key || !Object.hasOwn(response, 'value') || response.ok === false || response.success === false || response.error != null) return {status:'write_unknown', warning, detail:'The write response was unsuccessful or malformed. Its outcome is unknown; no automatic retry.'};
  let readback;
  try { readback = await call('GET', path); }
  catch { return {status:'readback_unknown', warning, detail:'The write was sent but readback failed; no automatic retry.'}; }
  if (!object(readback) || readback.key !== key || !Object.hasOwn(readback, 'value')) return {status:'readback_unknown', warning, detail:'The write was sent but readback was malformed; no automatic retry.'};
  return {status:isDeepStrictEqual(readback.value,value) ? 'matched' : 'mismatch', warning};
}
