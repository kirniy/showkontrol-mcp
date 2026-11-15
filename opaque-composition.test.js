import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import os from 'node:os';
import {assembleMixedCueGraphShowCopy} from './cue-graph-mixed.js';import {composeProgramEditsCopy} from './program-edit-compose.js';
const hash=(alg,s)=>createHash(alg).update(s).digest('hex'),part=(n,s)=>`<part name="${n}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
test('opaque text requires opt-in in mixed and Program graph copies',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'opaque-compose-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const script='const n12 = 1;',xml=`<sktimeline version="1"><cue id="src"><graph><node id="n1" type="processor" kind=""><settings><setting key="proc.script">${script}</setting></settings></node></graph></cue></sktimeline>`, donor=`<skshow>${part('track.sktl',xml)}</skshow>`;
 const target=`<skshow>${part('track.sktl','<sktimeline version="1"><cue id="dst"/></sktimeline>')}</skshow>`,program=`<skshow>${part('content/Program.skpr','<skprogram version="1"><item start="0" name="A" notes=""><sktimeline version="1"><cue id="dst"/></sktimeline></item></skprogram>')}</skshow>`;
 await Promise.all([writeFile(f('donor.skshow'),donor),writeFile(f('donor.sktl'),xml),writeFile(f('target.skshow'),target),writeFile(f('program.skshow'),program)]);
 const node={kind:'cue',template:f('donor.skshow'),templateSha256:hash('sha256',donor),templateName:'track.sktl',templateCueId:'src',nodeId:'n1'};
 const mix={source:f('target.skshow'),destination:f('mixed.skshow'),sha256:hash('sha256',target),name:'track.sktl',cueId:'dst',nodes:[node]};
 await assert.rejects(assembleMixedCueGraphShowCopy(mix),/unsupported internal references/);await assert.rejects(readFile(mix.destination),{code:'ENOENT'});
 const mr=await assembleMixedCueGraphShowCopy({...mix,nodes:[{...node,allowOpaqueNodeText:true}]});const mw=mr.warnings.find(w=>w.code==='opaque_node_references_unverified');assert.equal(mw.scope.nodeId,mr.nodeIds[0]);assert.equal(mw.scope.key,'proc.script');assert.ok(!JSON.stringify(mr).includes(script));
 const op={action:'copy_timeline_cue_graph',index:0,cueId:'dst',donor:f('donor.sktl'),donorSha256:hash('sha256',xml),donorCueId:'src'},args={source:f('program.skshow'),destination:f('program-out.skshow'),sha256:hash('sha256',program),operations:[op]};
 await assert.rejects(composeProgramEditsCopy(args),/unsupported internal references/);await assert.rejects(readFile(args.destination),{code:'ENOENT'});
 const pr=await composeProgramEditsCopy({...args,operations:[{...op,allowOpaqueNodeText:true}]});const pw=pr.warnings.find(w=>w.code==='opaque_node_references_unverified');assert.equal(pw.scope.nodeId,pr.copiedCueGraphs[0].idMap.n1);assert.equal(pw.scope.part,'content/Program.skpr');assert.ok(!JSON.stringify(pr).includes(script));
});
