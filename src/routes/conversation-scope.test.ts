import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('objective and project turns share admission, stopping, and canonical history', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-chat-scope-'));
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import fs from 'node:fs';
    import path from 'node:path';
    const root = process.cwd();
    const db = await import(root + '/src/db.ts');
    const runner = await import(root + '/src/agent-runner.ts');
    const state = await import(root + '/src/state-manager.ts');
    const runtime = await import(root + '/src/lib/chat-agents.ts');
    const transcripts = await import(root + '/src/group-dir.ts');
    const store = await import(root + '/src/modules/transcripts/transcript-store.ts');
    const { default: chatRouter } = await import(root + '/src/routes/conversations.ts');
    const ws = await import(root + '/src/modules/objectives/ws-events.ts');
    await db.initDatabase(':memory:');
    const { drizzleDbRef } = await import(root + '/src/db/drizzle-client.ts');
    const handle = drizzleDbRef.current;
    const client = handle.$client ?? handle._?.client ?? handle.session?.client;
    const project = 'scope-test';
    await client.exec("INSERT INTO users (id,username,password_hash,role,created_at,disabled) VALUES ('owner','owner','hash','admin','2026-09-10T00:00:00.000Z',0)");
    await client.exec("INSERT INTO projects (id,jid,name,folder,trigger,added_at,settings,is_main,user_id) VALUES ('scope-test','scope-test@web','Scope','scope-test','!','2026-09-10T00:00:00.000Z','{}',0,'owner')");
    await state.loadState();
    const agent = { id:'scope-cli',label:'Scope CLI',harnessId:'codex',harnessKind:'cli',modelId:'default',agentCmd:'scope-cli',sessionFamily:'scope-cli' };
    runtime.getChatAgents().push(agent);
    const objective = await db.createObjective({ project_id:project,title:'Scoped objective',description:'Scoped work',status:'active',priority:0 });
    // Objective turns require a brain-initialised folder (state.json); this test has no brain, so seed one.
    const objectiveDir = path.join(transcripts.getGroupDir(project),'objectives',objective.id);
    fs.mkdirSync(objectiveDir,{recursive:true});
    fs.writeFileSync(path.join(objectiveDir,'state.json'),'{}');
    const objectiveConversation = await db.createObjectiveConversation(project, objective.id, { ownerUserId:'owner' });
    const normalConversation = await db.createConversation(project, { ownerUserId:'owner' });
    const launches = [];
    let releaseRun;
    runner.setContainerAgentRunnerForTests(async (_group, input, onChunk) => {
      launches.push(input);
      transcripts.appendChatTranscriptEntry(project, input.conversation_id, {type:'message',role:'assistant',content:'First progress paragraph.\n\n'});
      onChunk?.({ type:'text',content:'First progress paragraph.\n\n' });
      if (input.prompt.includes('Hold this turn')) await new Promise(resolve => { releaseRun = resolve; });
      transcripts.appendChatTranscriptEntry(project, input.conversation_id, {type:'message',role:'assistant',content:'Final progress paragraph.'});
      onChunk?.({type:'text',content:'Final progress paragraph.'});
      return {status:'success',result:'Final progress paragraph.',duration:1,newSessionId:'scope-session',stoppedByUser:input.prompt.includes('Hold this turn'),tok_output:20};
    });
    const invoke = (router, method, url, body) => new Promise((resolve,reject) => {
      class Response extends EventEmitter {
        statusCode=200;
        headers={};
        setHeader(key,value) { this.headers[key]=value; return this; }
        getHeader(key) { return this.headers[key]; }
        status(code) { this.statusCode=code; return this; }
        json(value) { this.emit('finish'); resolve({status:this.statusCode,body:value}); return this; }
        send(value) { return this.json(value); }
      }
      const res = new Response();
      const req = {method,url,originalUrl:url,body,query:{},headers:{},params:{},authUser:{id:'owner',username:'owner',role:'admin'},get(name){return this.headers[name.toLowerCase()];}};
      router.handle(req,res,error => reject(error || new Error('Route not handled: '+url)));
    });
    const until = async predicate => {
      const deadline = Date.now()+10000;
      while (!(await predicate())) {
        if (Date.now()>deadline) throw new Error('Timed out waiting for turn lifecycle');
        await new Promise(resolve=>setTimeout(resolve,5));
      }
    };
    const body = (id,content) => ({conversation_id:id,content,agent_cmd:agent.id});
    const first = await invoke(chatRouter,'POST','/projects/'+project+'/messages',body(objectiveConversation.id,'Hold this turn'));
    assert.equal(first.status,202,JSON.stringify(first.body));
    await until(()=>releaseRun);
    assert.equal(launches[0].work_dir, '/workspace/group/objectives/'+objective.id);
    const otherObjective = await db.createObjective({ project_id:project,title:'Other objective',description:'',status:'active',priority:0 });
    const wrong = await invoke(chatRouter,'POST','/projects/'+project+'/messages',{...body(objectiveConversation.id,'Wrong scope'),objective_id:otherObjective.id});
    assert.equal(wrong.status,404);
    const wrongNormal = await invoke(chatRouter,'POST','/projects/'+project+'/messages',{...body(normalConversation.id,'Wrong scope'),objective_id:objective.id});
    assert.equal(wrongNormal.status,404);
    const stop = await invoke(chatRouter,'POST','/projects/'+project+'/messages/stop',{conversation_id:objectiveConversation.id});
    assert.equal(stop.body.stopped,true);
    releaseRun();
    await until(()=>!ws.getActiveStreamKeyForConv(objectiveConversation.id));
    const second = await invoke(chatRouter,'POST','/projects/'+project+'/messages',body(normalConversation.id,'Normal turn'));
    assert.equal(second.status,202);
    await until(()=>launches.length===2 && !ws.getActiveStreamKeyForConv(normalConversation.id));
    assert.equal(launches[1].work_dir, undefined);
    for (const conversation of [objectiveConversation,normalConversation]) {
      const response = await invoke(chatRouter,'GET','/projects/'+project+'/conversations/'+conversation.id+'/transcript',{});
      assert.equal(response.status,200);
      const prose = response.body.entries.filter(e=>e.type==='message' && e.role==='assistant').map(e=>e.content).join('');
      assert.ok(prose.includes('First progress paragraph.'));
      assert.equal(prose.split('Final progress paragraph.').length,2);
      const rows = transcripts.readChatTranscript(project,conversation.id);
      assert.equal(rows.filter(e=>e.type==='turn_outcome').length,1);
    }
    assert.equal(fs.existsSync(path.join(transcripts.getGroupDir(project),'objectives',objective.id,'transcripts',objectiveConversation.id+'.jsonl')),false);
    console.log('SCOPE_PIPELINE_OK');
    process.exit(0);
  `;
  try {
    const result = spawnSync(
      process.execPath,
      ['--no-env-file', '-e', script],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          CARAPA_DATA_DIR: dataDir,
          // The child runs with `bun -e`, so it does not load test-preload.ts.
          ENABLE_OBJECTIVES: 'true',
          DATABASE_URL: '',
          DB_HOST: '',
          DB_PASSWORD: '',
          POSTGRES_PASSWORD: '',
          LOG_LEVEL: 'silent',
        },
        encoding: 'utf8',
        timeout: 90_000,
      },
    );
    if (result.status !== 0)
      throw new Error(result.stderr || result.stdout || String(result.error));
    expect(result.stdout).toContain('SCOPE_PIPELINE_OK');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 100_000);
