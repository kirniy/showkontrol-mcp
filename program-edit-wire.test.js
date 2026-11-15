import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeProgramEditsCopy as compose} from './program-edit-compose.js';
import {readShowPart} from './xml-copy.js';

const hash=(algorithm,text)=>createHash(algorithm).update(text).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;
const wire=(operation,fromNode='n2',toNode='n3')=>({action:'edit_timeline_graph_wire',index:0,cueId:'c1',operation,fromNode,toNode});
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-wire-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow');
 const other='<graph><node id="n8" type="groupin"/><node id="n9" type="trigger"/><connection fromNode="n8" fromPin="0" toNode="n9" toPin="0"/></graph>';
 const graph='<graph><node id="n1" type="groupin"/><node id="n2" type="trigger"/><node id="n4" type="trigger"/><node id="n3" type="action"/><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/><connection fromNode="n2" fromPin="0" toNode="n3" toPin="0"/></graph>';
 const program=`<skprogram version="1"><item start="0" name="A" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="A">${graph}</cue><cue id="c2" layer="0" startMs="100" lenMs="100" label="B">${other}</cue></sktimeline></item><item start="1" name="B" notes=""/></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}${part('patch.skf','<showkontrol version="2"><appSettings/><graph/></showkontrol>')}</skshow>`;
 await writeFile(source,show);return {dir,source,destination,show,other,args:{source,destination,sha256:hash('sha256',show)}};
}
test('ordered wire removal and addition preserve other graphs and report warnings',async t=>{
 const f=await fixture(t);const result=await compose({...f.args,operations:[wire('remove'),wire('add','n4','n3')]});
 const program=(await readShowPart({file:f.destination,name:'content/Program.skpr'})).text;
 assert.ok(program.includes(f.other));assert.ok(!program.includes('fromNode="n2" fromPin="0" toNode="n3"'));assert.ok(program.includes('fromNode="n4" fromPin="0" toNode="n3"'));
 assert.ok(result.warnings.some(w=>w.includes('fixture-supported pin 0 connection')));assert.equal(await readFile(f.source,'utf8'),f.show);
});
test('wire failures and later failures roll back the complete composition',async t=>{
 for(const [op,pattern,after] of [[wire('add','n4','n3'),/already connected/,[]],[wire('add','n1','n3'),/fixture-supported/,[]],[{...wire('remove'),index:1},/selected current item/,[]],[wire('remove'),/Item index out of range/,[{action:'edit',index:99,name:'bad'}]],[{...wire('remove'),extra:true},/Unsupported edit composition input/,[]],[wire('invalid'),/Operation must be add or remove/,[]]]){
  const f=await fixture(t);await assert.rejects(compose({...f.args,operations:[op,...after]}),pattern);
  await assert.rejects(readFile(f.destination),{code:'ENOENT'});assert.deepEqual(await readdir(f.dir),['in.skshow']);assert.equal(await readFile(f.source,'utf8'),f.show);
 }
});
