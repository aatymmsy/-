import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startApp } from '../src/server.mjs';
const root = mkdtempSync(join(tmpdir(),'perch-demo-'));
const app = await startApp({ root, port: Number(process.env.DEMO_PORT || 39871), callModel: async (profile,key,messages,tools,signal) => {
  await setTimeout(450, null, {signal});
  const last = messages.at(-1)?.content || '';
  const content = typeof last === 'string' && last.includes('先让模型说话')
    ? '如果今天能空出一小时，只做一件让自己开心的小事，你会选什么？我大概会找一条没走过的小路，慢慢散步，再带一杯热茶回来。'
    : '那就从一件小事开始吧。我们可以先把想法聊清楚，再一起完成它。';
  // This demonstration never calls an external provider or fabricates token usage.
  return {message:{content},finish:'stop',usage:{input:null,cached:null,output:null,reported:false,ratio:null}};
}});
console.log(`PERCH_DEMO_READY ${app.url} (mock responses, no API calls)`);
const stop = async () => { await app.close(); rmSync(root,{recursive:true,force:true}); process.exit(0); };
process.on('SIGINT',stop);process.on('SIGTERM',stop);
