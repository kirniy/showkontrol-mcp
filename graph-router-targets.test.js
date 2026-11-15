import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {copyCueGraphNodeShowCopy} from './cue-node-copy.js';
import {copyPatchNodeToCueShowCopy} from './patch-node-to-cue.js';
import {assembleCueGraphShowCopy} from './cue-graph-assemble.js';
import {assembleMixedCueGraphShowCopy} from './cue-graph-mixed.js';
import {validateShow} from './validate-show.js';

const hash=(algorithm,text)=>createHash(algorithm).update(text).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;
const action='<node id="n3" type="action"><settings><setting key="action.category">Application</setting><setting key="route.router_target">R1</setting></settings></node>';
const router=name=>`<node id="n1" type="router"><settings><setting key="router.name">${name}</setting></settings></node>`;
const timeline=`<sktimeline version="1" name="A"><layers><layer/></layers><cue id="c1" layer="0" startMs="0" lenMs="10"><graph>${action}</graph></cue><cue id="c2" layer="0" startMs="20" lenMs="10"><graph></graph></cue></sktimeline>`;
const show=routers=>`<skshow>${part('content/A.sktl',timeline)}${part('patch.skf',`<showkontrol version="2"><graph>${routers}</graph><appSettings/></showkontrol>`)}</skshow>`;
const donorPatch=`<showkontrol version="2"><graph>${action.replace('n3','n900')}${router('R1').replace('n1','n901')}</graph><appSettings/></showkontrol>`;

// Every graph writer that copies an action node checks its router target against the destination patch, as copy_cue_graph_show_copy does.
test('node copy and graph assembly refuse router targets the destination patch cannot resolve',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-router-targets-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const template=show(router('R1'));await writeFile(f('template.skshow'),template);await writeFile(f('donor.skf'),donorPatch);
 const node={template:f('template.skshow'),templateSha256:hash('sha256',template),templateName:'content/A.sktl',templateCueId:'c1',nodeId:'n3'};
 const patchNode={template:f('donor.skf'),templateFormat:'skf',templateSha256:hash('sha256',donorPatch),nodeId:'n900'};
 const writers=[
  ['copy_cue_graph_node',(common)=>copyCueGraphNodeShowCopy({...common,cueId:'c2',...node})],
  ['copy_patch_node_to_cue',(common)=>copyPatchNodeToCueShowCopy({...common,cueId:'c2',...patchNode})],
  ['assemble',(common)=>assembleCueGraphShowCopy({...common,cueId:'c2',nodes:[node]})],
  ['assemble_mixed',(common)=>assembleMixedCueGraphShowCopy({...common,cueId:'c2',nodes:[{kind:'cue',...node},{kind:'patch',...patchNode}]})],
 ];
 for(const [routers,expected] of [['',/Router target must match exactly one router name/],[router('R1')+router('R1').replace('n1','n2'),/Router target must match exactly one router name/],[router('Other'),/Router target must match exactly one router name/],[router('R1'),null]]){
  const sourceXml=show(routers),source=f('source.skshow');await writeFile(source,sourceXml);
  for(const [label,write] of writers){
   const destination=f(`${label}.skshow`),common={source,destination,sha256:hash('sha256',sourceXml),name:'content/A.sktl'};
   if(expected){await assert.rejects(write(common),expected,label);assert.ok(!(await readdir(dir)).includes(`${label}.skshow`),label);continue;}
   await write(common);
   const validation=await validateShow({file:destination});
   assert.deepEqual(validation.diagnostics.filter(d=>d.severity==='error'),[],label);
   await rm(destination);
  }
 }
 assert.deepEqual((await readdir(dir)).sort(),['donor.skf','source.skshow','template.skshow']);
});
