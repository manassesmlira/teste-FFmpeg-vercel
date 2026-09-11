import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';
import dns from 'dns/promises';
import { spawn } from 'child_process';
import ffmpegStaticPath from 'ffmpeg-static';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAX_FORM_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_BYTES = 30 * 1024 * 1024;

function extFor(file, fallback) { const ext = path.extname(file?.name || '').toLowerCase(); return ext && ext.length <= 6 ? ext : fallback; }
function runFfmpeg(binary,args){return new Promise((resolve,reject)=>{const c=spawn(binary,args,{stdio:['ignore','ignore','pipe']});let e='';c.stderr.on('data',x=>{e+=x.toString();if(e.length>14000)e=e.slice(-14000)});c.on('error',reject);c.on('close',code=>code===0?resolve():reject(new Error(`FFmpeg encerrou com código ${code}. ${e.slice(-4000)}`)));});}
async function resolveFfmpegPath(){const c=[ffmpegStaticPath,path.join(process.cwd(),'node_modules','ffmpeg-static','ffmpeg'),path.join(process.cwd(),'node_modules','ffmpeg-static','ffmpeg.exe')].filter(Boolean);for(const x of c){try{await fs.access(x,fsConstants.X_OK);return x}catch{}}for(const x of c){try{await fs.access(x,fsConstants.F_OK);const t=path.join(os.tmpdir(),'cp-social-ffmpeg');await fs.copyFile(x,t);await fs.chmod(t,0o755);return t}catch{}}throw new Error(`FFmpeg não encontrado: ${c.join(' | ')}`);}
function isPrivateIp(ip){return /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^::1$|^fc|^fd/i.test(ip)||(/^172\.(\d+)\./.test(ip)&&Number(ip.match(/^172\.(\d+)\./)[1])>=16&&Number(ip.match(/^172\.(\d+)\./)[1])<=31);}
async function assertPublicUrl(raw){const u=new URL(raw);if(!['http:','https:'].includes(u.protocol))throw new Error('URL remota inválida.');if(['localhost','127.0.0.1','::1'].includes(u.hostname))throw new Error('Host remoto não permitido.');const results=await dns.lookup(u.hostname,{all:true});if(!results.length||results.some(r=>isPrivateIp(r.address)))throw new Error('Host remoto privado não permitido.');return u;}
async function downloadTo(raw,dest){const u=await assertPublicUrl(raw);const r=await fetch(u,{redirect:'follow'});if(!r.ok)throw new Error(`Falha ao baixar mídia remota (${r.status}).`);const len=Number(r.headers.get('content-length')||0);if(len>MAX_REMOTE_BYTES)throw new Error('Mídia remota excede 30 MB.');const b=Buffer.from(await r.arrayBuffer());if(b.length>MAX_REMOTE_BYTES)throw new Error('Mídia remota excede 30 MB.');await fs.writeFile(dest,b);return dest;}
function wrapText(text,max){const words=String(text||'').replace(/\s+/g,' ').trim().split(' ').filter(Boolean);const lines=[];let line='';for(const w of words){const n=line?`${line} ${w}`:w;if(n.length>max&&line){lines.push(line);line=w}else line=n;}if(line)lines.push(line);return lines.join('\n');}

export async function POST(request){
  const workdir=await fs.mkdtemp(path.join(os.tmpdir(),'cpsocial-'));
  try{
    const ffmpeg=await resolveFfmpegPath();const form=await request.formData();const mode=String(form.get('mode')||'image_audio');const out=path.join(workdir,'reel.mp4');
    if(mode==='video_overlay'){
      const videoUrl=String(form.get('video_url')||'');if(!videoUrl)return Response.json({error:'Informe video_url.'},{status:400});
      const videoPath=path.join(workdir,'.video.mp4');await downloadTo(videoUrl,videoPath);
      let audioPath='';const audioUrl=String(form.get('audio_url')||'');const audio=form.get('audio');
      if(audioUrl){audioPath=path.join(workdir,'.audio.mp3');await downloadTo(audioUrl,audioPath);}else if(audio instanceof File){if(audio.size>MAX_FORM_BYTES)return Response.json({error:'Áudio excede 4 MB.'},{status:413});audioPath=path.join(workdir,`audio${extFor(audio,'.webm')}`);await fs.writeFile(audioPath,Buffer.from(await audio.arrayBuffer()));}
      let overlay={};try{overlay=JSON.parse(String(form.get('overlay')||'{}'))||{}}catch{}
      const fit=['crop','blur','contain'].includes(String(form.get('fit_mode')||''))?String(form.get('fit_mode')):'crop';
      const title=wrapText(overlay.title||'',24),body=wrapText(overlay.text||'',34);const titleFile=path.join(workdir,'title.txt'),bodyFile=path.join(workdir,'body.txt');await fs.writeFile(titleFile,title);await fs.writeFile(bodyFile,body);
      let base='';if(fit==='blur')base='[0:v]split=2[bgsrc][fgsrc];[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=18:6[bg];[fgsrc]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[base]';
      else if(fit==='contain')base='[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[base]';
      else base='[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[base]';
      const dark=overlay.dark!==false?',drawbox=x=0:y=0:w=iw:h=ih:color=black@0.34:t=fill':'';
      const pos=overlay.position==='top'?'260':overlay.position==='bottom'?'h-text_h-320':'(h-text_h)/2';
      let chain=`${base};[base]${dark}`;let current='base2';chain+=`format=yuv420p[${current}]`;
      if(title){chain+=`;[${current}]drawtext=font='Sans':textfile='${titleFile}':fontcolor=white:fontsize=72:line_spacing=14:x=(w-text_w)/2:y=${pos}:shadowcolor=black@0.6:shadowx=3:shadowy=3[t1]`;current='t1';}
      if(body){const by=title?`${pos}+${Math.max(150,title.split('\n').length*92)}`:pos;chain+=`;[${current}]drawtext=font='Sans':textfile='${bodyFile}':fontcolor=white:fontsize=48:line_spacing=12:x=(w-text_w)/2:y=${by}:shadowcolor=black@0.6:shadowx=2:shadowy=2[v]`;current='v';}
      if(current!=='v')chain+=`;[${current}]null[v]`;
      const args=['-hide_banner','-loglevel','error','-i',videoPath];if(audioPath)args.push('-i',audioPath);args.push('-filter_complex',chain,'-map','[v]');if(audioPath)args.push('-map','1:a:0','-c:a','aac','-b:a','96k','-ar','44100');args.push('-c:v','libx264','-preset','ultrafast','-crf','29','-r','24','-pix_fmt','yuv420p','-movflags','+faststart','-t','30');if(audioPath)args.push('-shortest');args.push('-y',out);await runFfmpeg(ffmpeg,args);
    }else{
      const image=form.get('image'),audio=form.get('audio');if(!(image instanceof File)||!(audio instanceof File))return Response.json({error:'Envie image e audio.'},{status:400});if(image.size+audio.size>MAX_FORM_BYTES)return Response.json({error:'Imagem + áudio excedem 4 MB.'},{status:413});
      const imagePath=path.join(workdir,`image${extFor(image,'.jpg')}`),audioPath=path.join(workdir,`audio${extFor(audio,'.mp3')}`),prepared=path.join(workdir,'prepared.jpg');await fs.writeFile(imagePath,Buffer.from(await image.arrayBuffer()));await fs.writeFile(audioPath,Buffer.from(await audio.arrayBuffer()));
      const prep='[0:v]split=2[bgsrc][fgsrc];[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=18:6[bg];[fgsrc]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[out]';
      await runFfmpeg(ffmpeg,['-hide_banner','-loglevel','error','-i',imagePath,'-filter_complex',prep,'-map','[out]','-frames:v','1','-q:v','3','-y',prepared]);
      await runFfmpeg(ffmpeg,['-hide_banner','-loglevel','error','-loop','1','-framerate','24','-i',prepared,'-i',audioPath,'-c:v','libx264','-preset','ultrafast','-tune','stillimage','-crf','27','-r','24','-c:a','aac','-b:a','96k','-ar','44100','-pix_fmt','yuv420p','-movflags','+faststart','-shortest','-y',out]);
    }
    const output=await fs.readFile(out);if(output.byteLength>4.3*1024*1024)return Response.json({error:'O vídeo final excedeu o limite de resposta da Function.',details:`${(output.byteLength/1024/1024).toFixed(2)} MB`},{status:507});
    return new Response(output,{status:200,headers:{'Content-Type':'video/mp4','Content-Disposition':'attachment; filename="cp-social-reel.mp4"','Cache-Control':'no-store','X-CP-Social-Renderer':'1.1.0'}});
  }catch(error){console.error('[CP Social Render]',error);return Response.json({error:'Falha ao renderizar o vídeo.',details:error instanceof Error?error.message:String(error)},{status:500});}finally{await fs.rm(workdir,{recursive:true,force:true}).catch(()=>{});}
}
