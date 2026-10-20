// One explicitly requested application delta per invocation. Based on this project's film/nai.mjs.
import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url),JSZip=require('D:/lca-film-v4/node_modules/jszip');
const dir='D:/love, college&agent/art/retouch/2026-10-18-face-deltas';
const j=JSON.parse(readFileSync(path.join(dir,'plan.json'),'utf8')).jobs.find(x=>x.id===process.argv[2]);
if(!j)throw Error('Pass one job id');
const dst=path.join(dir,j.id+'-nai-v1.png');if(existsSync(dst))throw Error('Already generated; do not overwrite');
function credential(){
 const text=readFileSync(process.env.LCA_NAI_SECRET??'D:/love, college&agent/secrets/novelai.json','utf8').trim(),strings=[];
 const walk=v=>{if(typeof v==='string')strings.push(v.trim());else if(v&&typeof v==='object')for(const x of Object.values(v))walk(x)};
 try{walk(JSON.parse(text))}catch{strings.push(text)}
 const bare=v=>v.replace(/^Bearer\s+/i,''),token=strings.map(bare).find(x=>x.startsWith('pst-'))??(strings.filter(x=>bare(x).length>=32).length===1?bare(strings.find(x=>bare(x).length>=32)):undefined);
 if(!token)throw Error('NovelAI credential not available');return 'Bearer '+token;
}
const prompt='anime illustration, delicate thin colored lineart, flat warm pastel colors, one soft lavender shadow tone, same young adult woman and exact same facial identity as input, same camera and pose, no style change, '+j.action+', clean restrained natural expression, preserve all non-target details';
const negative='lowres, bad anatomy, bad hands, extra arms, extra hands, duplicated limbs, extra fingers, three hands, different person, different face, different hairstyle, different pose, mature face, child, chibi, huge eyes, blush, nose highlight, tears, grimace, photorealistic, 3d, thick black outlines, text, watermark, signature, harsh shadows, overexposure'+(j.kind==='blink'?', open eyes, visible iris, crescent happy eyes, sleeping':'')+(j.kind.startsWith('mouth')?', exaggerated open mouth, laughing, big smile, visible teeth':'');
const strength=j.kind.startsWith('night')?.31:j.kind==='blink'?.32:.26;
const input=readFileSync(j.naiInput);
const parameters={params_version:3,width:j.naiSize[0],height:j.naiSize[1],scale:5,sampler:'k_euler_ancestral',steps:23,seed:j.seed,n_samples:1,ucPreset:0,qualityToggle:false,noise_schedule:'karras',cfg_rescale:0,sm:false,sm_dyn:false,dynamic_thresholding:false,legacy:false,add_original_image:true,deliberate_euler_ancestral_bug:false,prefer_brownian:true,negative_prompt:negative,image:input.toString('base64'),strength,noise:.02,extra_noise_seed:j.seed,
v4_prompt:{caption:{base_caption:prompt,char_captions:[]},use_coords:false,use_order:true},v4_negative_prompt:{caption:{base_caption:negative,char_captions:[]},legacy_uc:false}};
const started=performance.now();
const response=await fetch('https://image.novelai.net/ai/generate-image',{method:'POST',headers:{Authorization:credential(),'Content-Type':'application/json',Accept:'application/zip'},body:JSON.stringify({input:prompt,model:'nai-diffusion-5-full',action:'img2img',parameters}),signal:AbortSignal.timeout(180000)});
if(!response.ok)throw Error('NovelAI HTTP '+response.status);
const zip=await JSZip.loadAsync(Buffer.from(await response.arrayBuffer())),name=Object.keys(zip.files).find(x=>x.endsWith('.png'));if(!name)throw Error('No PNG');
const png=await zip.file(name).async('nodebuffer');writeFileSync(dst,png);
const sha=b=>createHash('sha256').update(b).digest('hex');
const record={id:j.id,tool:'NovelAI image-to-image',model:'nai-diffusion-5-full',seed:j.seed,source:j.base,source_sha256:j.baseSha256,workingCrop:j.roi,input:j.naiInput,input_sha256:sha(input),width:j.naiSize[0],height:j.naiSize[1],strength,noise:.02,steps:23,scale:5,prompt,negative,output:dst,sha256:sha(png),seconds:Math.round((performance.now()-started)/100)/10};
writeFileSync(path.join(dir,j.id+'-nai-record.json'),JSON.stringify(record,null,2)+'\n');appendFileSync('D:/lca-film-v4/art/gen-log.jsonl',JSON.stringify(record)+'\n');
console.log(JSON.stringify({id:j.id,seconds:record.seconds,output:dst}));

