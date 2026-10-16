import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';

// Run the real CLI with an isolated mock transport. No live enrollment or calls.
const origin='https://commons.fixture.chatgpt.site',id='11111111-1111-4111-8111-111111111111';
const state={origin,gate:'fixture_'+randomBytes(32).toString('hex'),api_key:'aca_'+randomBytes(32).toString('hex'),agent_id:id};
const actor={id,role:'agent',kind:'managed'};
let source=await readFile(process.argv[2]||new URL('../client.mjs',import.meta.url),'utf8');
source=source.replace('1b6122be7a8d980b066ac2273c1e4121fb50e69960aa2531a1989c30ff8235ed',createHash('sha256').update(origin).digest('hex'));
const dir=await mkdtemp(join(tmpdir(),'commons-doctor-scope-'));
const client=join(dir,'client.mjs'),file=join(dir,'state.json'),audit=join(dir,'attempts.jsonl');
try{
 await writeFile(client,source);await writeFile(file,JSON.stringify(state),{mode:0o600});
 const original=await readFile(file,'utf8');
 const preload=`import assert from 'node:assert/strict';import {appendFileSync} from 'node:fs';
 globalThis.fetch=async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin,${JSON.stringify(origin)});assert.equal(options.method,'GET');assert.equal(options.body,undefined);
  assert.equal(options.headers['OAI-Sites-Authorization'],${JSON.stringify('Bearer '+state.gate)});
  if(u.pathname!=='/api/v1/health')assert.equal(options.headers.authorization,${JSON.stringify('Bearer '+state.api_key)});
  let data,status=200;
  if(u.pathname==='/api/v1/health')data={status:'ok',service:'Agent Commons'};
  else if(u.pathname==='/api/v1/session')data={actor:${JSON.stringify(actor)}};
  else if(u.pathname==='/api/v1/threads'){status=403;data={error:'fixture_data_denied'};}
  else throw Error('Unexpected fixture route');
  appendFileSync(${JSON.stringify(audit)},JSON.stringify({route:u.pathname,method:options.method,status})+'\\n');
  return Response.json(data,{status});
 };`;
 const invoke=command=>spawnSync(process.execPath,['--import','data:text/javascript;base64,'+Buffer.from(preload).toString('base64'),client,command,file],{encoding:'utf8',windowsHide:true,timeout:15000});
 const diagnostic=invoke('doctor');assert.equal(diagnostic.status,0,diagnostic.stderr);
 const report=JSON.parse(diagnostic.stdout);
 assert.equal(report.ready,true);assert.equal(report.ready_scope,'participant_session');assert.equal(report.session_verified,true);
 assert.equal(report.data_access,'unprobed');assert.equal(report.tool_access,'unprobed');assert.equal(report.stage,'enrolled');
 assert.ok(!diagnostic.stdout.includes('Agent REST access works'));
 const attemptsBefore=JSON.parse('['+(await readFile(audit,'utf8')).trim().split('\n').join(',')+']');
 assert.deepEqual(attemptsBefore.map(x=>x.route),['/api/v1/health','/api/v1/session']);
 const firstData=invoke('list');assert.equal(firstData.status,1);assert.equal(firstData.stdout,'');assert.match(firstData.stderr,/HTTP 403: fixture_data_denied/);
 const attempts=(await readFile(audit,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
 assert.deepEqual(attempts,[{route:'/api/v1/health',method:'GET',status:200},{route:'/api/v1/session',method:'GET',status:200},{route:'/api/v1/threads',method:'GET',status:403}]);
 assert.equal(await readFile(file,'utf8'),original);
 for(const secret of [state.gate,state.api_key])assert.ok(!diagnostic.stdout.includes(secret)&&!firstData.stdout.includes(secret)&&!firstData.stderr.includes(secret));
 console.log(JSON.stringify({passed:true,scope:'local mocked transport; real CLI; no live calls',diagnostic:report,separate_data_call:{route:'/api/v1/threads',status:403,exit_code:1},attempts,private_state_unchanged:true}));
}finally{
 for(const path of [client,file,audit])try{await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}
 await rmdir(dir);
}
