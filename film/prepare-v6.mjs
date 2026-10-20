import fs from 'node:fs';
import path from 'node:path';
const dest=String.raw`D:\love, college&agent\art\retouch\2026-10-17-film-v6-complete`;
const src=String.raw`D:\love, college&agent\art\retouch\2026-10-17-film-v5-nai\prompts-effective.json`;
const base=JSON.parse(fs.readFileSync(src,'utf8').replace(/^\uFEFF/,''));
const plan=JSON.parse(fs.readFileSync(path.join(dest,'plan.json'),'utf8'));
const active=path.resolve('film/prompts.json');
if(!fs.existsSync(path.join(dest,'prompts-before.json')))fs.copyFileSync(active,path.join(dest,'prompts-before.json'));
const existing=JSON.parse(fs.readFileSync(active,'utf8').replace(/^\uFEFF/,''));
const style=base.slots.style.replace('low contrast','gentle but readable contrast').replace('dreamy atmospheric glow','restrained atmospheric light, preserved highlight detail');
const indoor='cream knit cardigan, white blouse with small rounded collar, pale lavender long skirt';
for(const j of plan.jobs){
 const human=!['scenery','hands'].includes(j.type);
 const room=j.type.startsWith('indoor')||j.type==='outdoorRoom';
 const parts=[style];
 if(human) parts.push(base.slots.character.replace('young adult woman','young college-age adult woman, approximately twenty'),j.type.startsWith('indoor')?indoor:base.slots.outfitOut);
 if(room)parts.push('cozy student room, teal painted wooden window frame behind her, ivory curtains, wooden desk, subdued books and white ceramic mug, consistent interior layout');
 parts.push(j.scene,j.type==='night'?'deep blue night, soft cool moonlight, moderate dark exposure':room?'soft warm daylight, controlled highlights':'soft pastel light, readable middle tones',base.slots.quality);
 const negative=human?base.slots.negative.replace('high angle, top-down view, ',''):base.slots.negativeScenery.replace('people, 1girl, person, ','');
 existing.frames[j.id]={shot:j.title,size:'landscape',prompt:parts.join(', '),negative,seed:271900+j.index};
}
existing.params=base.params;
existing.sizes=base.sizes;
fs.writeFileSync(active,JSON.stringify(existing,null,2)+'\n');
fs.writeFileSync(path.join(dest,'prompts-effective.json'),JSON.stringify({...existing,frames:Object.fromEntries(plan.jobs.map(j=>[j.id,existing.frames[j.id]]))},null,2)+'\n');
console.log(JSON.stringify({prepared:plan.jobs.length}));
