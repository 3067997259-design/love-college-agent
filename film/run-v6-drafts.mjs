import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const dest=String.raw`D:\love, college&agent\art\retouch\2026-10-17-film-v6-complete`;
const plan=JSON.parse(fs.readFileSync(path.join(dest,'plan.json'),'utf8'));
for(const j of plan.jobs){
 const target=path.join(dest,j.id+'-nai-v1.png');
 if(fs.existsSync(target)){console.log(j.id+' already saved');continue;}
 const r=spawnSync(process.execPath,['film/nai.mjs','gen',j.id],{encoding:'utf8',windowsHide:true,timeout:180000});
 if(r.status!==0){console.error(j.id+' failed: '+r.stderr);process.exit(1);}
 const records=fs.readFileSync('art/gen-log.jsonl','utf8').trim().split(/\r?\n/).map(JSON.parse);
 const record=records.findLast(x=>x.frame===j.id);
 if(!record)throw new Error('Missing generation receipt '+j.id);
 fs.copyFileSync(path.join('film/gen',record.file),target);
 fs.writeFileSync(path.join(dest,j.id+'-nai-record.json'),JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({id:j.id,saved:target,seconds:record.seconds}));
}
