import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';
const hash=(type,s)=>createHash(type).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
test('opaque patch settings require opt-in and report final Program scopes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-opaque-setting-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const graph=id=>`<graph><node id="${id}" type="processor" kind=""><settings/></node></graph>`;
 const program=`<skprogram version="1"><item start="0" name="First" notes=""/><item start="1" name="A" notes="">${graph('n1')}<sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Cue">${graph('n2')}</cue></sktimeline></item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 const donor='<showkontrol version="2"><graph><node id="n9" type="processor" kind=""><settings><setting key="proc.script">return n123;</setting></settings></node></graph><appSettings/></showkontrol>';
 await Promise.all([writeFile(f('in.skshow'),show),writeFile(f('donor.skf'),donor)]);
 const args={source:f('in.skshow'),sha256:hash('sha256',show)},base={index:1,donor:f('donor.skf'),donorFormat:'skf',donorSha256:hash('sha256',donor),donorNodeId:'n9',key:'proc.script'};
 for(const [action,selector,scope] of [
  ['copy_patch_setting_to_item_graph',{nodeId:'n1'},{part:'content/Program.skpr',itemIndex:1,nodeId:'n1',key:'proc.script'}],
  ['copy_patch_setting_to_timeline_cue',{cueId:'c1',nodeId:'n2'},{part:'content/Program.skpr',itemIndex:1,cueId:'c1',nodeId:'n2',key:'proc.script'}],
 ]){
  const op={action,...base,...selector},destination=f(`${action}.skshow`);
  for(const flag of [undefined,false,'yes']){const operation=flag===undefined?op:{...op,allowOpaqueNodeText:flag};await assert.rejects(compose({...args,destination,operations:[operation]}));await assert.rejects(readFile(destination),{code:'ENOENT'});}
  const result=await compose({...args,destination,operations:[{...op,allowOpaqueNodeText:true}]});
  const warnings=result.warnings.filter(w=>w?.code==='opaque_node_references_unverified');assert.equal(warnings.length,1);assert.deepEqual(warnings[0].scope,scope);
  const shifted=await compose({...args,destination:f(`${action}-shift.skshow`),operations:[{...op,allowOpaqueNodeText:true},{action:'remove',index:0}]});
  assert.equal(shifted.warnings.find(w=>w?.code==='opaque_node_references_unverified').scope.itemIndex,0);
  const removed=await compose({...args,destination:f(`${action}-removed.skshow`),operations:[{...op,allowOpaqueNodeText:true},{action:'remove',index:1,allowContentRemoval:true}]});
  assert.equal(removed.warnings.filter(w=>w?.code==='opaque_node_references_unverified').length,0);
  const safe=donor.replace('return n123;','return true;');await writeFile(f('safe.skf'),safe);
  const overwritten=await compose({...args,destination:f(`${action}-overwritten.skshow`),operations:[{...op,allowOpaqueNodeText:true},{...op,donor:f('safe.skf'),donorSha256:hash('sha256',safe)}]});
  assert.equal(overwritten.warnings.filter(w=>w?.code==='opaque_node_references_unverified').length,0);
  assert.match((await readShowPart({file:destination,name:'content/Program.skpr'})).text,/<setting key="proc.script">return n123;<\/setting>/);
 }
});
test('rejects ambiguous final node IDs before publication',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-opaque-ambiguous-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const node='<graph><node id="n1" type="processor" kind=""><settings><setting key="proc.script">return n123;</setting></settings></node></graph>';
 const program=`<skprogram version="1"><item start="0" name="A" notes="">${node}</item><item start="1" name="B" notes="">${node}</item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 const donor='<showkontrol version="2"><graph><node id="n9" type="processor" kind=""><settings><setting key="proc.script">return n123;</setting></settings></node></graph><appSettings/></showkontrol>';
 await Promise.all([writeFile(f('in.skshow'),show),writeFile(f('donor.skf'),donor)]);
 await assert.rejects(compose({source:f('in.skshow'),destination:f('out.skshow'),sha256:hash('sha256',show),operations:[{action:'copy_patch_setting_to_item_graph',index:0,nodeId:'n1',donor:f('donor.skf'),donorFormat:'skf',donorSha256:hash('sha256',donor),donorNodeId:'n9',key:'proc.script',allowOpaqueNodeText:true}]}),/duplicate_node_id/);
 await assert.rejects(readFile(f('out.skshow')),{code:'ENOENT'});
});
