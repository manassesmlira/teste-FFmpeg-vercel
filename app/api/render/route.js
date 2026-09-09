import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;

function extFor(file, fallback) {
  const original = file?.name || '';
  const ext = path.extname(original).toLowerCase();
  return ext && ext.length <= 6 ? ext : fallback;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg encerrou com código ${code}. ${stderr.slice(-3500)}`));
    });
  });
}

export async function POST(request) {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpsocial-'));
  try {
    if (!ffmpegPath) {
      return Response.json({ error: 'ffmpeg-static não encontrou um binário compatível.' }, { status: 500 });
    }

    const form = await request.formData();
    const image = form.get('image');
    const audio = form.get('audio');

    if (!(image instanceof File) || !(audio instanceof File)) {
      return Response.json({ error: 'Envie os campos image e audio.' }, { status: 400 });
    }

    if (image.size + audio.size > MAX_INPUT_BYTES) {
      return Response.json({ error: 'Imagem + áudio excedem 4 MB neste teste.' }, { status: 413 });
    }

    if (!String(image.type).startsWith('image/')) {
      return Response.json({ error: 'O primeiro arquivo precisa ser uma imagem.' }, { status: 400 });
    }
    if (!String(audio.type).startsWith('audio/')) {
      return Response.json({ error: 'O segundo arquivo precisa ser um áudio.' }, { status: 400 });
    }

    const imagePath = path.join(workdir, `image${extFor(image, '.jpg')}`);
    const audioPath = path.join(workdir, `audio${extFor(audio, '.mp3')}`);
    const outputPath = path.join(workdir, 'reel.mp4');

    await fs.writeFile(imagePath, Buffer.from(await image.arrayBuffer()));
    await fs.writeFile(audioPath, Buffer.from(await audio.arrayBuffer()));

    const filter = [
      '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:8[bg]',
      '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg]',
      '[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]'
    ].join(';');

    await runFfmpeg([
      '-hide_banner',
      '-loglevel', 'error',
      '-loop', '1',
      '-framerate', '30',
      '-i', imagePath,
      '-i', audioPath,
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'stillimage',
      '-crf', '28',
      '-r', '30',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ar', '44100',
      '-movflags', '+faststart',
      '-shortest',
      '-y', outputPath
    ]);

    const output = await fs.readFile(outputPath);
    if (output.byteLength > 4.3 * 1024 * 1024) {
      return Response.json({
        error: 'O vídeo foi gerado, mas ficou grande demais para ser devolvido diretamente pela Function da Vercel.',
        details: `Tamanho aproximado: ${(output.byteLength / 1024 / 1024).toFixed(2)} MB. O próximo passo seria salvar em Blob/storage.`
      }, { status: 507 });
    }

    return new Response(output, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'attachment; filename="cp-social-reel-teste.mp4"',
        'Cache-Control': 'no-store',
        'X-CP-Social-Renderer': 'ffmpeg-static'
      }
    });
  } catch (error) {
    console.error(error);
    return Response.json({
      error: 'Falha ao renderizar o vídeo.',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
