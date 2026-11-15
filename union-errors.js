// The MCP SDK reports only top-level issue messages, so a value that matches no form of an object union
// is reported as "Invalid input". When exactly one form accepts the supplied keys, report that form's
// issues instead. Other unions keep zod's message.
export function unionFormError(issue){
 if(issue.code!=='invalid_union'||!Array.isArray(issue.errors)||!issue.errors.length)return undefined;
 const fits=issue.errors.filter(branch=>!branch.some(i=>i.code==='unrecognized_keys'&&!i.path?.length));
 if(fits.length!==1||!fits[0].length)return undefined;
 return fits[0].map(i=>i.path?.length?`${i.message} (at ${i.path.join('.')})`:i.message).join('; ');
}
