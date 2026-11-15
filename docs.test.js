import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,access} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const files=async()=>['README.md','CONTRIBUTING.md',...(await readdir('docs')).filter(name=>name.endsWith('.md')).map(name=>path.join('docs',name))];
const prose=text=>text.replace(/^```[\s\S]*?^```/gm,'');
// GitHub heading anchors: lower case, punctuation removed, spaces to hyphens, -1, -2 for repeats.
function anchors(text){
 const seen=new Map(),out=new Set();
 for(const [,heading] of prose(text).matchAll(/^#{1,6} (.+)$/gm)){
  const slug=heading.replace(/`/g,'').toLowerCase().replace(/[^\p{L}\p{N} _-]/gu,'').replace(/ /g,'-');
  const n=seen.get(slug)??0;seen.set(slug,n+1);out.add(n?`${slug}-${n}`:slug);
 }
 return out;
}

test('documentation links and heading anchors resolve',async()=>{
 const broken=[];
 for(const file of await files()){
  const text=await readFile(file,'utf8');
  for(const [,target] of prose(text).matchAll(/\]\(([^)\s]+)\)/g)){
   if(/^[a-z]+:/i.test(target))continue;
   const [link,anchor]=target.split('#');
   const resolved=link?path.join(path.dirname(file),decodeURIComponent(link)):file;
   try{await access(resolved);}catch{broken.push(`${file}: ${target} (missing file)`);continue;}
   if(anchor!==undefined&&!anchors(await readFile(resolved,'utf8')).has(anchor))broken.push(`${file}: ${target} (missing anchor)`);
  }
 }
 assert.deepEqual(broken,[]);
});

test('tool index matches the registered tools and their annotations',async t=>{
 const client=new Client({name:'docs-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));
 t.after(()=>client.close());
 const {tools}=await client.listTools();
 const index=await readFile('docs/tools.md','utf8');
 const rows=[...index.matchAll(/^\| `(showkontrol_[a-z0-9_]+)` \| ([a-z ]+) \|/gm)].map(([,name,effect])=>({name,effect}));
 assert.deepEqual(rows.map(row=>row.name).sort(),tools.map(tool=>tool.name).sort());
 assert.match(index,new RegExp(`provides ${tools.length} tools`));
 const expected={'live read':[true,false],'read':[true,false],'new copy':[false,false],'live write':[false,true],'deletes':[false,true]};
 for(const {name,effect} of rows){
  const {annotations}=tools.find(tool=>tool.name===name);
  assert.ok(expected[effect],`${name}: unknown effect ${effect}`);
  assert.deepEqual([annotations.readOnlyHint,annotations.destructiveHint],expected[effect],`${name}: ${effect}`);
 }
 const reference=await readFile('docs/reference.md','utf8');
 assert.deepEqual(rows.filter(({name})=>!reference.includes(`\`${name}\``)).map(row=>row.name),[]);
});
