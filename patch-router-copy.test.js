import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {editPatchGraphCopy,editPatchSettingCopy,copyPatchNode} from './patch.js';
import {editPatchBatchCopy} from './batch-patch.js';
import {validateShow} from './validate-show.js';

const hash=(algorithm,text)=>createHash(algorithm).update(text).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;
const router=(id,name)=>`<node id="${id}" type="router" title="${name}"><settings><setting key="router.name">${name}</setting></settings></node>`;
const timeline=target=>`<sktimeline version="1" name="A"><layers><layer/></layers><cue id="c1" layer="0" startMs="0" lenMs="10"><graph><node id="n9" type="action"><settings><setting key="route.router_target">${target}</setting></settings></node></graph></cue></sktimeline>`;
const show=(routers,target='R1')=>`<skshow>${part('content/A.sktl',timeline(target))}${part('patch.skf',`<showkontrol version="2"><graph>\n    ${routers}\n  </graph><appSettings/></showkontrol>`)}</skshow>`;
const ambiguous=/gives router name "R1" to 2 routers while a router target in content\/A\.sktl names it/;

test('copying or renaming a router onto a name a router target uses is refused; a batch may rename the copy',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-router-copy-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const xml=show(router('n1','R1')+router('n2','R2')),source=f('in.skshow');await writeFile(source,xml);
 const donor=`<showkontrol version="2"><graph>${router('n50','R1')}</graph><appSettings/></showkontrol>`;await writeFile(f('donor.skf'),donor);
 const common=name=>({source,destination:f(name),format:'skshow',sha256:hash('sha256',xml)});
 await assert.rejects(editPatchGraphCopy({...common('dup.skshow'),operation:'duplicate_node',nodeId:'n1',newNodeId:'n3'}),ambiguous);
 await assert.rejects(copyPatchNode({...common('copy.skshow'),template:f('donor.skf'),templateFormat:'skf',templateSha256:hash('sha256',donor),nodeId:'n50',newNodeId:'n3'}),ambiguous);
 await assert.rejects(editPatchSettingCopy({...common('rename.skshow'),nodeId:'n2',key:'router.name',value:'R1'}),ambiguous);
 await assert.rejects(editPatchBatchCopy({...common('batch-bad.skshow'),operations:[{kind:'graph',operation:'duplicate_node',nodeId:'n1',newNodeId:'n3'}]}),ambiguous);
 assert.deepEqual((await readdir(dir)).sort(),['donor.skf','in.skshow']);
 // In one batch the copy can be renamed, and only the final patch is checked.
 const batch=await editPatchBatchCopy({...common('batch.skshow'),operations:[{kind:'graph',operation:'duplicate_node',nodeId:'n1',newNodeId:'n3'},{kind:'setting',nodeId:'n3',key:'router.name',value:'R3'}]});
 assert.deepEqual((await validateShow({file:batch.destination})).diagnostics.filter(d=>d.severity==='error'),[]);
 // Copying a router no target names is allowed, and an ambiguity already in the source is not attributed to the edit.
 await editPatchGraphCopy({...common('dup-r2.skshow'),operation:'duplicate_node',nodeId:'n2',newNodeId:'n3'});
 const already=show(router('n1','R1')+router('n2','R1')),alreadyFile=f('already.skshow');await writeFile(alreadyFile,already);
 await editPatchGraphCopy({source:alreadyFile,destination:f('already-out.skshow'),format:'skshow',sha256:hash('sha256',already),operation:'duplicate_node',nodeId:'n1',newNodeId:'n3'});
});
