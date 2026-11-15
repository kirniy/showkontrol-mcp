import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {setCueGraphNodeStoppedCopy,editCueGraphSettingCopy,addCueGraphSettingCopy} from './timeline.js';
import {editCueGraphSettingsShowCopy} from './batch-cue-settings.js';
import {copyPatchSettingToCueShowCopy} from './patch-setting-to-cue.js';
import {inspectXml,inspectShow,readShowPart} from './xml-copy.js';

const hash=(algorithm,text)=>createHash(algorithm).update(text).digest('hex');
const timeline=(node)=>`<sktimeline version="1"><cue id="c"><graph>${node}</graph></cue></sktimeline>`;
const node=`<node type="trigger" stopped='1' id="n"><settings><setting key="node.stopped">true</setting><setting key="other">keep</setting></settings></node>`;
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;

test('updates both app-like representations in show and is idempotent in timeline',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-stop-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),original=timeline(node),other='<showkontrol version="2"/>';
 await writeFile(source,`<skshow>${part('content/t.sktl',original)}${part('patch.skf',other)}</skshow>`);
 const sha256=(await inspectShow({file:source})).sha256;
 await setCueGraphNodeStoppedCopy({source,destination,format:'skshow',sha256,name:'content/t.sktl',cueId:'c',nodeId:'n',stopped:false});
 const expected=original.replace("stopped='1'","stopped='0'").replace('>true</setting>','>false</setting>');
 assert.equal((await readShowPart({file:destination,name:'content/t.sktl'})).text,expected);
 assert.equal((await readShowPart({file:destination,name:'patch.skf'})).text,other);
 assert.ok((await inspectShow({file:destination})).parts.every(p=>p.valid));
 const standalone=path.join(dir,'in.sktl'),out=path.join(dir,'out.sktl');await writeFile(standalone,expected);
 await setCueGraphNodeStoppedCopy({source:standalone,destination:out,format:'sktl',sha256:(await inspectXml({file:standalone})).sha256,cueId:'c',nodeId:'n',stopped:false});
 assert.equal(await readFile(out,'utf8'),expected);
});

test('generic and batch edits keep stopped representations together and roll back failures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-stop-generic-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),name='content/t.sktl',original=timeline(node);
 await writeFile(source,`<skshow>${part(name,original)}</skshow>`);const sha256=(await inspectShow({file:source})).sha256;
 const args={source,destination,format:'skshow',sha256,name,cueId:'c',nodeId:'n',key:'node.stopped',value:'false'};
 await editCueGraphSettingCopy(args);
 assert.equal((await readShowPart({file:destination,name})).text,original.replace("stopped='1'","stopped='0'").replace('>true</setting>','>false</setting>'));
 await assert.rejects(editCueGraphSettingCopy(args),/EEXIST/);
 await assert.rejects(editCueGraphSettingCopy({...args,destination:path.join(dir,'stale'),sha256:'0'.repeat(64)}),/changed/);
 const malformed=path.join(dir,'bad.skshow');await assert.rejects(editCueGraphSettingCopy({...args,destination:malformed,value:'0'}),/exactly true or false/);await assert.rejects(readFile(malformed),/ENOENT/);
 const batch=path.join(dir,'batch.skshow'),item={name,cueId:'c',nodeId:'n',key:'node.stopped',value:'false'};
 await editCueGraphSettingsShowCopy({source,destination:batch,sha256,settings:[item]});
 assert.equal((await readShowPart({file:batch,name})).text,(await readShowPart({file:destination,name})).text);
 const failed=path.join(dir,'failed.skshow');await assert.rejects(editCueGraphSettingsShowCopy({source,destination:failed,sha256,settings:[item,{...item,value:'yes'}]}),/exactly true or false/);await assert.rejects(readFile(failed),/ENOENT/);
 await assert.rejects(addCueGraphSettingCopy({...args,destination:path.join(dir,'add')}),/fixture/);
 await assert.rejects(copyPatchSettingToCueShowCopy({key:'node.stopped'}),/stopped-state tool/);
 assert.equal((await readShowPart({file:source,name})).text,original);
});

test('rejects ambiguous or unsupported states without creating output',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-stop-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const [i,bad] of [node.replace('>true</setting>','>yes</setting>'),node.replace('</settings>','<setting key="node.stopped">false</setting></settings>'),'<node id="n"/>'].entries()){
  const source=path.join(dir,`${i}.sktl`),destination=path.join(dir,`${i}-out.sktl`);await writeFile(source,timeline(bad));
  await assert.rejects(setCueGraphNodeStoppedCopy({source,destination,format:'sktl',sha256:(await inspectXml({file:source})).sha256,cueId:'c',nodeId:'n',stopped:true}));
  await assert.rejects(readFile(destination));
 }
});
