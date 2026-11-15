import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {inspectPatch,editPatchGraphCopy,copyPatchNode} from './patch.js';

const part=(name,xml)=>`<part name="${name}" md5="${createHash('md5').update(xml).digest('hex')}">${Buffer.from(xml).toString('base64')}</part>`;
const patch='<showkontrol version="2"><graph><node id="n1" type="action"><settings/></node></graph><appSettings/></showkontrol>';

test('patch node creation rejects IDs used in any native show part',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-patch-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skshow'),template=path.join(dir,'template.skf');
 const show=`<skshow>${part('patch.skf',patch)}${part('one.sktl','<sktimeline><cue><graph><node id="n2"/></graph></cue></sktimeline>')}${part('two.SKSC','<scene><node id="n3"/></scene>')}</skshow>`;
 await writeFile(source,show);await writeFile(template,patch);
 const target=await inspectPatch({file:source,format:'skshow'}),donor=await inspectPatch({file:template,format:'skf'});
 const base={source,format:'skshow',sha256:target.sha256,nodeId:'n1'};
 for(const id of ['n2','n3']){
  await assert.rejects(editPatchGraphCopy({...base,destination:path.join(dir,`duplicate-${id}`),operation:'duplicate_node',newNodeId:id}),/unused/);
  await assert.rejects(copyPatchNode({...base,destination:path.join(dir,`copy-${id}`),template,templateFormat:'skf',templateSha256:donor.sha256,newNodeId:id}),/unused/);
 }
 const duplicate=path.join(dir,'duplicate.skshow'),copy=path.join(dir,'copy.skshow');
 await editPatchGraphCopy({...base,destination:duplicate,operation:'duplicate_node',newNodeId:'n4'});
 await copyPatchNode({...base,destination:copy,template,templateFormat:'skf',templateSha256:donor.sha256,newNodeId:'n4'});
 for(const file of [duplicate,copy])assert.deepEqual((await inspectPatch({file,format:'skshow'})).nodes.map(n=>n.id),['n1','n4']);
 assert.equal(await readFile(source,'utf8'),show);
});

test('patch operations select real XML attributes, not lookalike attribute names',async t=>{
 const {editPatchSettingCopy}=await import('./patch.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-attributes-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skf'),donor=path.join(dir,'donor.skf');
 const target='<showkontrol version="2"><graph><node id="n1"><settings><setting key="level">old</setting><setting data-key="level" key="other">untouched</setting></settings></node></graph><appSettings/></showkontrol>';
 const template='<showkontrol version="2"><graph><node id="n&#49;" type="correct"><settings/></node><node data-id="n1" id="n2" type="wrong"><settings/></node></graph><appSettings/></showkontrol>';
 await writeFile(source,target);await writeFile(donor,template);
 const targetInfo=await inspectPatch({file:source,format:'skf'}),donorInfo=await inspectPatch({file:donor,format:'skf'});
 const edited=path.join(dir,'edited.skf');
 await editPatchSettingCopy({source,destination:edited,format:'skf',sha256:targetInfo.sha256,nodeId:'n1',key:'level',value:'new'});
 assert.deepEqual((await inspectPatch({file:edited,format:'skf'})).nodes[0].settings.map(s=>s.value),['new','untouched']);
 const copied=path.join(dir,'copy.skf');
 await copyPatchNode({source,destination:copied,format:'skf',sha256:targetInfo.sha256,template:donor,templateFormat:'skf',templateSha256:donorInfo.sha256,nodeId:'n1',newNodeId:'n3'});
 const result=await inspectPatch({file:copied,format:'skf'});assert.equal(result.nodes.find(n=>n.id==='n3').type,'correct');assert.equal(result.nodes.some(n=>n.id==='n2'),false);
 assert.equal(await readFile(donor,'utf8'),template);assert.equal((await inspectPatch({file:donor,format:'skf'})).nodes.find(n=>n.id==='n2').type,'wrong');
});

test('setting edit targets the real element when a comment contains a lookalike',async t=>{
 const {editPatchSettingCopy}=await import('./patch.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-setting-comment-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.skf'),destination=path.join(dir,'out.skf');
 const fake='<!-- <setting key="level">decoy</setting> -->';
 const original=`<showkontrol version="2"><graph><node id="n1"><settings>${fake}<setting data-key="other" key="level"><![CDATA[old < value]]></setting></settings></node></graph><appSettings/></showkontrol>`;
 await writeFile(source,original);const {sha256}=await inspectPatch({file:source,format:'skf'});
 await editPatchSettingCopy({source,destination,format:'skf',sha256,nodeId:'n1',key:'level',value:'new & value'});
 assert.equal(await readFile(destination,'utf8'),original.replace('<![CDATA[old < value]]>','new &amp; value'));
 assert.equal((await inspectPatch({file:destination,format:'skf'})).nodes[0].settings[0].value,'new & value');
});

test('show snapshots keep the inspected hash and node XML from the same file read',async t=>{
 const {readShowSnapshot,readSnapshotPart}=await import('./xml-copy.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-snapshot-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'donor.skshow'),target=path.join(dir,'target.skf'),out=path.join(dir,'out.skf');
 const old=`<skshow>${part('patch.skf',patch)}</skshow>`;
 const modifiedPatch=patch.replace('type="action"','type="changed"');
 const updated=`<skshow>${part('patch.skf',modifiedPatch)}</skshow>`;
 await writeFile(file,old);await writeFile(target,patch);
 const snapshot=await readShowSnapshot({file}),before=await inspectPatch({file,format:'skshow'}),targetInfo=await inspectPatch({file:target,format:'skf'});
 await writeFile(file,updated);
 assert.equal(snapshot.sha256,createHash('sha256').update(old).digest('hex'));
 assert.equal(readSnapshotPart({snapshot,name:'patch.skf'}).text,patch);
 await assert.rejects(copyPatchNode({source:target,destination:out,format:'skf',sha256:targetInfo.sha256,template:file,templateFormat:'skshow',templateSha256:before.sha256,nodeId:'n1',newNodeId:'n2'}),/Template source changed/);
 await assert.rejects(readFile(out),{code:'ENOENT'});
});

test('node removal checks decoded references in the remaining patch and supported show parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-remove-ref-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source'),destination=path.join(dir,'out');
 const node='<node id="a.b" type="action"><settings><setting key="self">a.b</setting></settings></node>';
 const makePatch=other=>`<showkontrol version="2"><graph>${node}${other}</graph><appSettings/></showkontrol>`;
 const attempt=async (format,xml)=>{await writeFile(source,xml);const {sha256}=await inspectPatch({file:source,format});return editPatchGraphCopy({source,destination,format,sha256,operation:'remove_node',nodeId:'a.b'});};
 for(const reference of ['a&#46;b','a<![CDATA[.]]><!-- split -->b']){
  const xml=makePatch(`<node id="other"><settings><setting key="ref">${reference}</setting></settings></node>`);
  await assert.rejects(attempt('skf',xml),/reference/);await assert.rejects(readFile(destination),{code:'ENOENT'});
 }
 for(const name of ['other.skf','content/track.sktl','content/scene.sksc','sets.skls']){
  const show=`<skshow>${part('patch.skf',makePatch(''))}${part(name,'<root><setting>a<![CDATA[.]]>b</setting></root>')}</skshow>`;
  await assert.rejects(attempt('skshow',show),/reference/);await assert.rejects(readFile(destination),{code:'ENOENT'});
 }
 await attempt('skf',makePatch('<node id="axb"><settings/></node>'));
 assert.deepEqual((await inspectPatch({file:destination,format:'skf'})).nodes.map(n=>n.id),['axb']);
});
