import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {editPatchSettingCopy,inspectPatch} from './patch.js';
import {editPatchBatchCopy} from './batch-patch.js';

const sha=text=>createHash('sha256').update(text).digest('hex');
const patch=node=>`<showkontrol version="2"><graph>${node}<node id="n2" type="trigger"><settings><setting key="node.stopped">true</setting></settings></node></graph><appSettings/></showkontrol>`;
const stopped='<node id="n1" type="processor" kind="" stopped="1"><settings><setting key="node.stopped">true</setting><setting key="proc.script">return 1;</setting></settings></node>';

// The cue-graph tools change a stored stopped attribute with node.stopped; the patch setting tools now do the same.
test('patch node.stopped edits keep an existing stopped attribute in step, and inspection shows it',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-patch-stopped-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const xml=patch(stopped);await writeFile(f('in.skf'),xml);
 const common=name=>({source:f('in.skf'),destination:f(name),format:'skf',sha256:sha(xml),nodeId:'n1',key:'node.stopped'});
 assert.equal((await inspectPatch({file:f('in.skf'),format:'skf'})).nodes[0].stopped,'1');
 const single=await editPatchSettingCopy({...common('off.skf'),value:'false'});
 assert.equal(single.stoppedAttribute,'0');
 assert.equal(await readFile(f('off.skf'),'utf8'),xml.replace('stopped="1"','stopped="0"').replace('<setting key="node.stopped">true</setting><setting key="proc.script">','<setting key="node.stopped">false</setting><setting key="proc.script">'));
 const batch=await editPatchBatchCopy({...common('batch.skf'),operations:[{kind:'setting',nodeId:'n1',key:'node.stopped',value:'false'}]});
 assert.equal(await readFile(batch.destination,'utf8'),await readFile(f('off.skf'),'utf8'));
 // A node without the attribute changes only the setting, and the attribute stays absent.
 const plain=await editPatchSettingCopy({...common('n2.skf'),nodeId:'n2',value:'false'});
 assert.equal(plain.stoppedAttribute,undefined);assert.equal((await inspectPatch({file:f('n2.skf'),format:'skf'})).nodes[1].stopped,undefined);
 await assert.rejects(editPatchSettingCopy({...common('bad.skf'),value:'0'}),/node\.stopped value must be exactly true or false/);
 for(const [label,node] of [['value',stopped.replace('stopped="1"','stopped="yes"')],['serialization',stopped.replace('stopped="1"','stopped="1" x="a stopped=\'1\'"')]]){
  const other=patch(node),file=f(`${label}.skf`);await writeFile(file,other);
  await assert.rejects(editPatchSettingCopy({source:file,destination:f(`${label}-out.skf`),format:'skf',sha256:sha(other),nodeId:'n1',key:'node.stopped',value:'false'}),/Unsupported stopped attribute/,label);
 }
});
