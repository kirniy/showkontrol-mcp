import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {validateShow} from './validate-show.js';

const part=(name,xml)=>`<part name="${name}" md5="${createHash('md5').update(xml).digest('hex')}">${Buffer.from(xml).toString('base64')}</part>`;
const item=body=>`<item start="0" name="A" notes="">${body}</item>`;
const timeline=body=>`<sktimeline version="1" name="Embedded"><layers><layer/></layers>${body}</sktimeline>`;
async function check(t,program,extra=''){
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-timeline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'test.skshow');await writeFile(file,`<skshow>${part('content/Program.skpr',program)}${extra}</skshow>`);return validateShow({file});
}
test('embedded timelines validate cue fields and local graphs with item scopes',async t=>{
 const a=timeline('<cue id="c" layer="1" startMs="-1" lenMs="0"><graph><node id="shared"/><node/><connection fromNode="shared" toNode="missing" fromPin="x" toPin="0"/></graph></cue><wrapper><cue id="nested"/></wrapper>');
 const b=timeline('<cue id="d" layer="0" startMs="0" lenMs="1"><graph><node id="shared"/><connection fromNode="other" toNode="shared" fromPin="0" toPin="1"/></graph></cue>');
 const r=await check(t,`<skprogram version="1">${item(a)}${item(b)}</skprogram>`);
 assert.equal(r.coverage[0].status,'partial');
 assert.deepEqual(r.diagnostics.filter(d=>d.code==='invalid_cue_field').map(d=>d.scope.field),['layer','startMs','lenMs']);
 assert.deepEqual(r.diagnostics.filter(d=>d.code==='unknown_wire_endpoint').map(d=>[d.scope.itemIndex,d.scope.cueId,d.scope.nodeId]),[[0,'c','missing'],[1,'d','other']]);
 assert.equal(r.diagnostics.filter(d=>d.code==='invalid_wire_pin').length,1);
 assert.equal(r.diagnostics.filter(d=>d.code==='missing_node_id').length,1);
 assert.deepEqual(r.diagnostics.filter(d=>d.code==='duplicate_node_id').map(d=>d.scope.itemIndex),[1]);
 assert.ok(r.diagnostics.some(d=>d.code==='unsupported_cue'&&d.scope.itemIndex===0));
});
test('embedded timelines do not satisfy set-list track references',async t=>{
 const program=`<skprogram version="1">${item(timeline('<cue id="c" layer="0" startMs="0" lenMs="1"/>'))}</skprogram>`;
 const r=await check(t,program,part('set.skls','<sksetlist version="2"><set name="S"><entry track="Embedded"/></set></sksetlist>'));
 assert.ok(r.diagnostics.some(d=>d.code==='missing_track'));
});
test('invalid embedded timeline version is scoped and other items remain checked',async t=>{
 const program=`<skprogram version="1">${item('<sktimeline version="2"/>')}${item(timeline('<cue id="x" layer="0" startMs="-1" lenMs="1"/>'))}</skprogram>`;
 const r=await check(t,program);
 assert.ok(r.diagnostics.some(d=>d.code==='invalid_native_xml'&&d.scope.itemIndex===0));
 assert.ok(r.diagnostics.some(d=>d.code==='invalid_cue_field'&&d.scope.itemIndex===1));
});
