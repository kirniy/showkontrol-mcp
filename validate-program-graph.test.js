import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {validateShow} from './validate-show.js';

const part=(name,xml)=>`<part name="${name}" md5="${createHash('md5').update(xml).digest('hex')}">${Buffer.from(xml).toString('base64')}</part>`;
const item=content=>`<item start="0" name="A" notes="">${content}</item>`;
test('Program graph reports duplicate IDs and local wire errors with item scope',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-graph-validation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow');
 const program=`<skprogram version="1">${item('<graph><node id="a"/><node id="a"/><node/><connection fromNode="a" fromPin="0" toNode="missing" toPin="bad"/></graph>')}${item('<graph><node id="b"/><connection fromNode="a" fromPin="0" toNode="b" toPin="1"/></graph>')}</skprogram>`;
 const xml=`<skshow>${part('content/Program.skpr',program)}</skshow>`;await writeFile(file,xml);
 const result=await validateShow({file});
 assert.equal(await readFile(file,'utf8'),xml);
 assert.equal(result.coverage[0].status,'partial');
 assert.deepEqual(result.diagnostics.filter(d=>d.code==='duplicate_node_id').map(d=>[d.scope.itemIndex,d.scope.nodeId]),[[0,'a']]);
 assert.equal(result.diagnostics.filter(d=>d.code==='missing_node_id').length,1);
 assert.deepEqual(result.diagnostics.filter(d=>d.code==='unknown_wire_endpoint').map(d=>[d.scope.itemIndex,d.scope.nodeId]),[[0,'missing'],[1,'a']]);
 assert.equal(result.diagnostics.filter(d=>d.code==='invalid_wire_pin').length,1);
 assert.ok(result.diagnostics.some(d=>d.code==='unverified_program_semantics'));
});
test('Program graphs detect IDs shared with other parts and flag nested structures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-graph-cross-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow');
 const program=`<skprogram version="1">${item('<graph><node id="shared"/><extension><node id="hidden"/><connection fromNode="shared" toNode="hidden"/></extension><graph/></graph>')}</skprogram>`;
 const timeline='<sktimeline version="1"><cue id="c"><graph><node id="shared"/></graph></cue></sktimeline>';
 await writeFile(file,`<skshow>${part('content/Program.skpr',program)}${part('song.sktl',timeline)}</skshow>`);
 const result=await validateShow({file});
 assert.equal(result.diagnostics.filter(d=>d.code==='duplicate_node_id').length,1);
 assert.equal(result.diagnostics.filter(d=>d.code==='unsupported_graph_structure').length,3);
 assert.ok(!result.diagnostics.some(d=>d.code==='unknown_wire_endpoint'));
});
test('valid direct Program graph has no structural errors',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-graph-valid-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow');
 const program=`<skprogram version="1">${item('<graph><node id="a"/><node id="b"/><connection fromNode="a" fromPin="0" toNode="b" toPin="1"/></graph>')}</skprogram>`;
 await writeFile(file,`<skshow>${part('content/Program.skpr',program)}</skshow>`);
 const result=await validateShow({file});assert.ok(result.diagnostics.every(d=>d.severity==='warning'));
});
