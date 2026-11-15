import {z} from 'zod';

// The live /actions response contains {actions:[{id, category, label}]}.
export function registerActionSearch(add, call, readOnly) {
 add('showkontrol_search_actions', 'Search the live action catalogue by exact category and text in ID or label, ignoring case. Results retain catalogue order. Page offsets can change when the catalogue changes. Metadata does not define action request bodies.', {
  category:z.string().trim().min(1).max(200).optional().describe('Exact category, ignoring case'),
  text:z.string().trim().min(1).max(200).optional().describe('Substring of action ID or label, ignoring case'),
  offset:z.number().int().min(0).max(1000000).default(0),
  limit:z.number().int().min(1).max(100).default(25)
 }, async ({category,text,offset,limit}) => {
  const data=await call('GET','/actions');
  if (!data || typeof data !== 'object' || !Array.isArray(data.actions)) throw Error('Malformed /actions response: expected actions array');
  const matches=[];
  for (const action of data.actions) {
   if (!action || typeof action !== 'object' || ['id','category','label'].some(key=>typeof action[key] !== 'string' || action[key].length > 4096)) throw Error('Malformed /actions response: invalid action entry');
   if (category && action.category.toLowerCase() !== category.toLowerCase()) continue;
   if (text && ![action.id,action.label].some(value=>value.toLowerCase().includes(text.toLowerCase()))) continue;
   matches.push({id:action.id,category:action.category,label:action.label});
  }
  return {total:matches.length,offset,limit,actions:matches.slice(offset,offset+limit),nextOffset:offset+limit<matches.length?offset+limit:null};
 }, readOnly);
}
