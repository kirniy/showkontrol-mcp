import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {inspectPatch,editPatchGraphCopy} from './patch.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
const router=(id,name)=>`<node id="${id}" type="router"><settings><setting key="router.name">${name}</setting></settings></node>`;
const target=value=>`<node id="n9" type="action"><settings><setting key="route.router_target">${value}</setting></settings></node>`;
test('router removal protects target references in patch and supported show parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'router-remove-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const [i,value,local,duplicate,blocked] of [[0,'A',false,false,true],[1,'&#65;',false,false,true],[2,' <![CDATA[A]]> ',true,false,true],[3,'B',false,false,false],[4,'A',false,true,true]]){
  const patch=`<showkontrol version="2"><graph>${router('n1','A')}${duplicate?router('n2','A'):''}${local?target(value):''}</graph><appSettings/></showkontrol>`;
  const input=`<skshow>${part('patch.skf',patch)}${part('content/test.sktl',`<sktimeline>${local?'':target(value)}</sktimeline>`)}</skshow>`;
  const source=path.join(dir,`in${i}`),destination=path.join(dir,`out${i}`);await writeFile(source,input);const {sha256}=await inspectPatch({file:source,format:'skshow'});
  const op=()=>editPatchGraphCopy({source,destination,format:'skshow',sha256,operation:'remove_node',nodeId:'n1'});
  if(blocked){await assert.rejects(op(),/router target reference/);await assert.rejects(readFile(destination),{code:'ENOENT'});}else await op();
  assert.equal(await readFile(source,'utf8'),input);
 }
});
test('standalone patch checks its own router targets',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'router-skf-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'in.skf'),destination=path.join(dir,'out.skf');
 const input=`<showkontrol version="2"><graph>${router('n1','A')}${target('A')}</graph><appSettings/></showkontrol>`;await writeFile(source,input);const {sha256}=await inspectPatch({file:source,format:'skf'});
 await assert.rejects(editPatchGraphCopy({source,destination,format:'skf',sha256,operation:'remove_node',nodeId:'n1'}),/router target reference/);await assert.rejects(readFile(destination),{code:'ENOENT'});assert.equal(await readFile(source,'utf8'),input);
});
test('router removal rejects nested targets, ambiguous names and malformed supported parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'router-edge-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const cases=[
  {name:'program',router:router('n1','A'),partName:'content/Program.skpr',body:'<skprogram><item><sktimeline><cue><graph><setting key="route.router_target">&#65;</setting></graph></cue></sktimeline></item></skprogram>',error:/router target reference/},
  {name:'nested',router:router('n1','A'),partName:'content/test.sksc',body:'<scene><setting key="route.router_target"><value><![CDATA[A]]></value></setting></scene>',error:/router target reference/},
  {name:'missing',router:'<node id="n1" type="router"><settings/></node>',partName:'content/test.sktl',body:'<sktimeline/>',error:/name is missing or ambiguous/},
  {name:'duplicate',router:'<node id="n1" type="router"><settings><setting key="router.name">A</setting><setting key="router.name">B</setting></settings></node>',partName:'content/test.sktl',body:'<sktimeline/>',error:/name is missing or ambiguous/},
  {name:'malformed',router:router('n1','A'),partName:'content/test.sksc',body:'<scene><setting key="route.router_target">A</scene>',error:/unexpected close tag|unclosed tag/i},
 ];
 for(const item of cases){
  const patch=`<showkontrol version="2"><graph>${item.router}</graph><appSettings/></showkontrol>`;
  const input=`<skshow>${part('patch.skf',patch)}${part(item.partName,item.body)}</skshow>`;
  const source=path.join(dir,`${item.name}.skshow`),destination=path.join(dir,`${item.name}-out.skshow`);await writeFile(source,input);
  const {sha256}=await inspectPatch({file:source,format:'skshow'});
  await assert.rejects(editPatchGraphCopy({source,destination,format:'skshow',sha256,operation:'remove_node',nodeId:'n1'}),item.error);
  await assert.rejects(readFile(destination),{code:'ENOENT'});assert.equal(await readFile(source,'utf8'),input);
 }
});
