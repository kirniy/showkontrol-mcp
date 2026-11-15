// Validate typed proposed API parameter values against a captured node-type response.
// This does not interpret serialized XML strings or infer missing schema constraints.
export function validateNodeSettings({schema,values}){
 if(!schema||typeof schema!=='object'||!Array.isArray(schema.params))throw Error('Schema must contain a params array');
 if(!values||typeof values!=='object'||Array.isArray(values))throw Error('Values must be an object keyed by parameter name');
 const diagnostics=[];
 for(const [key,value] of Object.entries(values)){
  const matches=schema.params.filter(param=>param&&param.key===key);
  const add=(status,reason)=>diagnostics.push({key,status,reason});
  if(matches.length!==1){add('unknown',matches.length?'Parameter metadata is ambiguous':'Parameter is absent from the supplied metadata');continue;}
  const param=matches[0];
  if(param.kind==='boolean'){
   add(typeof value==='boolean'?'valid':'invalid','Expected a boolean');
  }else if(param.kind==='text'){
   add(typeof value==='string'?'valid':'invalid','Expected text');
  }else if(param.kind==='integer'||param.kind==='number'){
   const integer=param.kind==='integer',isValid=integer?Number.isSafeInteger:Number.isFinite,label=integer?'Integer':'Number';
   if(('min' in param&&!isValid(param.min))||('max' in param&&!isValid(param.max))||('min' in param&&'max' in param&&param.min>param.max)){add('unknown',`${label} bounds are invalid or unsupported`);continue;}
   if(!isValid(value)){add('invalid',integer?'Expected a safe integer':'Expected a finite number');continue;}
   if(('min' in param&&value<param.min)||('max' in param&&value>param.max)){add('invalid',`Value is outside the supplied ${label.toLowerCase()} bounds`);continue;}
   add('valid',`${label} matches the supplied bounds`);
  }else if(param.kind==='enum'){
   if(!Array.isArray(param.options)||!param.options.length||param.options.some(option=>typeof option!=='string')){add('unknown','Enum options are not available');continue;}
   if(typeof value!=='string'){add('invalid','Expected an enum option string');continue;}
   add(param.options.includes(value)?'valid':'invalid','Value must match a supplied enum option');
  }else add('unknown','Parameter kind is not supported');
 }
 return {request:schema.request??null,diagnostics,note:'Checks only supplied metadata and typed API values. Dynamic dependencies and ShowKontrol acceptance are not validated.'};
}
