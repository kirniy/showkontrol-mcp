import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeProgramEditsCopy} from './program-edit-compose.js';
import {extractShowProgramCopy} from './program.js';
const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-content-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const graph='<graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node></graph>';
 const cueGraph='<graph><node id="n2" type="action"><settings><setting key="x">unchanged</setting></settings></node></graph>';
 const timeline=`<sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old">${cueGraph}</cue></sktimeline>`;
 const program=`<skprogram version="1"><item start="0" name="First" notes=""/><item start="1" name="Second" notes="">${graph}${timeline}</item></skprogram>`;
 const show=`<skshow>${part('content/Program.skpr',program)}</skshow>`;await writeFile(f('in.skshow'),show);
 return {dir,f,show,cueGraph,args:{source:f('in.skshow'),destination:f('out.skshow'),sha256:hash('sha256',show)}};
}
test('applies ordered item, graph and embedded cue edits while preserving graph XML',async t=>{
 const {f,args,cueGraph}=await fixture(t);
 const result=await composeProgramEditsCopy({...args,operations:[{action:'remove',index:0},{action:'edit',index:0,name:'Renamed'},{action:'edit_graph_setting',index:0,nodeId:'n1',key:'trigger.path',value:'new & safe'},{action:'edit_timeline_cue',index:0,cueId:'c1',startMs:42,lengthMs:250},{action:'edit_timeline_cue',index:0,cueId:'c1',label:'Go'}]});
 assert.ok(result.warnings.every(w=>typeof w==='string'&&w.length));assert.equal(new Set(result.warnings).size,result.warnings.length);
 assert.ok(result.warnings.some(w=>w.includes('Cue fields changed')));assert.ok(result.warnings.some(w=>w.includes('IDs were not remapped')));
 assert.equal(result.items[0].name,'Renamed');await extractShowProgramCopy({source:args.destination,destination:f('out.skpr'),sha256:result.sha256});
 const xml=await readFile(f('out.skpr'),'utf8');assert.match(xml,/<setting key="trigger.path">new &amp; safe<\/setting>/);assert.match(xml,/id="c1" layer="0" startMs="42" lenMs="250" label="Go"/);assert.ok(xml.includes(cueGraph));
});
test('missing targets and later failures leave no output or temporary files',async t=>{
 const {args,dir,show}=await fixture(t);
 for(const operation of [{action:'edit_graph_setting',index:1,nodeId:'missing',key:'trigger.path',value:'x'},{action:'edit_timeline_cue',index:1,cueId:'missing',label:'x'},{action:'edit_timeline_cue',index:1,cueId:'c1'}]){
  await assert.rejects(composeProgramEditsCopy({...args,operations:[{action:'edit_graph_setting',index:1,nodeId:'n1',key:'trigger.path',value:'changed'},operation]}));
  await assert.rejects(readFile(args.destination),{code:'ENOENT'});assert.deepEqual(await readdir(dir),['in.skshow']);assert.equal(await readFile(args.source,'utf8'),show);
 }
});
