import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {composeProgramEditsCopy} from './program-edit-compose.js';
import {extractShowProgramCopy} from './program.js';
import {inspectShow,readShowPart} from './xml-copy.js';

const hash=(algorithm,data)=>createHash(algorithm).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-timeline-graph-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=name=>path.join(dir,name);
 const timeline=`<sktimeline version="1"><layers><layer name="Base"/></layers><cue id="c1" layer="0" startMs="0" lenMs="100" label="Old"><graph><node id="n2" type="trigger" stopped='1'><settings><setting key="node.stopped">true</setting><setting key="trigger.path">old</setting><setting key="other">keep</setting></settings></node></graph></cue></sktimeline>`;
 const program=`<skprogram version="1"><item start="0" name="First" notes=""/><item start="1" name="Second" notes=""><graph><node id="n1" type="action"/></graph>${timeline}</item></skprogram>`;
 const extra='<showkontrol version="2"/>';
 const show=`<skshow>${part('content/Program.skpr',program)}${part('content/other.txt',extra)}</skshow>`;
 await writeFile(f('in.skshow'),show);
 return {dir,f,program,show,extra,args:{source:f('in.skshow'),destination:f('out.skshow'),sha256:hash('sha256',show)}};
}
const edit=(key,value)=>({action:'edit_timeline_graph_setting',index:0,cueId:'c1',nodeId:'n2',key,value});
test('edits settings in the current item and synchronizes stopped state',async t=>{
 const {f,args,program,show,extra}=await fixture(t);
 const result=await composeProgramEditsCopy({...args,operations:[{action:'remove',index:0},edit('trigger.path','new & safe'),edit('node.stopped','false'),{action:'edit_timeline_cue',index:0,cueId:'c1',label:'Go'}]});
 await extractShowProgramCopy({source:args.destination,destination:f('out.skpr'),sha256:result.sha256});
 const expected=program.replace('<item start="0" name="First" notes=""/>','').replace('>old</setting>','>new &amp; safe</setting>').replace("stopped='1'","stopped='0'").replace('>true</setting>','>false</setting>').replace('label="Old"','label="Go"');
 assert.equal(await readFile(f('out.skpr'),'utf8'),expected);
 assert.equal((await readShowPart({file:args.destination,name:'content/other.txt'})).text,extra);
 assert.ok((await inspectShow({file:args.destination})).parts.every(p=>p.valid));
 assert.equal(result.programSha256,hash('sha256',expected));
 assert.ok(result.warnings.some(w=>w.includes('existing cue graph setting')));
 assert.equal(new Set(result.warnings).size,result.warnings.length);
 assert.equal(await readFile(args.source,'utf8'),show);
});
test('invalid targets and settings roll back earlier edits',async t=>{
 const {dir,args,show}=await fixture(t);
 for(const operation of [
  {...edit('trigger.path','x'),cueId:'missing'}, {...edit('trigger.path','x'),nodeId:'missing'}, edit('missing','x'), edit('node.stopped','yes'), {...edit('trigger.path','x'),index:4}, {...edit('trigger.path','x'),extra:true}
 ]){
  await assert.rejects(composeProgramEditsCopy({...args,operations:[{action:'remove',index:0},edit('trigger.path','changed'),operation]}));
  await assert.rejects(readFile(args.destination),{code:'ENOENT'});
  assert.deepEqual(await readdir(dir),['in.skshow']);
  assert.equal(await readFile(args.source,'utf8'),show);
 }
 await assert.rejects(composeProgramEditsCopy({...args,sha256:'0'.repeat(64),operations:[edit('trigger.path','x')]}),/changed/);
 await assert.rejects(readFile(args.destination),{code:'ENOENT'});
});
