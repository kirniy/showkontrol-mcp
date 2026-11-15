import {isDeepStrictEqual} from 'node:util';
import {SafeCallError} from './staged-live-graph.js';

const warning = 'The write and readback are not atomic. Another writer can change the value between requests or after readback. A match may have existed before the write and does not prove the write caused it.';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// A response that reports failure does not establish the value, even when it carries one.
export const reportsFailure = value => value.ok === false || value.ok === 'false' || value.success === false || value.success === 'false' || value.error != null;
// Errors from the API client are already redacted; HTTP errors carry the app's message.
const errorDetail = error => error instanceof SafeCallError || /^HTTP \d{3}: /.test(error?.message ?? '') ? ` ${error.message}` : '';

export async function setVerifiedParameter({node, key, value}, call) {
  if (typeof node !== 'string' || !/^n[0-9]+$/.test(node)) throw Error('A valid node ID is required');
  for (const part of [node, key]) if (typeof part !== 'string' || !part.trim() || part === '.' || part === '..') throw Error('A valid node ID and parameter key are required');
  const path = `/nodes/${encodeURIComponent(node)}/params/${encodeURIComponent(key)}`;
  let response;
  try { response = await call('PUT', path, {value}); }
  catch (error) { return {status:'write_unknown', warning, detail:`The write failed or its response could not be read. Its outcome is unknown; no automatic retry.${errorDetail(error)}`}; }
  if (!object(response) || response.key !== key || !Object.hasOwn(response, 'value') || reportsFailure(response)) return {status:'write_unknown', warning, detail:'The write response was unsuccessful or malformed. Its outcome is unknown; no automatic retry.'};
  let readback;
  try { readback = await call('GET', path); }
  catch (error) { return {status:'readback_unknown', warning, detail:`The write was sent but readback failed; no automatic retry.${errorDetail(error)}`}; }
  if (!object(readback) || readback.key !== key || !Object.hasOwn(readback, 'value') || reportsFailure(readback)) return {status:'readback_unknown', warning, detail:'The write was sent but readback was malformed; no automatic retry.'};
  return {status:isDeepStrictEqual(readback.value,value) ? 'matched' : 'mismatch', warning};
}
