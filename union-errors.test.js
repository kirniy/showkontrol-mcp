import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {unionFormError} from './union-errors.js';

test('an object union reports the issues of the one form that accepts the keys',()=>{
 const action=z.discriminatedUnion('action',[z.object({action:z.literal('add'),start:z.number()}).strict(),z.object({action:z.literal('remove'),index:z.number()}).strict()]);
 const form=z.union([z.object({items:z.array(z.number())}).strict(),z.object({operations:z.array(action)}).strict()],{error:unionFormError});
 const message=value=>form.safeParse(value).error.issues.map(issue=>issue.message);
 assert.deepEqual(message({operations:[{action:'add_item'}]}),["Invalid discriminator value. Expected 'add' | 'remove' (at operations.0.action)"]);
 assert.deepEqual(message({items:['x',2,'y']}),['Invalid input: expected number, received string (at items.0); Invalid input: expected number, received string (at items.2)']);
 // No form, or more than one form, accepts the keys: zod's own message stays.
 assert.deepEqual(message({other:1}),['Invalid input']);
 assert.deepEqual(message({items:[],operations:[]}),['Invalid input']);
 const loose=z.union([z.object({a:z.number()}),z.object({b:z.number()})],{error:unionFormError});
 assert.deepEqual(loose.safeParse({}).error.issues.map(issue=>issue.message),['Invalid input']);
 const scalar=z.union([z.string(),z.number()],{error:unionFormError});
 assert.deepEqual(scalar.safeParse(true).error.issues.map(issue=>issue.message),['Invalid input']);
});

test('MCP validation errors name the failing Program operation fields',async t=>{
 const client=new Client({name:'union-errors-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env,stderr:'ignore'}));t.after(()=>client.close());
 const base={source:'/nonexistent/in.skshow',destination:'/nonexistent/out.skshow',sha256:'0'.repeat(64)};
 const text=async(name,args)=>{const response=await client.callTool({name,arguments:{...base,...args}});assert.equal(response.isError,true);return response.content[0].text;};
 const wrongAction=await text('showkontrol_compose_full_show_copy',{program:{operations:[{action:'add_item'}]}});
 assert.match(wrongAction,/Invalid discriminator value\. Expected 'add' \| 'edit' \| 'remove' \|.*\(at operations\.0\.action\) at program$/s);
 const missing=await text('showkontrol_compose_full_show_copy',{program:{items:[{start:'x'}]}});
 assert.match(missing,/expected number, received string \(at items\.0\.start\); Invalid input: expected string, received undefined \(at items\.0\.name\)/);
 assert.match(await text('showkontrol_compose_full_show_copy',{program:{bogus:1}}),/: Invalid input at program$/);
 const session=await text('showkontrol_compose_session_media_copy',{program:{operations:[{action:'nope'}]}});
 assert.match(session,/Invalid discriminator value\. Expected 'add' \|.*\(at operations\.0\.action\) at program/s);
});
