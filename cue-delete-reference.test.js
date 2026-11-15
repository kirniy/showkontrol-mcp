import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {deleteTimelineCueCopy} from './timeline.js';

const hash=text=>createHash('sha256').update(text).digest('hex');
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
const cue='<cue id="cue.1"><graph><node id="n7"/></graph></cue>';
async function fixture(t,format,xml,extra=''){
 const dir=await mkdtemp(path.join(os.tmpdir(),'cue-delete-ref-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,`in.${format}`),destination=path.join(dir,'out'),name='content/a.sktl';
 const text=format==='skshow'?`<skshow>${part(name,xml)}${extra}</skshow>`:xml;
 await writeFile(source,text);return {source,destination,format,sha256:hash(text),name,cueId:'cue.1',deleteGraph:true};
}

test('blocks Program and other cue references without creating output',async t=>{
 for(const [xml,extra] of [
  [`<sktimeline version="1">${cue}</sktimeline>`,part('Program.skcp','<program><item ref="cue.1"/></program>')],
  [`<sktimeline version="1">${cue}<cue id="other"><setting>n&#55;</setting></cue></sktimeline>`,'']
 ]){
  const args=await fixture(t,'skshow',xml,extra);
  await assert.rejects(deleteTimelineCueCopy(args),/surviving XML references/);
  await assert.rejects(access(args.destination),{code:'ENOENT'});
 }
});
test('clean show deletion succeeds and duplicate definitions are rejected',async t=>{
 const xml=`<sktimeline version="1">${cue}</sktimeline>`;
 const args=await fixture(t,'skshow',xml,part('Program.skcp','<program/>'));
 const result=await deleteTimelineCueCopy(args);assert.equal(result.deletedGraph,true);
 assert.ok(await readFile(args.destination));
 const duplicate=await fixture(t,'skshow',xml,part('content/b.sktl',xml));
 await assert.rejects(deleteTimelineCueCopy(duplicate),/Duplicate direct cue ID/);
 await assert.rejects(access(duplicate.destination),{code:'ENOENT'});
});
test('rejects an unreadable Program before creating output',async t=>{
 const xml=`<sktimeline version="1">${cue}</sktimeline>`;
 for(const name of ['Program.skpr','Program.skcp']){
  const args=await fixture(t,'skshow',xml,part(name,'<program ref="cue.1">'));
  await assert.rejects(deleteTimelineCueCopy(args),/supported XML part could not be scanned/);
  await assert.rejects(access(args.destination),{code:'ENOENT'});
 }
});
test('standalone deletion blocks local references and explains scan scope',async t=>{
 const args=await fixture(t,'sktl',`<sktimeline version="1">${cue}<cue id="other"><setting><![CDATA[n7]]></setting></cue></sktimeline>`);
 await assert.rejects(deleteTimelineCueCopy(args),/surviving XML references/);
 await assert.rejects(access(args.destination),{code:'ENOENT'});
 const clean=await fixture(t,'sktl',`<sktimeline version="1">${cue}<cue id="other"/></sktimeline>`);
 const result=await deleteTimelineCueCopy(clean);assert.match(result.note,/Other show parts cannot be checked/);
});
