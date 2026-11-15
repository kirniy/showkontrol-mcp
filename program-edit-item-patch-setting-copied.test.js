import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';
const hash=(type,s)=>createHash(type).update(s).digest('hex');
const part=(name,s)=>`<part name="${name}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'item-patch-copied-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const program='<skprogram version="1"><item start="0" name="A" notes=""/><item start="1" name="B" notes=""><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">item.active</setting><setting key="trigger.on">State On</setting></settings></node></graph></item></skprogram>';
 const patch='<showkontrol version="2"><graph><node id="n7" type="router"><settings><setting key="router.name">A</setting></settings></node></graph><appSettings/></showkontrol>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf',patch)}</skshow>`;
 const donor='<showkontrol version="2"><graph><node id="n228" type="action" title="FeedbackNotify"><settings><setting key="action.category">Application</setting><setting key="action.t7">Feedback/Notify</setting><setting key="notify.message">Old</setting><setting key="notify.web">true</setting><setting key="notify.push">false</setting></settings></node><node id="n229" type="action"><settings><setting key="notify.message">New</setting><setting key="notify.title">Added</setting><setting key="route.router_target">A</setting></settings></node><node id="n230" type="action"><settings><setting key="route.router_target">Missing</setting></settings></node></graph><appSettings/></showkontrol>';
 await Promise.all([writeFile(f('in.skshow'),show),writeFile(f('donor.skf'),donor)]);
 const copy={action:'copy_item_graph_node',index:1,donorType:'patch',donor:f('donor.skf'),donorSha256:hash('sha256',donor),donorFormat:'skf',donorNodeId:'n228'};
 const setting={action:'copy_patch_setting_to_item_graph',index:1,nodeFromOperation:0,donor:f('donor.skf'),donorSha256:hash('sha256',donor),donorFormat:'skf',donorNodeId:'n229',key:'notify.message'};
 return {f,show,copy,setting,args:{source:f('in.skshow'),destination:f('out.skshow'),sha256:hash('sha256',show)}};
}
test('copies replaced, missing and valid router settings to a copied node after an item shift',async t=>{
 const f=await fixture(t);const result=await compose({...f.args,operations:[f.copy,{action:'remove',index:0},{...f.setting,index:0},{...f.setting,index:0,key:'notify.title'},{...f.setting,index:0,key:'route.router_target'}]});
 const xml=(await readShowPart({file:f.args.destination,name:'content/Program.skpr'})).text;
 assert.ok(xml.includes(`id="${result.copiedItemNodes[0].nodeId}"`));
 for(const value of ['<setting key="notify.message">New</setting>','<setting key="notify.title">Added</setting>','<setting key="route.router_target">A</setting>'])assert.ok(xml.includes(value),value);
});
test('rejects invalid selectors, receipts, router target and donor hash without output',async t=>{
 const f=await fixture(t);const baseline=await compose({...f.args,operations:[f.copy]});await rm(f.args.destination);
 const remove={action:'remove_item_graph_node',index:1,nodeId:baseline.copiedItemNodes[0].nodeId};
 const replace={action:'assemble_item_graph',index:1,replaceExisting:true,nodes:[{kind:'patch',template:f.copy.donor,templateSha256:f.copy.donorSha256,templateFormat:'skf',nodeId:'n228'}]};
 await compose({...f.args,operations:[f.copy,replace]});await rm(f.args.destination);
 await assert.rejects(compose({...f.args,operations:[f.copy,replace,f.setting]}),/active prior copy_item_graph_node/);
 const cases=[
  [f.copy,{...f.setting,nodeId:'n1'}], [f.copy,{...f.setting,graphFromOperation:0,nodeIndex:0}], [f.copy,{...f.setting,nodeIndex:0}],
  [f.copy,{...f.setting,nodeFromOperation:-1}], [f.copy,{...f.setting,nodeFromOperation:1}],
  [{action:'edit',index:0,name:'x'},f.copy,{...f.setting,nodeFromOperation:0}], [f.copy,{...f.setting,index:0}],
  [f.copy,remove,f.copy,f.setting], [f.copy,replace,f.setting], [f.copy,{...f.setting,donorNodeId:'n230',key:'route.router_target'}], [f.copy,{...f.setting,donorSha256:'0'.repeat(64)}],
  [f.copy,{action:'remove',index:1,allowContentRemoval:true},f.setting],
 ];
 for(const operations of cases){await assert.rejects(compose({...f.args,operations}));await assert.rejects(readFile(f.args.destination),{code:'ENOENT'});}
 assert.equal(await readFile(f.args.source,'utf8'),f.show);
});
