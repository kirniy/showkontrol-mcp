import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {validateShow} from './validate-show.js';

const part=(name,xml)=>`<part name="${name}" md5="${createHash('md5').update(xml).digest('hex')}">${Buffer.from(xml).toString('base64')}</part>`;
const router=(id,name)=>`<node id="${id}" type="router"><settings><setting key="router.name">${name}</setting></settings></node>`;
const setting=value=>`<setting key="route.router_target">${value}</setting>`;
const graph=(id,content,type='action')=>`<graph><node id="${id}" type="${type}">${content}</node></graph>`;

test('checks Program item and embedded cue router targets with their own scopes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-router-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow');
 const patch=`<showkontrol version="2"><graph>${router('n91','A')}${router('n92','B')}${router('n93','B')}</graph><appSettings/></showkontrol>`;
 const program=`<skprogram version="1"><item start="0" name="Item" notes="">${graph('n1',`<settings>${setting('&#65;')}</settings>`)}</item><item start="0" name="Item" notes="">${graph('n2',`<settings>${setting('Missing')}</settings>`)}<sktimeline version="1"><cue id="first"/><cue id="second">${graph('n3',`<settings>${setting('<![CDATA[B]]>')}</settings>`)}</cue></sktimeline></item></skprogram>`;
 await writeFile(file,`<skshow>${part('patch.skf',patch)}${part('content/Program.skpr',program)}</skshow>`);
 const result=await validateShow({file});const targets=result.diagnostics.filter(d=>d.code.endsWith('_router_target'))
 assert.deepEqual(targets.map(d=>d.code),['missing_router_target','ambiguous_router_target']);
 assert.deepEqual(targets.map(d=>d.scope),[
  {part:'content/Program.skpr',path:'skprogram/item/graph',itemIndex:1,nodeId:'n2'},
  {part:'content/Program.skpr',itemIndex:1,path:'skprogram/item/sktimeline/cue/graph',cueIndex:1,cueId:'second',nodeId:'n3'}
 ]);
 assert.equal(result.coverage.find(c=>c.part==='content/Program.skpr').status,'partial');
 assert.ok(result.diagnostics.some(d=>d.code==='unverified_program_semantics'));
 assert.match(result.note,/compatibility is not validated/);
});

test('rejects duplicate and misplaced Program targets and ignores unsupported graph paths',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-router-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const patch=`<showkontrol version="2"><graph>${router('n91','A')}</graph><appSettings/></showkontrol>`;
 const program=`<skprogram version="1"><item start="0" name="Item" notes="">${graph('n1',`<settings>${setting('A')}${setting('A')}</settings>`)}<sktimeline version="1"><cue id="c">${graph('n2',setting('A'))}</cue><other>${graph('n3',`<settings>${setting('Missing')}</settings>`)}</other></sktimeline></item></skprogram>`;
 await writeFile(file,`<skshow>${part('patch.skf',patch)}${part('content/Program.skpr',program)}</skshow>`);
 const result=await validateShow({file});const targets=result.diagnostics.filter(d=>d.code.endsWith('_router_target'))
 assert.deepEqual(targets.map(d=>d.code),['invalid_router_target','invalid_router_target','invalid_router_target']);
 assert.deepEqual(targets.map(d=>d.scope.nodeId),['n1','n1','n2']);
 assert.ok(result.diagnostics.some(d=>d.code==='unsupported_graph'&&d.scope.path.endsWith('/other/graph')));
});
