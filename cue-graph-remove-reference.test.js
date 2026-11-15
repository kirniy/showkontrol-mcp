import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {removeCueGraphCopy} from './timeline.js';

const hash=text=>createHash('sha256').update(text).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
const cue='<cue id="c1"><graph><node id="n7" type="action"/></graph></cue>';
async function fixture(t,format,xml,extra=''){
 const dir=await mkdtemp(path.join(os.tmpdir(),'graph-remove-ref-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in'),destination=path.join(dir,'out'),name='content/a.sktl';
 const text=format==='skshow'?`<skshow>${part(name,xml)}${extra}</skshow>`:xml;
 await writeFile(source,text);return {source,destination,format,sha256:hash(text),name,cueId:'c1',text};
}
async function rejectsWithoutOutput(args,pattern){
 await assert.rejects(removeCueGraphCopy(args),pattern);
 await assert.rejects(access(args.destination),{code:'ENOENT'});
 assert.equal(await readFile(args.source,'utf8'),args.text);
}
test('rejects decoded references in the remaining timeline and Program',async t=>{
 const local=await fixture(t,'sktl',`<sktimeline version="1">${cue}<cue id="other"><setting>n<![CDATA[7]]></setting></cue></sktimeline>`);
 await rejectsWithoutOutput(local,/surviving XML references/);
 const program=await fixture(t,'skshow',`<sktimeline version="1">${cue}</sktimeline>`,part('content/Program.skpr','<program><item ref="n&#55;"/></program>'));
 await rejectsWithoutOutput(program,/surviving XML references/);
});
test('rejects unreadable supported parts and truncated reference results',async t=>{
 const xml=`<sktimeline version="1">${cue}</sktimeline>`;
 const unreadable=await fixture(t,'skshow',xml,part('content/Program.skpr','<program>'));
 await rejectsWithoutOutput(unreadable,/could not be scanned/);
 const many=Array.from({length:501},(_,i)=>part(`content/${i}.skpr`,'<program ref="c1"/>')).join('');
 const truncated=await fixture(t,'skshow',xml,many);
 await rejectsWithoutOutput(truncated,/truncated/);
});
test('removes a clean graph when the retained cue is referenced',async t=>{
 for(const format of ['sktl','skshow']){
  const xml=`<sktimeline version="1">${cue}<cue id="other" ref="c1"/></sktimeline>`;
  const args=await fixture(t,format,xml,format==='skshow'?part('content/Program.skpr','<program ref="c1"/>'):'');
  const result=await removeCueGraphCopy(args);assert.equal(result.removedNodeCount,1);
  const output=await readFile(args.destination,'utf8');assert.ok(output);assert.notEqual(output,args.text);
 }
});
test('rejects nested nodes and graphs before deleting their references',async t=>{
 for(const nested of ['<wrapper><node id="n7"/></wrapper>','<graph><node id="n7"/></graph>']){
  const xml=`<sktimeline version="1"><cue id="c1"><graph>${nested}</graph></cue><cue id="other" ref="n7"/></sktimeline>`;
  const args=await fixture(t,'sktl',xml);
  await rejectsWithoutOutput(args,/Nested graph or node structure/);
 }
});
