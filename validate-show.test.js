import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import os from 'node:os';import path from 'node:path';
import {validateShow} from './validate-show.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('show validation reports scoped graph, track and checksum problems',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-validate-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const patch='<showkontrol version="2"><graph><node id="n1"/><connection fromNode="n1" toNode="missing"/></graph><appSettings/></showkontrol>';
 const timeline='<sktimeline version="1" name="Song"><cue id="c1"><graph><node id="n1"/></graph></cue></sktimeline>';
 const setlist='<sksetlist version="2"><set name="Main"><entry track="Song"/><entry track="Absent"/></set></sksetlist>';
 const bad=part('bad.txt','data').replace(/md5="[a-f0-9]{32}"/,'md5="00000000000000000000000000000000"');
 const xml=`<skshow>${part('patch.skf',patch)}${part('one.sktl',timeline)}${part('two.sktl','<sktimeline version="1" name="Song"/>')}${part('set.skls',setlist)}${bad}</skshow>`;
 await writeFile(file,xml);const result=await validateShow({file});
 assert.equal(result.sha256,createHash('sha256').update(xml).digest('hex'));
 assert.deepEqual(result.diagnostics.map(d=>d.code).sort(),['ambiguous_track','duplicate_node_id','invalid_md5','missing_track','unknown_wire_endpoint']);
 assert.deepEqual(result.diagnostics.find(d=>d.code==='duplicate_node_id').scope,{part:'one.sktl',path:'sktimeline/cue/graph',cueId:'c1',nodeId:'n1'});
 assert.equal(result.diagnostics.find(d=>d.code==='unknown_wire_endpoint').scope.nodeId,'missing');
 assert.equal(result.diagnostics.find(d=>d.code==='missing_track').scope.track,'Absent');
});
test('valid show has no diagnostics and malformed parts are reported',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-validate-valid-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const timeline=part('song.sktl','<sktimeline version="1" name="Song"><cue id="c"><graph><node id="n1"/><node id="n2"/><connection fromNode="n1" toNode="n2"/></graph></cue></sktimeline>');
 const list=part('set.skls','<sksetlist version="2"><set name="Set"><entry track="Song"/></set></sksetlist>');
 await writeFile(file,`<skshow>${timeline}${list}</skshow>`);assert.deepEqual((await validateShow({file})).diagnostics,[]);
 await writeFile(file,`<skshow>${part('bad.sktl','<wrong/>')}</skshow>`);assert.equal((await validateShow({file})).diagnostics[0].code,'invalid_native_xml');
});
test('patch schema errors, scene limits and ignored parts have explicit coverage',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-coverage-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const invalidPatch=part('patch.skf','<notshow><graph><node id="n1"/><node id="n1"/></graph></notshow>');
 await writeFile(file,`<skshow>${invalidPatch}${part('scene.sksc','<arbitrary/>')}${part('readme.txt','ignored')}</skshow>`);
 const result=await validateShow({file});
 assert.ok(result.diagnostics.some(d=>d.code==='invalid_patch'&&d.scope.part==='patch.skf'));
 assert.ok(result.diagnostics.some(d=>d.code==='duplicate_node_id'&&d.scope.part==='patch.skf'));
 assert.ok(result.diagnostics.some(d=>d.code==='unverified_scene_schema'&&d.scope.part==='scene.sksc'&&d.severity==='warning'));
 assert.ok(result.diagnostics.some(d=>d.code==='invalid_patch'&&d.severity==='error'));
 assert.deepEqual(result.coverage,[{part:'patch.skf',status:'invalid'},{part:'scene.sksc',status:'partial'},{part:'readme.txt',status:'ignored'}]);
});
