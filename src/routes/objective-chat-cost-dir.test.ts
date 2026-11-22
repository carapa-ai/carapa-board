import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('objective chat completion persists cost metrics under the host objective dir', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-chat-cost-'));
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
    const { getObjectiveDir } = await import(root + '/src/modules/objectives/objective-folder.ts');
    const { logger } = await import(root + '/src/logger.ts');
    const { default: conversationRouter } = await import(root + '/src/routes/conversations.ts');
    const ws = await import(root + '/src/modules/objectives/ws-events.ts');
    await db.initDatabase(':memory:');
    const { drizzleDbRef } = await import(root + '/src/db/drizzle-client.ts');
    const client = drizzleDbRef.current.$client;
    const project = 'cost-dir-test';
    await client.exec("INSERT INTO users (id,username,password_hash,role,created_at,disabled) VALUES ('owner','owner','hash','admin','2026-09-10T00:00:00.000Z',0)");
    await client.exec("INSERT INTO projects (id,jid,name,folder,trigger,added_at,settings,is_main,user_id) VALUES ('cost-dir-test','cost-dir-test@web','Cost','cost-dir-test','!','2026-09-10T00:00:00.000Z','{}',0,'owner')");
    await state.loadState();
    const agent = { id:'cost-cli',label:'Cost CLI',harnessId:'codex',harnessKind:'cli',modelId:'default',agentCmd:'cost-cli',sessionFamily:'cost-cli' };
    runtime.getChatAgents().push(agent);
    const objective = await db.createObjective({ project_id:project,title:'Cost objective',description:'',status:'active',priority:0 });
    // Container-side path that does not exist on the host.
    await db.updateObjective(objective.id, { work_dir: '/workspace/group/objectives/' + objective.id });
    fs.mkdirSync(getObjectiveDir(project, objective.id), { recursive: true });
    const conversation = await db.createObjectiveConversation(project, objective.id, { ownerUserId:'owner' });
    const warnings = [];
    const originalWarn = logger.warn.bind(logger);
    logger.warn = (...args) => { warnings.push(args); return originalWarn(...args); };
    runner.setContainerAgentRunnerForTests(async () => ({status:'success',result:'done',duration:1,newSessionId:'cost-session'}));
    const res = await new Promise((resolve,reject) => {
      class Response extends EventEmitter {
        statusCode=200; headers={};
        setHeader(k,v) { this.headers[k]=v; return this; }
        getHeader(k) { return this.headers[k]; }
        status(code) { this.statusCode=code; return this; }
        json(value) { this.emit('finish'); resolve({status:this.statusCode,body:value}); return this; }
        send(value) { return this.json(value); }
      }
      const url = '/projects/'+project+'/messages';
      const req = {method:'POST',url,originalUrl:url,body:{conversation_id:conversation.id,content:'hi',agent_cmd:agent.id},query:{},headers:{},params:{},authUser:{id:'owner',username:'owner',role:'admin'},get(n){return this.headers[n.toLowerCase()];}};
      conversationRouter.handle(req,new Response(),e => reject(e || new Error('Route not handled')));
    });
    assert.equal(res.status,202,JSON.stringify(res.body));
    const metricsPath = path.join(getObjectiveDir(project, objective.id), 'board-cost-metrics.json');
    const deadline = Date.now()+10000;
    while (!fs.existsSync(metricsPath) || ws.getActiveStreamKeyForConv(conversation.id)) {
      if (Date.now()>deadline) throw new Error('Timed out waiting for cost metrics');
      await new Promise(r=>setTimeout(r,5));
    }
    assert.equal(warnings.filter(a => a[1] === 'Failed to persist objective cost total').length, 0);
    console.log('COST_DIR_OK');
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
    expect(result.stdout).toContain('COST_DIR_OK');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 100_000);
